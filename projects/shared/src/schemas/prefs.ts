import { z } from "zod";
import { TemplateRef } from "./project.ts";

/** Where a surface puts the ref relative to the title (T-157). */
export const RefPlacement = z.enum(["before", "after"]);
export type RefPlacement = z.infer<typeof RefPlacement>;

/**
 * Board cards carry a third form: the ref on a line of its own, under the
 * title and above the meta row.
 */
export const BoardRefPlacement = z.enum(["before", "after", "own_line"]);
export type BoardRefPlacement = z.infer<typeof BoardRefPlacement>;

/**
 * How a project without an uploaded icon draws its REF (T-555): on the
 * theme's muted square, or on a gradient hashed from its slug (T-544).
 */
export const ProjectIconFallback = z.enum(["monochrome_text", "colorful_text"]);
export type ProjectIconFallback = z.infer<typeof ProjectIconFallback>;

/**
 * The same choice for a person without an uploaded avatar. One member for
 * now; an enum rather than nothing so another generator is a new member, not
 * a new key.
 */
export const UserAvatarFallback = z.enum(["monochrome_text"]);
export type UserAvatarFallback = z.infer<typeof UserAvatarFallback>;

/**
 * Per-user preferences (T-97), stored server-side so every browser and
 * machine sees the same values — the weak-unread toggle must agree with
 * the server-side inbox filtering, which reads the same row. Strict so
 * unknown keys are rejected instead of silently dropped; defaults keep
 * clients parseable against servers that predate a key.
 */
export const MePrefs = z.strictObject({
  /**
   * Show the hollow-ring marker (and inbox rows) for issues whose only
   * news is events — no new comments (T-77's weak-unread state).
   *
   * A card someone else just opened is *not* one of those, despite `opened`
   * being an event: its top post counts as the first unread comment
   * (T-151), so turning this off never hides a new card.
   */
  show_weak_unread: z.boolean().default(true),
  /*
   * Ref placement, one key per rendering surface (T-157). Display-only: no
   * server code reads these, unlike `show_weak_unread` above. They live here
   * anyway so the choice follows the user between browsers.
   *
   * Flat rather than a `{surface: placement}` map because the server merges
   * patches with jsonb `||`, which is shallow: a nested object would be
   * replaced wholesale, so two tabs changing two different surfaces would
   * lose the earlier write.
   *
   * A stored value outside these enums cannot reach a parse — the server's
   * `toPrefs` drops it first, so the default below covers it.
   */
  ref_placement_list: RefPlacement.default("before"),
  ref_placement_board: BoardRefPlacement.default("own_line"),
  ref_placement_detail: RefPlacement.default("before"),
  ref_placement_reference: RefPlacement.default("before"),
  /*
   * How rich references render inside markdown bodies (T-371). Display-only,
   * same as the placements above.
   *
   * All three are scoped to markdown: timeline event rows read none of them,
   * so a reference in an "referenced by …" line looks the same whatever these
   * say. The boundary is the point — #359 measured that row's geometry, and
   * these keys must not be able to reopen it.
   */
  boxed_ref_links: z.boolean().default(true),
  truncate_ref_title: z.boolean().default(true),
  show_repeated_ref_title: z.boolean().default(false),
  /*
   * Open off-site links in markdown bodies in a new tab (T-552).
   * Display-only, like the keys above.
   */
  open_external_links_in_new_tab: z.boolean().default(false),
  /*
   * What an avatar box draws when nothing was uploaded (T-555).
   * Display-only. The project default is the gradient every project already
   * showed before this key existed.
   */
  project_icon_fallback: ProjectIconFallback.default("colorful_text"),
  user_avatar_fallback: UserAvatarFallback.default("monochrome_text"),
  /*
   * The template the New project dialog starts on. Read by the web
   * only: a create that names no template gets the built-in Basic whoever
   * sends it. A deleted template is not cleaned out of here; the dialog
   * falls back to the built-in Basic when it finds none by this id.
   */
  new_project_template: TemplateRef.default("basic"),
  /*
   * The spec page's outline beside the document and the change strip along
   * its right edge, each with its own comments and changes.
   * Display-only: the spec page reads them, no server code does.
   */
  spec_outline: z.boolean().default(true),
  spec_outline_comments: z.boolean().default(true),
  spec_outline_changes: z.boolean().default(true),
  spec_strip: z.boolean().default(true),
  spec_strip_comments: z.boolean().default(true),
  spec_strip_changes: z.boolean().default(true),
});
export type MePrefs = z.infer<typeof MePrefs>;

/**
 * Body of PATCH /me/prefs — a shallow partial merge. Built without the
 * defaults on purpose: a defaulted key would materialize in every parsed
 * patch and overwrite the stored value ("{}" must merge as a no-op).
 */
export const MePrefsPatch = z.strictObject({
  show_weak_unread: z.boolean().optional(),
  ref_placement_list: RefPlacement.optional(),
  ref_placement_board: BoardRefPlacement.optional(),
  ref_placement_detail: RefPlacement.optional(),
  ref_placement_reference: RefPlacement.optional(),
  boxed_ref_links: z.boolean().optional(),
  truncate_ref_title: z.boolean().optional(),
  show_repeated_ref_title: z.boolean().optional(),
  open_external_links_in_new_tab: z.boolean().optional(),
  project_icon_fallback: ProjectIconFallback.optional(),
  user_avatar_fallback: UserAvatarFallback.optional(),
  new_project_template: TemplateRef.optional(),
  spec_outline: z.boolean().optional(),
  spec_outline_comments: z.boolean().optional(),
  spec_outline_changes: z.boolean().optional(),
  spec_strip: z.boolean().optional(),
  spec_strip_comments: z.boolean().optional(),
  spec_strip_changes: z.boolean().optional(),
});
export type MePrefsPatch = z.infer<typeof MePrefsPatch>;
