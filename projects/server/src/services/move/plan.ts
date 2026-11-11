import type { UserRef } from "@todou/shared";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { UserRow } from "../../auth/pat.ts";
import type { AppContext } from "../../bootstrap.ts";
import type { Db } from "../../db/driver.ts";
import {
  issueAssignees,
  issueLabels,
  type issues,
  labels,
  statuses,
} from "../../db/project-schema.ts";
import {
  issueMoves,
  projectMembers,
  projects,
} from "../../db/system-schema.ts";
import {
  IssueDeletedError,
  IssueMovedError,
  IssueMovingError,
  ValidationFailedError,
} from "../../errors.ts";
import { type ProjectRow, requireCapability, routeInfoOf } from "../access.ts";
import { loadIssueRow } from "../issues.ts";
import { lineageOf, movedInHistory, tombstoneNumberOf } from "../relocation.ts";
import { assertIssueWritable } from "../trash.ts";
import { getUserRefs } from "../users.ts";

type IssueRow = typeof issues.$inferSelect;
type StatusRow = typeof statuses.$inferSelect;

export type MovePlan = {
  source: { project: ProjectRow; db: Db };
  target: { project: ProjectRow; db: Db };
  row: IssueRow;
  status: { from: StatusRow; to: StatusRow };
  labelIds: number[];
  assigneeIds: number[];
  dropped: { labels: string[]; assignees: UserRef[] };
  /** The number a tombstone still holds in the target; null = take a new one. */
  reinhabit: number | null;
  lineage: number | null;
  /**
   * One timestamp for the whole move: the freeze, the tombstone and both
   * timeline events. Shared so the recovery sweep can prove a freeze is the
   * one its own registration row started.
   */
  movedAt: Date;
  /**
   * Both projects' tables share a database, so the source attachment rows
   * must go before the copies land — `attachments_storage_key_idx` is unique
   * per database and the copy keeps the key.
   */
  sameProjectDb: boolean;
  /** …and the system tables are in there too, so one transaction covers all. */
  systemColocated: boolean;
};

/**
 * Everything decided before anything is written: permissions, the conflicts
 * that refuse the move, the field mapping, whether a tombstone is being
 * moved back into, and which of the two execution paths applies.
 *
 * `dry_run` returns after exactly this, which is the only way a preview can
 * be trusted to match what the move will do.
 */
export async function planMove(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
  toSlug: string,
): Promise<MovePlan> {
  const { project: source, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "issue.move",
  );
  const sourceDb = await ctx.router.forProject(routeInfoOf(source));
  const row = await loadIssueRow(sourceDb, source.id, number);
  // Trash, tombstone and freeze all refuse here, with their own codes.
  assertIssueWritable(row, actor, role);
  await assertArrived({ source: sourceDb, system: ctx.router.system() }, row);

  // A project the mover cannot see is a 404 from here, same as anywhere.
  const { project: target } = await requireCapability(
    ctx,
    actor,
    toSlug,
    "issue.move_in",
  );
  if (target.id === source.id) {
    throw new ValidationFailedError("that issue is already in this project");
  }
  const targetDb = await ctx.router.forProject(routeInfoOf(target));

  const status = await mapStatus(sourceDb, targetDb, source.id, target.id, row);
  const labelMap = await mapLabels(sourceDb, targetDb, target.id, row);
  const assigneeMap = await mapAssignees(
    ctx.router.system(),
    sourceDb,
    target.id,
    row,
  );

  const { lineage, reinhabit } = await addressPlan(
    ctx.router.system(),
    { projectId: source.id, number },
    target.id,
  );

  // Two independent questions. Collapsing them into one would misjudge the
  // deployment where A and B share a dedicated database while the system
  // tables live elsewhere: that needs the protocol, but it also needs the
  // source attachment rows deleted before the copies go in.
  const sourceUrl = ctx.router.resolveProjectUrl(routeInfoOf(source));
  const targetUrl = ctx.router.resolveProjectUrl(routeInfoOf(target));
  const systemUrl = ctx.router.systemHandle().url;

  return {
    source: { project: source, db: sourceDb },
    target: { project: target, db: targetDb },
    row,
    status,
    labelIds: labelMap.ids,
    assigneeIds: assigneeMap.ids,
    dropped: { labels: labelMap.dropped, assignees: assigneeMap.dropped },
    reinhabit,
    lineage,
    movedAt: new Date(),
    sameProjectDb: sourceUrl === targetUrl,
    systemColocated: sourceUrl === systemUrl && targetUrl === systemUrl,
  };
}

