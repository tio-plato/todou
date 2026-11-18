import { z } from "zod";
import { Role } from "./insights.ts";
import {
  ColorHex,
  canonicalizeLabelName,
  LabelName,
  ProjectRef,
  StatusCategory,
  TemplateRef,
} from "./project.ts";

/**
 * One status of a project template. It carries no id, since a
 * template belongs to no project: the default status and the block clear
 * line are marks on the status itself, matched to a project's statuses by
 * name. The name is stored canonical — trimmed, inner whitespace collapsed —
 * by the rule label names follow.
 */
export const TemplateStatus = z.object({
  name: z
    .string()
    .transform(canonicalizeLabelName)
    .pipe(z.string().min(1).max(60)),
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
 * are compared after canonicalizing and case-sensitively, the way
 * `statuses_project_name_idx` compares them, so `Done` and `done` may both
 * be there while `Done` and `"Done "` may not.
 */
export const TemplateBody = z
  .object({
    statuses: z.array(TemplateStatus).min(1).max(100),
    labels: z.array(TemplateLabel).max(500),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    for (const [index, status] of body.statuses.entries()) {
      if (seen.has(status.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["statuses", index, "name"],
          message: `status "${status.name}" appears twice`,
        });
      }
      seen.add(status.name);
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
      if (labels.has(label.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["labels", index, "name"],
          message: `label "${label.name}" appears twice`,
        });
      }
      labels.add(label.name);
    }
  });
export type TemplateBody = z.infer<typeof TemplateBody>;

export const TemplateName = z.string().trim().min(1).max(100);

export const ProjectTemplate = z.object({
  /** A built-in template's key; the id for one of the caller's own. */
  ref: TemplateRef,
  name: z.string(),
  builtin: z.boolean(),
  /** Bumped by every PUT; a built-in template's is always 0. */
  revision: z.number().int(),
  body: TemplateBody,
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
 * The fields every row of an apply plan carries. `id` is what `selected`
 * names: a row adding a status or label goes by the template's name for it,
 * having no id in the project yet; a row changing or deleting one goes by
 * its id in the project, so that two statuses whose names differ only in
 * whitespace never share one; the order, default and line rows have fixed
 * ids.
 */
const ChangeBase = {
  id: z.string(),
  section: z.enum(["statuses", "labels"]),
  action: z.enum(["add", "change", "delete"]),
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
    /** The status it goes in after, null for first. */
    after: z.string().nullable(),
  }),
  z.object({
    ...ChangeBase,
    type: z.literal("status_change"),
    name: z.string(),
    color_now: ColorHex,
    color: transition(ColorHex).optional(),
    category: transition(StatusCategory).optional(),
    chart_role: transition(Role).optional(),
  }),
  z.object({
    ...ChangeBase,
    type: z.literal("status_order"),
    /** The statuses both sides have, in the project's order and the template's. */
    from: z.array(StatusRef),
    to: z.array(StatusRef),
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
  }),
]);
export type ChangeRow = z.infer<typeof ChangeRow>;

export const TemplatePreviewInput = z.object({ template: TemplateRef });
export type TemplatePreviewInput = z.infer<typeof TemplatePreviewInput>;

/** Every difference between a project and a template; empty when none. */
export const TemplateApplyPlan = z.object({
  /** What the plan was computed from; apply refuses it once that changed. */
  expected: z.string(),
  changes: z.array(ChangeRow),
});
export type TemplateApplyPlan = z.infer<typeof TemplateApplyPlan>;

export const TemplateApplyInput = z.object({
  template: TemplateRef,
  expected: z.string(),
  selected: z.array(z.string()).min(1),
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
