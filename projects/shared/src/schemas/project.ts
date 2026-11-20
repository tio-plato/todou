import { z } from "zod";
import { PREFIX_PATTERN, SLUG_PATTERN } from "../ref-shapes.ts";
import { Id, Int4, Timestamp } from "./common.ts";
import { Login, UserRef } from "./user.ts";

/**
 * What both `getProjectByRef` and `requireProject` throw when the caller has
 * no role here, whether or not the project exists (T-280). A constant because
 * the CLI matches on it to tell "no such project, or none you can read" from
 * `issue not found`, and a message reworded on one side only would silently
 * stop that match from ever firing.
 */
export const PROJECT_NOT_FOUND = "project not found";

export const ProjectSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(
    new RegExp(`^${SLUG_PATTERN}$`),
    "lowercase letters, digits, and dashes",
  );

/**
 * What a `/api/projects/{…}` path segment may say: a slug, or a project id
 * written in digits (T-266). Stored links are anchored on the id, so every
 * route has to answer to one; an all-digit segment is unambiguous because
 * `ProjectSlugInput` forbids taking such a slug.
 *
 * The id form is a subset of the slug pattern, so the shape is the same one
 * `ProjectSlug` accepts. It has its own name because the two say different
 * things: this one is deliberately the wider of the pair.
 */
export const ProjectRef = ProjectSlug;

/**
 * The slug a project may be created or renamed to. Narrower than what routes
 * accept: an all-digit slug would make `/projects/1/` mean two things at
 * once, and the whole id-anchored link form rests on it meaning one.
 */
export const ProjectSlugInput = ProjectSlug.refine(
  (slug) => !/^\d+$/.test(slug),
  { error: "lowercase letters, digits, and dashes; not all digits" },
);

/**
 * Internal issue reference prefix: null = `#N`, 'T' = `T-N`. Lives here
 * rather than in references.ts because project creation takes one too, and
 * references.ts already imports this file — the other direction would cycle.
 */
export const InternalRefPrefix = z
  .string()
  .regex(
    new RegExp(`^${PREFIX_PATTERN}$`),
    "capital letter, then capitals/digits/_",
  )
  .nullable();
export type InternalRefPrefix = z.infer<typeof InternalRefPrefix>;

/**
 * Descending authority, because pickers render this list in order.
 * `ROLE_RANK` in permissions.ts is the same order as numbers, and the two are
 * tied together by a test rather than by this comment.
 *
 * Spelled as a tuple beside the schema because drizzle's `text({ enum })`
 * needs the literals, and `z.enum(...).options` widens them to `string`.
 */
export const MEMBER_ROLES = ["admin", "writer", "reporter", "reader"] as const;
export const MemberRole = z.enum(MEMBER_ROLES);
export type MemberRole = z.infer<typeof MemberRole>;

export const Project = z.object({
  id: Id,
  slug: ProjectSlug,
  name: z.string(),
  description: z.string(),
  created_at: Timestamp,
  /**
   * Retired slugs that still route here, oldest first (T-156). Only the
   * single-project GET carries it; listing every project's history would be
   * a query per row for something no list view shows.
   */
  former_slugs: z.array(ProjectSlug).optional(),
  /**
   * The requesting user's role here (T-231). Optional: servers predating it
   * omit it. Lets a picker offer only the projects a card may be moved into
   * without a request per row — the server checks the role again anyway.
   */
  viewer_role: MemberRole.optional(),
  /**
   * The clear line (T-377): a blocker at this status or past it stops
   * blocking, and null falls back to the closed category. Optional for the
   * same reason as `former_slugs` — it lives in the project's own database,
   * so only the single-project GET and the PATCH that writes it carry it,
   * and a list of every project would be a query per row to fetch it.
   */
  block_clear_status_id: Id.nullable().optional(),
  /**
   * Versioned URL of the uploaded project icon; null = draw the fallback.
   * Optional for the same reason as `viewer_role`: a server predating it
   * omits the field, and a client reads that as "no icon".
   */
  icon_url: z.string().nullable().optional(),
});
export type Project = z.infer<typeof Project>;

/** Just enough of a project to name and link it from another entity's view. */
export const ProjectBrief = Project.pick({
  id: true,
  slug: true,
  name: true,
  icon_url: true,
});
export type ProjectBrief = z.infer<typeof ProjectBrief>;

/**
 * The keys of the templates that ship with todou, each one an entry
 * of `BUILTIN_TEMPLATES` in project-template.ts. Here rather than there
 * because `TemplateRef` needs them and project creation takes one, and
 * project-template.ts imports this file — the other direction would cycle.
 *
 * `"default"` is what a project is created from when no template is named,
 * whatever else this list grows to hold.
 */
