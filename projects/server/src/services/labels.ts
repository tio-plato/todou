import type {
  Label,
  LabelCreateInput,
  LabelUpdateInput,
  LabelUsage,
} from "@todou/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import { uniqueViolation } from "../auth/provision.ts";
import type { AppContext } from "../bootstrap.ts";
import { issueLabels, issues, labels, statuses } from "../db/project-schema.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { requireCapability, routeInfoOf } from "./access.ts";

type LabelRow = typeof labels.$inferSelect;

export function toLabel(row: LabelRow): Label {
  return { id: row.id, name: row.name, color: row.color };
}

/**
 * The name check and the write are two statements, so a concurrent create or
 * rename of the same name can still win the unique index between them; the
 * loser gets this same 409 rather than a 500.
 */
function labelNameTaken(name: string): ConflictError {
  return new ConflictError(`label "${name}" already exists`);
}

export async function listLabels(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<Label[]> {
  const { project } = await requireCapability(ctx, actor, slug, "label.list");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const rows = await db
    .select()
    .from(labels)
    .where(eq(labels.projectId, project.id))
    .orderBy(asc(labels.name));
  return rows.map(toLabel);
}

/** Every label of the project, an unused one as zeros. Trashed issues don't count. */
export async function listLabelUsage(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<LabelUsage[]> {
  const { project } = await requireCapability(ctx, actor, slug, "label.list");
  const db = await ctx.router.forProject(routeInfoOf(project));
  return db
    .select({
      id: labels.id,
      open_issues: sql<number>`(count(${issues.id}) filter (where ${statuses.category} = 'open'))::int`,
      issues: sql<number>`count(${issues.id})::int`,
    })
    .from(labels)
    .leftJoin(issueLabels, eq(issueLabels.labelId, labels.id))
    .leftJoin(
      issues,
      and(eq(issues.id, issueLabels.issueId), isNull(issues.deletedAt)),
    )
    .leftJoin(statuses, eq(statuses.id, issues.statusId))
    .where(eq(labels.projectId, project.id))
    .groupBy(labels.id)
    .orderBy(asc(labels.id));
}

export async function createLabel(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: LabelCreateInput,
): Promise<Label> {
  const { project } = await requireCapability(ctx, actor, slug, "label.create");
  const db = await ctx.router.forProject(routeInfoOf(project));

  const clash = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.projectId, project.id), eq(labels.name, input.name)));
  if (clash.length > 0) {
    throw labelNameTaken(input.name);
  }
  const inserted = await db
    .insert(labels)
    .values({ projectId: project.id, name: input.name, color: input.color })
    .returning()
    .catch((cause: unknown) => {
      if (uniqueViolation(cause) !== "labels_project_name_idx") throw cause;
      throw labelNameTaken(input.name);
    });
  const row = inserted[0];
  if (!row) throw new Error("label insert returned no row");
  ctx.bus.publish(project.id, {
    entity: "label",
    id: row.id,
    action: "created",
  });
  return toLabel(row);
}

export async function updateLabel(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  labelId: number,
  input: LabelUpdateInput,
): Promise<Label> {
  const { project } = await requireCapability(ctx, actor, slug, "label.update");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const where = and(eq(labels.id, labelId), eq(labels.projectId, project.id));

  // An UPDATE with no assignments is a driver error, not a no-op (T-730).
  if (input.name === undefined && input.color === undefined) {
    const rows = await db.select().from(labels).where(where);
    const row = rows[0];
    if (!row) throw new NotFoundError("label not found");
    return toLabel(row);
  }

  if (input.name !== undefined) {
    const clash = await db
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(eq(labels.projectId, project.id), eq(labels.name, input.name)),
      );
    if (clash.some((r) => r.id !== labelId)) {
      throw labelNameTaken(input.name);
    }
  }
  const updated = await db
    .update(labels)
    .set({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.color === undefined ? {} : { color: input.color }),
    })
    .where(where)
    .returning()
    .catch((cause: unknown) => {
      if (
        input.name === undefined ||
        uniqueViolation(cause) !== "labels_project_name_idx"
      ) {
        throw cause;
      }
      throw labelNameTaken(input.name);
    });
  const row = updated[0];
  if (!row) throw new NotFoundError("label not found");
  ctx.bus.publish(project.id, {
    entity: "label",
    id: row.id,
    action: "updated",
  });
  return toLabel(row);
}

export async function deleteLabel(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  labelId: number,
): Promise<void> {
  const { project } = await requireCapability(ctx, actor, slug, "label.delete");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const deleted = await db
    .delete(labels)
    .where(and(eq(labels.id, labelId), eq(labels.projectId, project.id)))
    .returning({ id: labels.id });
  if (deleted.length === 0) throw new NotFoundError("label not found");
  ctx.bus.publish(project.id, {
    entity: "label",
    id: labelId,
    action: "deleted",
  });
}
