import {
  canonicalizeLabelName,
  INT4_MAX,
  lineAfterDeleting,
  nameKey,
  type Status,
  type StatusCreateInput,
  type StatusOrder,
  type StatusOrderInput,
  type StatusUpdateInput,
  type StatusUsage,
} from "@todou/shared";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import { uniqueViolation } from "../auth/provision.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { issues, projectMeta, statuses } from "../db/project-schema.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationFailedError,
} from "../errors.ts";
import { requireCapability, routeInfoOf } from "./access.ts";
import { announceBlockChanges, reevaluateProjectBlocks } from "./blocks.ts";

type StatusRow = typeof statuses.$inferSelect;

export function toStatus(row: StatusRow): Status {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    color: row.color,
    position: row.position,
    is_default: row.isDefault,
  };
}

export async function listStatuses(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<Status[]> {
  const { project } = await requireCapability(ctx, actor, slug, "status.list");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const rows = await db
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, project.id))
    .orderBy(asc(statuses.position), asc(statuses.id));
  return rows.map(toStatus);
}

export async function listStatusUsage(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<StatusUsage[]> {
  const { project } = await requireCapability(ctx, actor, slug, "status.usage");
  const db = await ctx.router.forProject(routeInfoOf(project));
  return statusUsageRows(db, project.id);
}

/**
 * Issues per status, trashed ones apart: the counts the Statuses page shows
 * and applying a template decides deletions by, read one way for both.
 */
export function statusUsageRows(db: Db, projectId: number) {
  return db
    .select({
      id: statuses.id,
      issues: sql<number>`(count(${issues.id}) filter (where ${issues.deletedAt} is null))::int`,
      trashed: sql<number>`(count(${issues.id}) filter (where ${issues.deletedAt} is not null))::int`,
    })
    .from(statuses)
    .leftJoin(issues, eq(issues.statusId, statuses.id))
    .where(eq(statuses.projectId, projectId))
    .groupBy(statuses.id)
    .orderBy(asc(statuses.id));
}

/**
 * The whole order and the clear line in one write (T-712). One drop on the
 * Statuses page can change both — dragging the line's own status above it
 * moves the line to the next one — and as two writes it would reevaluate
 * blocks twice and announce a state nobody arranged.
 */
export async function reorderStatuses(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: StatusOrderInput,
): Promise<StatusOrder> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "status.manage",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));

  const result = await db.transaction(async (tx) => {
    // project_meta first, before any status is read or written: every
    // transaction writing several statuses queues there (see lockIssueRows).
    const meta = await tx
      .select({ lineId: projectMeta.blockClearStatusId })
      .from(projectMeta)
      .where(eq(projectMeta.projectId, project.id))
      .for("no key update");
    const rows = await tx
      .select()
      .from(statuses)
      .where(eq(statuses.projectId, project.id))
      .orderBy(asc(statuses.position), asc(statuses.id));
    const known = new Set(rows.map((row) => row.id));
    const supplied = new Set(input.ids);
    if (
      supplied.size !== input.ids.length ||
      supplied.size !== known.size ||
      input.ids.some((id) => !known.has(id))
    ) {
      throw new ConflictError("statuses changed — reload");
    }
    const line = input.block_clear_status_id;
    if (typeof line === "number" && !supplied.has(line)) {
      throw new ValidationFailedError("unknown status_id");
    }

    const byId = new Map(rows.map((row) => [row.id, row]));
    const moved: number[] = [];
    const ordered = [];
    for (const [index, id] of input.ids.entries()) {
      const row = byId.get(id) as StatusRow;
      if (row.position !== index) {
        moved.push(id);
        await tx
          .update(statuses)
          .set({ position: index })
          .where(eq(statuses.id, id));
      }
      ordered.push({ ...row, position: index });
    }

    const before = meta[0]?.lineId ?? null;
    const after = line === undefined ? before : line;
    if (after !== before) {
      await tx
        .update(projectMeta)
        .set({ blockClearStatusId: after })
        .where(eq(projectMeta.projectId, project.id));
    }
    return { ordered, moved, lineChanged: after !== before, line: after };
  });

  if (result.moved.length > 0 || result.lineChanged) {
    const changes = await reevaluateProjectBlocks(ctx, project, db);
    await announceBlockChanges(ctx, changes, actor.id);
  }
  for (const id of result.moved) {
    ctx.bus.publish(project.id, { entity: "status", id, action: "updated" });
  }
  if (result.lineChanged) {
    ctx.bus.publish(project.id, {
      entity: "project",
      id: project.id,
      action: "updated",
    });
  }
  return {
    statuses: result.ordered.map(toStatus),
    block_clear_status_id: result.line,
  };
}

