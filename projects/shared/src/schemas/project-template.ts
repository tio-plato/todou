import { z } from "zod";
import { defaultInsightsRole, Role } from "./insights.ts";
import {
  type BuiltinTemplateKey,
  ColorHex,
  LabelName,
  LabelStyle,
  nameKey,
  ProjectRef,
  StatusCategory,
  StatusName,
  TemplateRef,
} from "./project.ts";

/**
 * One status of a project template. It carries no id, since a
 * template belongs to no project: the default status and the block clear
 * line are marks on the status itself, matched to a project's statuses by
 * name. The name goes through `StatusName`, the schema a project's own
 * status names go through: stored canonical, trimmed and inner whitespace
 * collapsed.
 */
export const TemplateStatus = z.object({
  name: StatusName,
  category: StatusCategory,
  color: ColorHex,
  chart_role: Role,
  is_default: z.literal(true).optional(),
  block_clear: z.literal(true).optional(),
});
export type TemplateStatus = z.infer<typeof TemplateStatus>;

export const TemplateLabel = z.object({ name: LabelName, color: ColorHex });
export type TemplateLabel = z.infer<typeof TemplateLabel>;

/**
 * What a template holds: the statuses in board order and the labels. Names
 * are canonicalized, then compared whatever their case or Unicode
 * composition (`nameKey`), the way a project compares them, so neither
 * `Done` and `done` nor `Done` and `"Done "` may both be there.
 */
/** The rules a body holds beyond each field's own. */
function checkBody(
  body: { statuses: TemplateStatus[]; labels: TemplateLabel[] },
  ctx: z.RefinementCtx,
) {
  const seen = new Set<string>();
  for (const [index, status] of body.statuses.entries()) {
    const key = nameKey(status.name);
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["statuses", index, "name"],
        message: `status "${status.name}" appears twice`,
      });
    }
    seen.add(key);
  }
  for (const mark of ["is_default", "block_clear"] as const) {
    if (body.statuses.filter((status) => status[mark]).length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["statuses"],
        message: `only one status may be marked ${mark}`,
      });
    }
  }
  const labels = new Set<string>();
  for (const [index, label] of body.labels.entries()) {
    const key = nameKey(label.name);
    if (labels.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["labels", index, "name"],
        message: `label "${label.name}" appears twice`,
      });
    }
    labels.add(key);
  }
}

export const TemplateBody = z
  .object({
    statuses: z.array(TemplateStatus).min(1).max(100),
    labels: z.array(TemplateLabel).max(500),
  })
  .superRefine(checkBody);
export type TemplateBody = z.infer<typeof TemplateBody>;

/**
 * A stored body as this version reads it: `TemplateBody`, except that a
 * field this version does not know is a problem rather than dropped. A newer
 * version may have written one; read as compatible, the template could be
 * edited here and saved back without it.
 */
export const StoredTemplateBody = z
  .strictObject({
    statuses: z.array(z.strictObject(TemplateStatus.shape)).min(1).max(100),
    labels: z.array(z.strictObject(TemplateLabel.shape)).max(500),
  })
  .superRefine(checkBody);

/** A status of a built-in template, its chart role the default one. */
function builtinStatus(
  status: Omit<TemplateStatus, "chart_role">,
): TemplateStatus {
  return { ...status, chart_role: defaultInsightsRole(status) };
}

/**
 * The templates that ship with todou, by key. `basic` is what every new
 * project starts as unless the request names another template, and the only
 * place the status flow new projects get is spelled out.
 *
 * Its statuses are the flow agents work in (see the todou-workflow skill),
 * which `todou status init` also applies to projects that predate it.
 * Colors run gray (not started) → cyan/blue (active) → amber (awaiting
 * delivery) → violet (out) → green (done). Invalid, the other closed status,
 * is a dark slate: clear of green so a card closed without being done never
 * reads as finished, and darker than the not-started grays.
 *
 * Todo is pinned as the default rather than left to the first-by-position
 * fallback, which Backlog now sits ahead of.
 *
 * Shipped is the block clear line (T-711): the card that waits on a blocker
 * can start once the blocker is deployed, not only once the user has
 * verified it. Invalid sits past Done, so it clears too.
 *
 * Each chart role is whatever `defaultInsightsRole` says, so a project
 * created from this stores none, and a change to that rule reaches it.
 *
 * The labels are the issue kinds and the design flag the workflow uses, in
 * colors from the label palette: red for bugs, the one color trackers agree
 * on; light blue, green and yellow kept apart from it and from each other.
 */