/**
 * `planMove` reads the card before anything holds it, so a second move or
 * the trash that committed in between has to be answered again once the
 * move does hold it (T-666). The refusals are `planMove`'s own: the mover is
 * the author or an admin, so a trashed card is one they see.
 */
export function assertStillMovable(row: IssueRow): void {
  if (row.movedAt !== null) throw new IssueMovedError(row, true, true);
  if (row.movingSince !== null) throw new IssueMovingError();
  if (row.deletedAt !== null) throw new IssueDeletedError();
}

/**
 * The plan decided again from the held row. The row-derived half, because
 * that row is what gets copied: an edit that committed after `planMove`
 * read the card would otherwise be dropped by the copy, or carry the status
 * and labels it had before. The address half, because a card that moved
 * away and back after the plan left a tombstone in the target the plan
 * never saw; held and arrived, the card's addresses cannot change any more.
 * Each handle has to be the one the caller holds the card through — a
 * colocated move passes its transaction for all three.
 *
 * The arrival is asked again too. A card that moved away after the plan
 * and is on its way back into the same row started an arrival the plan
 * never saw; once the card is held and that arrival is done, no other move
 * can start one.
 */
export async function replanHeld(
  plan: MovePlan,
  row: IssueRow,
  handles: { source: Db; target: Db; system: Db },
): Promise<MovePlan> {
  await assertArrived(handles, row);
  const { lineage, reinhabit } = await addressPlan(
    handles.system,
    { projectId: plan.source.project.id, number: row.number },
    plan.target.project.id,
  );
  const status = await mapStatus(
    handles.source,
    handles.target,
    plan.source.project.id,
    plan.target.project.id,
    row,
  );
  const labelMap = await mapLabels(
    handles.source,
    handles.target,
    plan.target.project.id,
    row,
  );
  const assigneeMap = await mapAssignees(
    handles.system,
    handles.source,
    plan.target.project.id,
    row,
  );
  return {
    ...plan,
    row,
    status,
    labelIds: labelMap.ids,
    assigneeIds: assigneeMap.ids,
    dropped: { labels: labelMap.dropped, assignees: assigneeMap.dropped },
    reinhabit,
    lineage,
  };
}

/**
 * The card's lineage, if it has ever moved, and the number its tombstone
 * still holds in the target, which a card moving back takes again.
 */
async function addressPlan(
  system: Db,
  source: { projectId: number; number: number },
  targetId: number,
): Promise<{ lineage: number | null; reinhabit: number | null }> {
  const lineage = await lineageOf(system, source.projectId, source.number);
  const reinhabit =
    lineage === null
      ? null
      : await tombstoneNumberOf(system, lineage, targetId);
  return { lineage, reinhabit };
}

/**
 * Refuses a card that is still arriving from a move across databases. Its
 * copy is a live card from step 3, but the address book learns of it at
 * step 4 and its source becomes a tombstone at step 5; a move planned in
 * between reads neither, and splits the lineage, wedges on the address
 * book's unique keys, or moves back into a source that is about to be
 * emptied.
 *
 * Still arriving: the card's latest `moved_in` names a registration row
 * that is not done and whose source project still exists.
 * - The latest is the one with the highest id, written after the copy of
 *   the card's history in the same transaction. Only it can still be in
 *   flight, since this check keeps a card from moving on before it has
 *   arrived; an earlier one left unfinished by the races this check closes
 *   would otherwise pin the card for good.
 * - The copy and its `moved_in` commit together, and the row is registered
 *   at step 1 and done only at step 6, so the whole gap counts.
 * - A move within one database writes its `moved_in` and a done row in one
 *   transaction.
 * - A token with no row counts as arrived. A row is deleted only before its
 *   copy should have landed, so such a copy landed after the sweep rolled
 *   its move back, and refusing it would pin it for good.
 * - A row whose source project is gone counts as arrived. Step 5 has nowhere
 *   to write and the sweep skips the row, so it is never done; counting it
 *   would pin the copy for good. The price: while that move's own request
 *   is still between steps 3 and 4, its copy can be moved.
 */
