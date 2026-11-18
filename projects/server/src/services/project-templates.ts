import {
  BUILTIN_TEMPLATE_KEYS,
  BUILTIN_TEMPLATES,
  can,
  canonicalizeLabelName,
  type ProjectTemplate,
  type ProjectTemplateCreateInput,
  type ProjectTemplateUpdateInput,
  StoredTemplateBody,
  TemplateBody,
  type TemplateProblem,
  type TemplateRef,
} from "@todou/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import {
  insightsSettings,
  labels,
  projectMeta,
  statuses,
} from "../db/project-schema.ts";
import { projectTemplates } from "../db/system-schema.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from "../errors.ts";
import { requireCapability, routeInfoOf } from "./access.ts";
import { insightsSettingsResponse } from "./insights-settings.ts";

type TemplateRow = typeof projectTemplates.$inferSelect;

/** What a template reference resolves to: its body and its revision. */
export type ResolvedTemplate = { body: TemplateBody; revision: number };

const TEMPLATE_NOT_FOUND = "template not found";

/** Labels carry no order; storing them by name keeps equal bodies equal. */
function normalized(body: TemplateBody): TemplateBody {
  return {
    statuses: body.statuses,
    labels: [...body.labels].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
  };
}

/**
 * A stored body read by this version's rules, or where it breaks them. Only
 * this module writes the column, and only a parsed body, yet another version
 * may have written it — a newer one, before a rollback — so a row that does
 * not parse is reported rather than thrown: one such row must not take the
 * whole list down, and with it every new project.
 */
function readBody(
  row: TemplateRow,
): { body: TemplateBody } | { problems: TemplateProblem[] } {
  const parsed = StoredTemplateBody.safeParse(row.body);
  if (parsed.success) return { body: parsed.data };
  return {
    problems: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

function toTemplate(row: TemplateRow): ProjectTemplate {
  const read = readBody(row);
  return {
    ref: row.id,
    name: row.name,
    builtin: false,
    revision: row.revision,
    ...("body" in read ? read : { body: null, problems: read.problems }),
  };
}

function builtinTemplates(): ProjectTemplate[] {
  return BUILTIN_TEMPLATE_KEYS.map((key) => ({
    ref: key,
    name: BUILTIN_TEMPLATES[key].name,
    builtin: true,
    revision: 0,
    body: BUILTIN_TEMPLATES[key].body,
  }));
}

/** The built-in templates, `default` first, then the caller's by name. */
export async function listProjectTemplates(
  ctx: AppContext,
  actor: UserRow,
): Promise<ProjectTemplate[]> {
  const rows = await ctx.router
    .system()
    .select()
    .from(projectTemplates)
    .where(eq(projectTemplates.ownerId, actor.id))
    .orderBy(asc(projectTemplates.name), asc(projectTemplates.id));
  return [...builtinTemplates(), ...rows.map(toTemplate)];
}

/**
 * A built-in template by key, or one of the caller's own by id. Anyone
 * else's id answers like one that does not exist.
 */
export async function resolveTemplate(
  ctx: AppContext,
  actor: UserRow,
  ref: TemplateRef,
): Promise<ResolvedTemplate> {
  if (typeof ref === "string") {
    const builtin = Object.hasOwn(BUILTIN_TEMPLATES, ref)
      ? BUILTIN_TEMPLATES[ref]
      : undefined;
    if (builtin === undefined) throw new NotFoundError(TEMPLATE_NOT_FOUND);
    return { body: builtin.body, revision: 0 };
  }
  const rows = await ctx.router
    .system()
    .select()
    .from(projectTemplates)
    .where(
      and(eq(projectTemplates.id, ref), eq(projectTemplates.ownerId, actor.id)),
    );
  const row = rows[0];
  if (!row) throw new NotFoundError(TEMPLATE_NOT_FOUND);
  const read = readBody(row);
  if ("problems" in read) {
    throw new ValidationFailedError(
      `template "${row.name}" cannot be read by this version of todou`,
      { problems: read.problems },
    );
  }
  return { body: read.body, revision: row.revision };
}

/**
 * A project's statuses and labels as they stand, read as a template body:
 * statuses in board order with the default and the block clear line marked,
 * each chart role as the project counts it — saved or default — and every
 * label. Shared by saving a project as a template and creating a project
 * from another one, so the two give the same result.
 *
 * Names are canonicalized the way template names are, so applying the saved
 * template back to the project matches every name. The refusals name what
 * could not be made a template: two names that become one, or a label name
 * holding a comma, which predates the rule against them.
 */
export async function templateBodyFromProject(
  ctx: AppContext,
  actor: UserRow,
  ref: string,
): Promise<TemplateBody> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    ref,
    "status.list",
  );
  if (!can(role, "label.list")) {
    throw new ForbiddenError("requires the label.list capability");
  }
  const db = await ctx.router.forProject(routeInfoOf(project));
  const [statusRows, meta, saved, labelRows] = await Promise.all([
    db
      .select()
      .from(statuses)
      .where(eq(statuses.projectId, project.id))
      .orderBy(asc(statuses.position), asc(statuses.id)),
    db
      .select({ lineId: projectMeta.blockClearStatusId })
      .from(projectMeta)
      .where(eq(projectMeta.projectId, project.id)),
    db
      .select()
      .from(insightsSettings)
      .where(eq(insightsSettings.projectId, project.id)),
    db
      .select()
      .from(labels)
      .where(eq(labels.projectId, project.id))
      .orderBy(asc(labels.id)),
  ]);
  const lineId = meta[0]?.lineId ?? null;
  const roleOf = new Map(
    insightsSettingsResponse(statusRows, saved[0]).roles.map((entry) => [
      entry.status_id,
      entry.role,
    ]),
  );

  refuseMergedNames(
    "statuses",
    statusRows.map((row) => row.name),
  );
  refuseMergedNames(
    "labels",
    labelRows.map((row) => row.name),
  );
  const comma = labelRows.find((row) => row.name.includes(","));
  if (comma) {
    throw new ValidationFailedError(
      `label "${comma.name}" holds a comma, which label names no longer may — rename it first`,
    );
  }

  const parsed = TemplateBody.safeParse({
    statuses: statusRows.map((row) => ({
      name: row.name,
      category: row.category,
      color: row.color,
      chart_role: roleOf.get(row.id),
      ...(row.isDefault && { is_default: true }),
      ...(row.id === lineId && { block_clear: true }),
    })),
    labels: labelRows.map((row) => ({ name: row.name, color: row.color })),
  });
  if (!parsed.success) {
    throw new ValidationFailedError(
      "this project's statuses and labels cannot be made a template",
      parsed.error.issues,
    );
  }
  return normalized(parsed.data);
}