export async function createStatus(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: StatusCreateInput,
): Promise<Status> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "status.manage",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));

  await ensureNameFree(db, project.id, input.name);
  const position = input.position ?? (await nextPosition(db, project.id));
  const inserted = await db
    .insert(statuses)
    .values({
      projectId: project.id,
      name: input.name,
      category: input.category,
      color: input.color,
      position,
    })
    .returning()
    .catch((cause: unknown) => {
      if (uniqueViolation(cause) !== "statuses_project_name_idx") throw cause;
      throw statusNameTaken(input.name);
    });
  const row = inserted[0];
  if (!row) throw new Error("status insert returned no row");
  ctx.bus.publish(project.id, {
    entity: "status",
    id: row.id,
    action: "created",
  });
  return toStatus(row);
}

export async function updateStatus(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  statusId: number,
  input: StatusUpdateInput,
): Promise<Status> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "status.manage",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));

  // A name the status already has is no rename: it is left as stored.
  const changes =
    input.name !== undefined &&
    (await ensureNameFree(db, project.id, input.name, statusId))
      ? { ...input, name: undefined }
      : input;

  // An UPDATE with no assignments is a driver error, not a no-op (T-730).
  if (Object.values(changes).every((v) => v === undefined)) {
    const rows = await db
      .select()
      .from(statuses)
      .where(
        and(eq(statuses.id, statusId), eq(statuses.projectId, project.id)),
      );
    const row = rows[0];
    if (!row) throw new NotFoundError("status not found");
    return toStatus(row);
  }

  const row = await db.transaction(async (tx) => {
    if (input.is_default === true) {
      // Demoting one status and promoting another writes two, so
      // project_meta first, as every such transaction does (see
      // lockIssueRows).
      await tx
        .select({ projectId: projectMeta.projectId })
        .from(projectMeta)
        .where(eq(projectMeta.projectId, project.id))
        .for("no key update");
      // Only one default per project: becoming it demotes the previous one.
      await tx
        .update(statuses)
        .set({ isDefault: false })
        .where(
          and(
            eq(statuses.projectId, project.id),
            eq(statuses.isDefault, true),
            ne(statuses.id, statusId),
          ),
        );
    }
    const updated = await tx
      .update(statuses)
      .set({
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.position === undefined ? {} : { position: input.position }),
        ...(input.is_default === undefined
          ? {}
          : { isDefault: input.is_default }),
      })
      .where(and(eq(statuses.id, statusId), eq(statuses.projectId, project.id)))
      .returning()
      .catch((cause: unknown) => {
        // Thrown, not returned: the rollback takes the demotion above with it.
        if (
          input.name === undefined ||
          uniqueViolation(cause) !== "statuses_project_name_idx"
        ) {
          throw cause;
        }
        throw statusNameTaken(input.name);
      });
    const updatedRow = updated[0];
    if (!updatedRow) throw new NotFoundError("status not found");
    return updatedRow;
  });
  ctx.bus.publish(project.id, {
    entity: "status",
    id: row.id,
    action: "updated",
  });
  // Both halves of the clear-line rule live in this table, so both edits
  // silently move it (T-377): a reorder changes which side of
  // "at this position or past it" a card falls on, and a category change
  // moves the fallback rule that decides it when no line is configured —
  // which, with every project's line starting NULL, is the default path.
  if (input.position !== undefined || input.category !== undefined) {
    const changes = await reevaluateProjectBlocks(ctx, project, db);
    await announceBlockChanges(ctx, changes, actor.id);
  }
  return toStatus(row);
}