export const BUILTIN_TEMPLATES: Record<
  BuiltinTemplateKey,
  { name: string; body: TemplateBody }
> = {
  basic: {
    name: "Basic",
    body: {
      statuses: [
        builtinStatus({ name: "Backlog", category: "open", color: "#9ca3af" }),
        builtinStatus({
          name: "Todo",
          category: "open",
          color: "#6b7280",
          is_default: true,
        }),
        builtinStatus({ name: "Next", category: "open", color: "#06b6d4" }),
        builtinStatus({
          name: "In Progress",
          category: "open",
          color: "#3b82f6",
        }),
        builtinStatus({
          name: "Ready to Ship",
          category: "open",
          color: "#f59e0b",
        }),
        builtinStatus({
          name: "Shipped",
          category: "open",
          color: "#8b5cf6",
          block_clear: true,
        }),
        builtinStatus({ name: "Done", category: "closed", color: "#22c55e" }),
        builtinStatus({
          name: "Invalid",
          category: "closed",
          color: "#475569",
        }),
      ],
      labels: [
        { name: "kind:bug", color: "#ef4444" },
        { name: "kind:chore", color: "#22c55e" },
        { name: "kind:feature", color: "#0ea5e9" },
        { name: "needs-brainstorm", color: "#eab308" },
      ],
    },
  },
};

export const TemplateName = z.string().trim().min(1).max(100);

/** Where a stored template fails this version's rules, and why. */
export const TemplateProblem = z.object({
  path: z.string(),
  message: z.string(),
});
export type TemplateProblem = z.infer<typeof TemplateProblem>;

export const ProjectTemplate = z.object({
  /** A built-in template's key; the id for one of the caller's own. */
  ref: TemplateRef,
  name: z.string(),
  builtin: z.boolean(),
  /** Bumped by every PUT; a built-in template's is always 0. */
  revision: z.number().int(),
  /**
   * Null when this version cannot read what was stored — written by a newer
   * one, say, before a rollback. Such a template is still listed, so it can
   * be seen and deleted, but nothing can be made from it.
   */
  body: TemplateBody.nullable(),
  /** Present exactly when `body` is null. */
  problems: z.array(TemplateProblem).optional(),
});
export type ProjectTemplate = z.infer<typeof ProjectTemplate>;

/**
 * Exactly one of `body` and `from_project`. Both shapes are strict: with
 * plain objects a request carrying both would pass as the first shape, and
 * `from_project` would be dropped without a word.
 */
export const ProjectTemplateCreateInput = z.union([
  z.strictObject({ name: TemplateName, body: TemplateBody }),
  z.strictObject({ name: TemplateName, from_project: ProjectRef }),
]);
export type ProjectTemplateCreateInput = z.infer<
  typeof ProjectTemplateCreateInput
>;

/**
 * A whole replacement. The revision is checked because without it a stale
 * tab would silently put back what another tab just changed.
 */
export const ProjectTemplateUpdateInput = z.object({
  revision: z.number().int().nonnegative(),
  name: TemplateName,
  body: TemplateBody,
});
export type ProjectTemplateUpdateInput = z.infer<
  typeof ProjectTemplateUpdateInput
>;

/** A status named in a change row, with the colour to draw it in. */
export const StatusRef = z.object({ name: z.string(), color: ColorHex });
export type StatusRef = z.infer<typeof StatusRef>;

const transition = <T extends z.ZodType>(value: T) =>
  z.object({ from: value, to: value });

/**
 * What a row does, one select-all box each: add, recolour alone, change what
 * a status means (open or closed, how charts count it, being the default),
 * move one in the board order, delete.
 */
export const ChangeRowAction = z.enum([
  "add",
  "recolour",
  "change",
  "move",
  "delete",
]);
export type ChangeRowAction = z.infer<typeof ChangeRowAction>;

/**
 * The fields every row of an apply plan carries. `id` is what `selected`
 * names: a row adding a status or label goes by the template's name for it,
 * having no id in the project yet; a row changing, moving or deleting one
 * goes by its id in the project, so that two statuses whose names differ
 * only in whitespace never share one; the default and line rows have fixed
 * ids.
 */
const ChangeBase = {
  id: z.string(),
  section: z.enum(["statuses", "labels"]),
  action: ChangeRowAction,
  default_selected: z.boolean(),
  /** False only for deleting a status that still holds issues. */
  selectable: z.boolean(),
  /** Rows that must be selected with this one. */
  requires: z.array(z.string()),
};