export const BUILTIN_TEMPLATE_KEYS = ["default"] as const;
export const BuiltinTemplateKey = z.enum(BUILTIN_TEMPLATE_KEYS);
export type BuiltinTemplateKey = z.infer<typeof BuiltinTemplateKey>;

/** A built-in template's key, or the id of one of the caller's own. */
export const TemplateRef = z.union([BuiltinTemplateKey, Id]);
export type TemplateRef = z.infer<typeof TemplateRef>;

export const ProjectCreateInput = z
  .object({
    slug: ProjectSlugInput,
    name: z.string().min(1).max(200),
    description: z.string().max(4000).default(""),
    // Omitted and null both mean `#N`: no format history row is written, so
    // the project claims nothing in the cross-project prefix directory.
    ref_prefix: InternalRefPrefix.optional(),
    reclaim: z.boolean().optional(),
    /**
     * What the project's statuses and labels start as. Omitted means
     * the built-in `"default"`, never the caller's own default template: the
     * same request then creates the same project whoever sends it.
     */
    template: TemplateRef.optional(),
    /** Start from another project's current statuses and labels instead. */
    from_project: ProjectRef.optional(),
    /**
     * The caller's agents to add, exactly these; an empty list adds none.
     * Omitted means every agent of theirs that has a join role set.
     */
    agents: z
      .array(z.object({ login: Login, role: MemberRole }))
      .max(50)
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (input.template !== undefined && input.from_project !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["from_project"],
        message: "give template or from_project, not both",
      });
    }
  });
export type ProjectCreateInput = z.infer<typeof ProjectCreateInput>;

export const ProjectUpdateInput = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  slug: ProjectSlugInput.optional(),
  /**
   * Take a slug another project used to hold. Required because reclaiming
   * silently would repoint that project's off-site links — including the
   * attachment URLs pasted verbatim into old comments, where a same-numbered
   * attachment in the new project is fetched instead of 404ing.
   */
  reclaim: z.boolean().optional(),
  /** Null clears the line and falls back to the closed category (T-377). */
  block_clear_status_id: Id.nullable().optional(),
});
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInput>;

/**
 * Set on a 2xx whose path named a retired slug (T-156), carrying the
 * project's current one. A 3xx would be the obvious spelling and is wrong
 * here: `fetch` follows redirects silently, so the caller would never learn
 * the new slug, and a redirect inside a batch sub-request reads as an error.
 */
export const CANONICAL_SLUG_HEADER = "x-todou-canonical-slug";

export const Member = z.object({
  user: UserRef,
  role: MemberRole,
  created_at: Timestamp,
  /**
   * A machine owner's **effective** role here, which is the ceiling on the
   * machine's own role; always null for a human. Computed server-side the way
   * `projectRoleOf` computes it, so an instance admin reads as admin rather
   * than null — that is how the page tells "the owner is an instance admin"
   * from "the owner really is not in this project" without re-deriving the
   * rule for itself.
   *
   * Optional for the same reason as `Project.viewer_role`: a server from
   * before this field omits it. A client reads missing as "ceiling unknown",
   * which is read-only — the safe direction to degrade in.
   */
  owner_role: MemberRole.nullable().optional(),
});
export type Member = z.infer<typeof Member>;

export const MemberAddInput = z.object({
  login: Login,
  role: MemberRole,
});
export type MemberAddInput = z.infer<typeof MemberAddInput>;

export const MemberSetInput = z.object({
  role: MemberRole,
});
export type MemberSetInput = z.infer<typeof MemberSetInput>;

export const StatusCategory = z.enum(["open", "closed"]);
export type StatusCategory = z.infer<typeof StatusCategory>;