function refuseMergedNames(kind: "statuses" | "labels", names: string[]) {
  const seen = new Map<string, string>();
  for (const name of names) {
    const key = canonicalizeLabelName(name);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new ValidationFailedError(
        `${kind} "${first}" and "${name}" are one name once whitespace is trimmed — rename one first`,
      );
    }
    seen.set(key, name);
  }
}

export async function createProjectTemplate(
  ctx: AppContext,
  actor: UserRow,
  input: ProjectTemplateCreateInput,
): Promise<ProjectTemplate> {
  const body =
    "body" in input
      ? normalized(input.body)
      : await templateBodyFromProject(ctx, actor, input.from_project);
  const inserted = await ctx.router
    .system()
    .insert(projectTemplates)
    .values({ ownerId: actor.id, name: input.name, body })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("project template insert returned no row");
  return toTemplate(row);
}

/**
 * A whole replacement, refused when `revision` is not the stored one: a tab
 * still showing an older body would otherwise put it back over a newer one.
 */
export async function updateProjectTemplate(
  ctx: AppContext,
  actor: UserRow,
  id: number,
  input: ProjectTemplateUpdateInput,
): Promise<ProjectTemplate> {
  const system = ctx.router.system();
  const updated = await system
    .update(projectTemplates)
    .set({
      name: input.name,
      body: normalized(input.body),
      revision: sql`${projectTemplates.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(projectTemplates.id, id),
        eq(projectTemplates.ownerId, actor.id),
        eq(projectTemplates.revision, input.revision),
      ),
    )
    .returning();
  const row = updated[0];
  if (row) return toTemplate(row);
  const current = await system
    .select({ revision: projectTemplates.revision })
    .from(projectTemplates)
    .where(
      and(eq(projectTemplates.id, id), eq(projectTemplates.ownerId, actor.id)),
    );
  const stored = current[0];
  if (!stored) throw new NotFoundError(TEMPLATE_NOT_FOUND);
  throw new ConflictError("template changed — reload before saving", {
    current_revision: stored.revision,
  });
}

export async function deleteProjectTemplate(
  ctx: AppContext,
  actor: UserRow,
  id: number,
): Promise<void> {
  const deleted = await ctx.router
    .system()
    .delete(projectTemplates)
    .where(
      and(eq(projectTemplates.id, id), eq(projectTemplates.ownerId, actor.id)),
    )
    .returning({ id: projectTemplates.id });
  if (deleted.length === 0) throw new NotFoundError(TEMPLATE_NOT_FOUND);
}