export const ChangeRow = z.discriminatedUnion("type", [
  z.object({
    ...ChangeBase,
    type: z.literal("status_add"),
    name: z.string(),
    category: StatusCategory,
    color: ColorHex,
    chart_role: Role,
    /**
     * The status before it in the template, null for the template's first.
     * Where it lands in the project is the shared rule's, which may differ.
     */
    after: z.string().nullable(),
  }),
  z.object({
    ...ChangeBase,
    type: z.literal("status_recolour"),
    name: z.string(),
    from: ColorHex,
    to: ColorHex,
  }),
  z.object({
    ...ChangeBase,
    type: z.literal("status_change"),
    name: z.string(),
    /**
     * The colour it has now, which a recolour row changes apart. Kept for
     * pages that predate that row: their schema requires it.
     */
    color_now: ColorHex,
    category: transition(StatusCategory).optional(),
    chart_role: transition(Role).optional(),
  }),
  /**
   * One status both sides have, out of place in the template's order. Its
   * name and colour are in the plan's `project`.
   */
  z.object({
    ...ChangeBase,
    type: z.literal("status_move"),
  }),
  z.object({
    ...ChangeBase,
    type: z.literal("status_default"),
    from: StatusRef.nullable(),
    to: StatusRef.nullable(),
  }),
  z.object({
    ...ChangeBase,
    type: z.literal("status_line"),
    from: StatusRef.nullable(),
    to: StatusRef.nullable(),
  }),
  z.object({
    ...ChangeBase,
    type: z.literal("status_delete"),
    name: z.string(),
    color: ColorHex,
    issues: z.number().int().nonnegative(),
    trashed: z.number().int().nonnegative(),
  }),
  z.object({
    ...ChangeBase,
    type: z.literal("label_add"),
    name: z.string(),
    color: ColorHex,
  }),
  z.object({
    ...ChangeBase,
    type: z.literal("label_change"),
    name: z.string(),
    from: ColorHex,
    to: ColorHex,
  }),
  z.object({
    ...ChangeBase,
    type: z.literal("label_delete"),
    name: z.string(),
    color: ColorHex,
    issues: z.number().int().nonnegative(),
    /** Trashed cards carrying it, which lose it too. */
    trashed: z.number().int().nonnegative(),
  }),
]);
export type ChangeRow = z.infer<typeof ChangeRow>;

export const TemplatePreviewInput = z.object({ template: TemplateRef });
export type TemplatePreviewInput = z.infer<typeof TemplatePreviewInput>;

/**
 * The project a plan was computed from, as it was read then: what a page
 * draws the table of before and after from, so that it draws what the
 * apply will work from rather than what another read says.
 */
export const TemplateApplyProject = z.object({
  /** In board order. */
  statuses: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      color: ColorHex,
      category: StatusCategory,
      /** The chart role it counts as now, saved or default. */
      role: Role,
      is_default: z.boolean(),
    }),
  ),
  /** The status the block clear line is on; null when there is no line. */
  line: z.number().int().nullable(),
  labels: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      color: ColorHex,
      // As a label carries it: absent means tint.
      style: LabelStyle.optional(),
    }),
  ),
});
export type TemplateApplyProject = z.infer<typeof TemplateApplyProject>;

/** Every difference between a project and a template; empty when none. */
export const TemplateApplyPlan = z.object({
  /** What the plan was computed from; apply refuses it once that changed. */
  expected: z.string(),
  project: TemplateApplyProject,
  /** The template's body the plan was computed from. */
  template: TemplateBody,
  changes: z.array(ChangeRow),
});
export type TemplateApplyPlan = z.infer<typeof TemplateApplyPlan>;

/**
 * A status as an apply leaves it: one the project has by its id, one it
 * adds by its name in the template.
 */
const StatusKey = z.union([z.number().int(), z.string()]);

export const TemplateApplyInput = z.object({
  template: TemplateRef,
  expected: z.string(),
  selected: z.array(z.string()).min(1),
  /**
   * What the page drew the project as once applied. The apply refuses to
   * write anything else; a page that predates it sends none, and is not
   * checked.
   */
  drawn: z
    .object({
      /** The statuses in board order. */
      order: z.array(StatusKey),
      /** The status the block clear line is on; null when there is none. */
      line: StatusKey.nullable(),
      default: StatusKey.nullable(),
    })
    .optional(),
});
export type TemplateApplyInput = z.infer<typeof TemplateApplyInput>;

export const TemplateApplyResult = z.object({
  /**
   * Selected status deletions left undone because the status held issues
   * when the apply ran; every other selected row was carried out.
   */
  skipped: z.array(z.string()),
});
export type TemplateApplyResult = z.infer<typeof TemplateApplyResult>;