export const ColorHex = z.string().regex(/^#[0-9a-f]{6}$/i);

export const Status = z.object({
  id: Id,
  name: z.string(),
  category: StatusCategory,
  color: ColorHex,
  position: z.number().int(),
  is_default: z.boolean(),
});
export type Status = z.infer<typeof Status>;

/**
 * A writable status name: canonical by the rule label names follow
 * (`canonicalizeLabelName`), since `issue list --status` trims each name it
 * is given and could never select a stored `"Done "`; stored as NFC. Blank
 * and length are checked on the canonical form, so a padded 60-character
 * name fits, while the messages speak of what the caller sent. Read schemas
 * stay loose: the API lists whatever name is stored.
 */
export const StatusName = z
  .string()
  .transform(canonicalizeLabelName)
  .pipe(
    z
      .string()
      .min(1, { error: "status names cannot be blank (whitespace is trimmed)" })
      .max(60, { error: "status names are at most 60 characters" }),
  );

export const StatusCreateInput = z.object({
  name: StatusName,
  category: StatusCategory,
  color: ColorHex.default("#6b7280"),
  position: Int4.optional(),
});
export type StatusCreateInput = z.infer<typeof StatusCreateInput>;

export const StatusUpdateInput = z.object({
  name: StatusName.optional(),
  category: StatusCategory.optional(),
  color: ColorHex.optional(),
  position: Int4.optional(),
  is_default: z.boolean().optional(),
});
export type StatusUpdateInput = z.infer<typeof StatusUpdateInput>;

/**
 * One drop on the Statuses page (T-712): the whole order, and where the
 * block clear line now sits, written together so a drop across the line is
 * one reevaluation of blocks rather than one per moved row.
 */
export const StatusOrderInput = z.object({
  ids: z.array(Id).min(1),
  block_clear_status_id: Id.nullable().optional(),
});
export type StatusOrderInput = z.infer<typeof StatusOrderInput>;

export const StatusOrder = z.object({
  statuses: z.array(Status),
  block_clear_status_id: Id.nullable(),
});
export type StatusOrder = z.infer<typeof StatusOrder>;

/**
 * Issues sitting in a status (T-712). Trashed ones are split out because
 * the issue list does not show them, yet they still keep a status from
 * being deleted.
 */
export const StatusUsage = z.object({
  id: Id,
  issues: z.number().int().nonnegative(),
  trashed: z.number().int().nonnegative(),
});
export type StatusUsage = z.infer<typeof StatusUsage>;

/**
 * The name a label or a status is actually stored under: composed (Unicode
 * NFC, so "e" plus a combining accent is stored as the one "é" it looks
 * like), trimmed, spaces collapsed.
 */
export function canonicalizeLabelName(input: string): string {
  return input.normalize("NFC").trim().replace(/\s+/g, " ");
}

/**
 * The yardstick two status or label names are compared with: one name
 * whatever its case or Unicode composition. Each code point is lowercased
 * on its own, the way the database's lower() does, so the API never takes
 * a name the unique index refuses: a capital dotted I is plain i, and so
 * is i with a combining dot above, a word-final capital sigma is σ, and
 * ς counts as σ. Whitespace is left as it is: a lookup does not respace
 * what it is given.
 */
export function nameKey(name: string): string {
  let key = "";
  for (const c of name.normalize("NFC")) {
    key += c === "\u0130" ? "i" : c.toLowerCase();
  }
  return key.replaceAll("i\u0307", "i").replaceAll("\u03c2", "\u03c3");
}

/**
 * The entry `name` names: its exact spelling first, else the one with the
 * same `nameKey`. Two entries can share a key only where the database's
 * `lower()` folds less than `nameKey` (see the migration).
 */
export function findByName<T extends { name: string }>(
  items: readonly T[],
  name: string,
): T | undefined {
  const key = nameKey(name);
  return (
    items.find((item) => item.name === name) ??
    items.find((item) => nameKey(item.name) === key)
  );
}

/**
 * A writable label name (T-136). Two rules, both of them the CLI's
 * addressing model made binding:
 *
 * - **No commas.** `--label 'a,b'` means two labels there, the way it does
 *   in gh, so a stored `a,b` could be created and then never selected,
 *   renamed or deleted from the CLI again.
 * - **Canonical whitespace.** The CLI trims each comma-separated piece, so
 *   `" bug "` would be just as unreachable. Collapsing runs of whitespace
 *   comes along for free and matches what the web already sent. The name
 *   is stored as NFC.
 *
 * Read schemas stay unconstrained on purpose: rows that predate this rule
 * must remain listable and renameable — the point is to stop new ones, not
 * to make an existing project unreadable.
 */
export const LabelName = z
  .string()
  .transform(canonicalizeLabelName)
  .pipe(
    z
      .string()
      // Said in terms of what was sent, not of the canonical form the
      // checks actually run against — "too small" reads as nonsense to
      // someone who passed three spaces.
      .min(1, { error: "label names cannot be blank (whitespace is trimmed)" })
      .max(60, { error: "label names are at most 60 characters" })
      .refine((name) => !name.includes(","), {
        error: "label names cannot contain a comma — commas separate labels",
      }),
  );

export const Label = z.object({
  id: Id,
  name: z.string(),
  color: ColorHex,
});
export type Label = z.infer<typeof Label>;

/**
 * How many issues carry a label (T-713), out of the trash. Its own read
 * rather than fields on `Label`: every CLI command that resolves a label
 * name lists the catalog, and none of them needs a count.
 */
export const LabelUsage = z.object({
  id: Id,
  open_issues: z.number().int().nonnegative(),
  issues: z.number().int().nonnegative(),
});
export type LabelUsage = z.infer<typeof LabelUsage>;

export const LabelCreateInput = z.object({
  name: LabelName,
  color: ColorHex.default("#3b82f6"),
});
export type LabelCreateInput = z.infer<typeof LabelCreateInput>;

export const LabelUpdateInput = z.object({
  name: LabelName.optional(),
  color: ColorHex.optional(),
});
export type LabelUpdateInput = z.infer<typeof LabelUpdateInput>;