async function assertArrived(
  handles: { source: Db; system: Db },
  row: IssueRow,
): Promise<void> {
  const [latest] = (await movedInHistory(handles.source, row.id)).sort(
    (a, b) => b.eventId - a.eventId,
  );
  const token = latest?.moveToken ?? null;
  if (token === null) return;
  const arriving = await handles.system
    .select({ id: issueMoves.id })
    .from(issueMoves)
    .innerJoin(projects, eq(projects.id, issueMoves.fromProjectId))
    .where(and(eq(issueMoves.moveToken, token), ne(issueMoves.state, "done")))
    .limit(1);
  if (arriving.length > 0) throw new IssueMovingError();
}

/**
 * The status ladder: same name, else the same category's default, else that
 * category's first by position, else the target's own default. Deterministic
 * and total — a move never fails because the target spells its columns
 * differently.
 */
async function mapStatus(
  sourceDb: Db,
  targetDb: Db,
  sourceId: number,
  targetId: number,
  row: IssueRow,
): Promise<{ from: StatusRow; to: StatusRow }> {
  const fromRows = await sourceDb
    .select()
    .from(statuses)
    .where(
      and(eq(statuses.projectId, sourceId), eq(statuses.id, row.statusId)),
    );
  const from = fromRows[0];
  if (from === undefined) throw new Error("issue has unknown status");

  const candidates = await targetDb
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, targetId))
    .orderBy(
      desc(statuses.isDefault),
      asc(statuses.position),
      asc(statuses.id),
    );
  if (candidates.length === 0) {
    throw new ValidationFailedError("the target project has no statuses");
  }

  const sameCategory = candidates.filter((s) => s.category === from.category);
  const to =
    candidates.find((s) => s.name === from.name) ??
    sameCategory.find((s) => s.isDefault) ??
    sameCategory[0] ??
    (candidates[0] as StatusRow);
  return { from, to };
}

async function mapLabels(
  sourceDb: Db,
  targetDb: Db,
  targetId: number,
  row: IssueRow,
): Promise<{ ids: number[]; dropped: string[] }> {
  const current = await sourceDb
    .select({ name: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(eq(issueLabels.issueId, row.id));
  if (current.length === 0) return { ids: [], dropped: [] };

  const names = current.map((l) => l.name);
  const matched = await targetDb
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(and(eq(labels.projectId, targetId), inArray(labels.name, names)));
  const byName = new Map(matched.map((l) => [l.name, l.id]));
  return {
    ids: names.map((n) => byName.get(n)).filter((id) => id !== undefined),
    dropped: names.filter((n) => !byName.has(n)),
  };
}

async function mapAssignees(
  system: Db,
  sourceDb: Db,
  targetId: number,
  row: IssueRow,
): Promise<{ ids: number[]; dropped: UserRef[] }> {
  const current = await sourceDb
    .select({ userId: issueAssignees.userId })
    .from(issueAssignees)
    .where(eq(issueAssignees.issueId, row.id));
  if (current.length === 0) return { ids: [], dropped: [] };

  const ids = current.map((a) => a.userId);
  const members = await system
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, targetId),
        inArray(projectMembers.userId, ids),
      ),
    );
  // Filtered, not rejected: an assignee who is not a member of the target is
  // reported as dropped rather than blocking the move.
  const keep = new Set(members.map((m) => m.userId));
  const droppedIds = ids.filter((id) => !keep.has(id));
  const refs = await getUserRefs(system, droppedIds);
  return {
    ids: ids.filter((id) => keep.has(id)),
    dropped: droppedIds.map(
      (id) =>
        refs.get(id) ?? {
          id,
          login: "ghost",
          display_name: "Deleted user",
          kind: "human" as const,
          avatar_url: null,
          owner: null,
        },
    ),
  };
}