export async function deleteStatus(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  statusId: number,
): Promise<void> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "status.manage",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));

  const referencing = await db
    .select({ n: count() })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.statusId, statusId)),
    );
  if ((referencing[0]?.n ?? 0) > 0) {
    throw new ConflictError(
      "status is used by existing issues — move them to another status first",
    );
  }
  const lineChanged = await db.transaction(async (tx) => {
    // project_meta before the statuses, the order every transaction writing
    // both takes, so this one cannot wait on one waiting on it.
    const meta = await tx
      .select({ lineId: projectMeta.blockClearStatusId })
      .from(projectMeta)
      .where(eq(projectMeta.projectId, project.id))
      .for("no key update");
    const before = meta[0]?.lineId ?? null;
    let after = before;
    if (before === statusId) {
      // The line moves down rather than holding the delete up: a line nobody
      // can delete would have to be moved by hand first, which says nothing
      // the moved line does not.
      const order = await tx
        .select({ id: statuses.id })
        .from(statuses)
        .where(eq(statuses.projectId, project.id))
        .orderBy(asc(statuses.position), asc(statuses.id));
      after = lineAfterDeleting(
        order.map((row) => row.id),
        before,
        new Set([statusId]),
      );
      await tx
        .update(projectMeta)
        .set({ blockClearStatusId: after })
        .where(eq(projectMeta.projectId, project.id));
    }
    const deleted = await tx
      .delete(statuses)
      .where(and(eq(statuses.id, statusId), eq(statuses.projectId, project.id)))
      .returning({ id: statuses.id });
    if (deleted.length === 0) throw new NotFoundError("status not found");
    return after !== before;
  });
  ctx.bus.publish(project.id, {
    entity: "status",
    id: statusId,
    action: "deleted",
  });
  if (lineChanged) {
    const changes = await reevaluateProjectBlocks(ctx, project, db);
    await announceBlockChanges(ctx, changes, actor.id);
    ctx.bus.publish(project.id, {
      entity: "project",
      id: project.id,
      action: "updated",
    });
  }
}

/**
 * The name check and the write are two statements, so a concurrent create or
 * rename of the same name can still win the unique index between them; the
 * loser gets this same 409 rather than a 500.
 */
function statusNameTaken(name: string): ConflictError {
  return new ConflictError(`status "${name}" already exists`);
}

/**
 * Refuses a name another status of the project holds in any case. Says
 * whether status `exceptId` holds it already, in a spelling that
 * canonicalizes to it: that is no rename, so a twin an upgrade left beside
 * the status (see the case_insensitive_names migration) cannot block its
 * other edits.
 */
async function ensureNameFree(
  db: Db,
  projectId: number,
  name: string,
  exceptId?: number,
): Promise<boolean> {
  // Compared in JS by nameKey rather than by the database's lower(), so
  // the rule does not follow the database's locale.
  const rows = await db
    .select({ id: statuses.id, name: statuses.name })
    .from(statuses)
    .where(eq(statuses.projectId, projectId));
  if (
    rows.some(
      (r) => r.id === exceptId && canonicalizeLabelName(r.name) === name,
    )
  ) {
    return true;
  }
  const key = nameKey(name);
  if (rows.some((r) => r.id !== exceptId && nameKey(r.name) === key)) {
    throw statusNameTaken(name);
  }
  return false;
}

async function nextPosition(db: Db, projectId: number): Promise<number> {
  const rows = await db
    .select({ position: statuses.position })
    .from(statuses)
    .where(eq(statuses.projectId, projectId));
  const next = rows.reduce((max, r) => Math.max(max, r.position + 1), 0);
  if (next > INT4_MAX) {
    throw new ConflictError(
      "a status already holds the highest position; pass position explicitly",
    );
  }
  return next;
}
