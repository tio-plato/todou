import { randomUUID } from "node:crypto";
import type {
  AgentContext,
  ChangeEvent,
  MoveIssueInput,
  MoveIssueResult,
} from "@todou/shared";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { UserRow } from "../../auth/pat.ts";
import type { AppContext } from "../../bootstrap.ts";
import type { Db } from "../../db/driver.ts";
import {
  issueAssignees,
  issueEvents,
  issues,
  projectMeta,
} from "../../db/project-schema.ts";
import { issueMoves, projects } from "../../db/system-schema.ts";
import { IssueMovingError, NotFoundError } from "../../errors.ts";
import { type ProjectRow, routeInfoOf } from "../access.ts";
import { markDraftAttachments } from "../attachments.ts";
import { announceBlockChanges, evaluateBlockerStatus } from "../blocks.ts";
import { getIssue } from "../issues.ts";
import { ensureLineage, recordAliases, registerMove } from "../relocation.ts";
import {
  type ActivityImportedMaxIds,
  clearIssueChildren,
  copyIssueTree,
  type IdMap,
} from "./copy.ts";
import {
  assertStillMovable,
  type MovePlan,
  planMove,
  replanHeld,
} from "./plan.ts";

/**
 * Move an issue to another project.
 *
 * Everything that can refuse the move happens in `planMove`, before a single
 * row is written — which is what lets `dry_run` promise that its preview is
 * what will actually happen. The one exception is a write that lands on the
 * card after the plan read it: both paths decide the plan again once they
 * hold the card (`replanHeld`), and the response describes that plan.
 */
export async function moveIssue(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
  input: MoveIssueInput,
  agentContext: AgentContext | null = null,
): Promise<MoveIssueResult> {
  const planned = await planMove(ctx, actor, slug, number, input.to_project);
  const mappingOf = (plan: MovePlan) => ({
    status: { from: plan.status.from.name, to: plan.status.to.name },
    dropped_labels: plan.dropped.labels,
    dropped_assignees: plan.dropped.assignees,
  });

  if (input.dry_run) {
    return {
      moved_to: {
        slug: planned.target.project.slug,
        number: planned.reinhabit,
      },
      reinhabited: planned.reinhabit !== null,
      mapping: mappingOf(planned),
      issue: null,
    };
  }
  await ctx.testHooks?.afterMovePlan?.();

  // Drafts travel with the card (T-568), and the reaper only opens projects
  // that are marked. Unconditional because the check it would replace races
  // an upload landing just before the freeze; a mark with no draft behind
  // it costs the target one visit and then clears itself.
  await markDraftAttachments(ctx, planned.target.project);

  const landed =
    planned.sameProjectDb && planned.systemColocated
      ? await moveWithinDb(actor, planned, agentContext)
      : await moveAcrossDbs(ctx, actor, planned, agentContext);
  const { plan } = landed;

  await afterCommit(ctx, plan, landed);

  // The card that landed carries the MAPPED status, and the line it is judged
  // against is the destination's — so both premises the old verdict rested on
  // are gone, and every edge this card blocks has to be re-decided here
  // (T-377). Leaving it to the hourly repair sweep would park the blocked
  // cards on a stale verdict, and the sweep has no actor of its own: the one
  // who declared the edge would be the one reader unread skips.
  const blocks = await evaluateBlockerStatus(
    ctx,
    plan.target.project,
    plan.target.db,
    [landed.number],
  );
  await announceBlockChanges(ctx, blocks, actor.id, agentContext);

  return {
    moved_to: { slug: plan.target.project.slug, number: landed.number },
    reinhabited: plan.reinhabit !== null,
    mapping: mappingOf(plan),
    // Re-read rather than assembled here, so the response goes through the
    // same redaction every other read of this card does.
    issue: await getIssue(ctx, actor, plan.target.project.slug, landed.number),
  };
}

export type Landed = {
  number: number;
  issueId: number;
  idMap: IdMap;
  movedOutEventId: number | undefined;
  movedInEventId: number | undefined;
  tombstoneId: number;
  /** The plan as decided again once the card was held. */
  plan: MovePlan;
};

/**
 * Both projects and the system tables share one database, so the whole move
 * is one transaction: no intermediate state is ever observable, and there is
 * nothing for the recovery sweep to find.
 */
async function moveWithinDb(
  actor: UserRow,
  planned: MovePlan,
  agentContext: AgentContext | null,
): Promise<Landed> {
  const db = planned.source.db;
  const moveToken = randomUUID();

  return db.transaction(async (tx) => {
    // Pins the row for the whole move. Reference recording locks the same
    // row (see lockIssueRows), so an event cannot land on the card between
    // the copy and the cleanup that would delete it. A competing move or
    // trash that committed while this waited is visible in the row the
    // lock returns.
    const [held] = await tx
      .select()
      .from(issues)
      .where(eq(issues.id, planned.row.id))
      .for("update");
    if (held === undefined) throw new NotFoundError("issue not found");
    assertStillMovable(held);
    const plan = await replanHeld(planned, held, {
      source: tx,
      target: tx,
      system: tx,
    });

    const number =
      plan.reinhabit ?? (await nextNumber(tx, plan.target.project.id));
    // The system tables are in this database too — that is what
    // `systemColocated` means — so they join the transaction through `tx`.
    // Reaching for `router.system()` here would take a second connection and
    // block on the row this transaction has already locked.
    const lineage = await registerMove(tx, {
      lineage: plan.lineage,
      from: { projectId: plan.source.project.id, number: plan.row.number },
      to: { projectId: plan.target.project.id, number },
    });
    const idMap = await copyIssueTree(tx, tx, plan, {
      number,
      reinhabit: plan.reinhabit !== null,
    });
    const movedInEventId = await writeMovedIn(
      tx,
      plan,
      { number, issueId: idMap.issueId },
      idMap,
      moveToken,
      actor,
      agentContext,
      lineage,
    );

    const heldBy = await sourceAssigneeIds(tx, plan.row.id);
    await clearIssueChildren(tx, plan.row.id);
    await raiseTombstone(tx, plan);
    const movedOutEventId = await writeMovedOut(
      tx,
      plan,
      number,
      moveToken,
      actor,
      agentContext,
      heldBy,
    );

    await recordAllAliases(tx, plan, idMap);
    await tx.insert(issueMoves).values({
      lineage,
      moveToken,
      fromProjectId: plan.source.project.id,
      fromNumber: plan.row.number,
      toProjectId: plan.target.project.id,
      toNumber: number,
      actorId: actor.id,
      movedAt: plan.movedAt,
      state: "done",
      finishedAt: new Date(),
    });

    return {
      number,
      issueId: idMap.issueId,
      idMap,
      movedOutEventId,
      movedInEventId,
      tombstoneId: plan.row.id,
      plan,
    };
  });
}

/**
 * How long a lease on a registration row lasts unless renewed. A mover
 * renews its own every fifth of this for as long as it runs.
 */
export const MOVE_LEASE_MS = 5 * 60 * 1000;

const leaseMs = (ctx: AppContext): number =>
  ctx.testHooks?.moveLeaseMs ?? MOVE_LEASE_MS;

/** When a lease taken or renewed at `now` runs out. */
const leaseUntil = (ctx: AppContext, now: Date = new Date()): Date =>
  new Date(now.getTime() + leaseMs(ctx));

/**
 * Renews the mover's lease until the returned function is called. A
 * renewal that fails is logged and the next one tries again; one that finds
 * the row taken over changes nothing, since it names the mover.
 */
function renewLease(ctx: AppContext, moveToken: string): () => void {
  const system = ctx.router.system();
  const renew = async () => {
    try {
      await system
        .update(issueMoves)
        .set({ leasedUntil: leaseUntil(ctx) })
        .where(
          and(
            eq(issueMoves.moveToken, moveToken),
            eq(issueMoves.leasedBy, moveToken),
          ),
        );
    } catch (err) {
      console.error(`renewing the lease on move ${moveToken} failed`, err);
    }
  };
  const timer = setInterval(() => void renew(), leaseMs(ctx) / 5);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Gives up `holder`'s lease, so the next sweep takes the row at once rather
 * than when the lease runs out. A lease someone else holds by now is left
 * alone. Failing is logged, never thrown: the lease still runs out.
 */
async function releaseLease(
  system: Db,
  moveToken: string,
  holder: string,
): Promise<void> {
  try {
    await system
      .update(issueMoves)
      .set({ leasedBy: null, leasedUntil: null })
      .where(
        and(
          eq(issueMoves.moveToken, moveToken),
          eq(issueMoves.leasedBy, holder),
        ),
      );
  } catch (err) {
    console.error(`releasing the lease on move ${moveToken} failed`, err);
  }
}

/**
 * Two databases, so no transaction covers the whole move. The registration
 * row in `issue_moves` is the coordinator instead: its `state` is the only
 * truth about how far the move got, and every step is replayable, so a
 * crash anywhere is finished by `sweepMoves` rather than left half-done.
 * The row also carries a lease, which this move takes at step 1 and renews
 * until it ends: the sweep takes over only a row whose lease ran out or was
 * given up, never a move that is still running.
 *
 * Step 4 is the commit point — before it the card is still at its old
 * address, after it every link resolves to the new one.
 */
async function moveAcrossDbs(
  ctx: AppContext,
  actor: UserRow,
  planned: MovePlan,
  agentContext: AgentContext | null,
): Promise<Landed> {
  let plan = planned;
  const system = ctx.router.system();
  const moveToken = randomUUID();
  const step = async (n: 1 | 2 | 3 | 4 | 5 | 6) =>
    ctx.testHooks?.afterMoveStep?.(n);

  // 1. Register, so a crash from here on is something the sweep can find.
  // The lease is there from the first moment the sweep can see the row.
  await system.insert(issueMoves).values({
    lineage: plan.lineage,
    moveToken,
    fromProjectId: plan.source.project.id,
    fromNumber: plan.row.number,
    toProjectId: plan.target.project.id,
    actorId: actor.id,
    movedAt: plan.movedAt,
    state: "copying",
    leasedBy: moveToken,
    leasedUntil: leaseUntil(ctx),
  });
  const stopRenewing = renewLease(ctx, moveToken);
  try {
    await step(1);

    // 2. Freeze the source. Reads carry on; writes get a 409 until this ends.
    const frozen = await plan.source.db
      .update(issues)
      .set({ movingSince: plan.movedAt })
      .where(
        and(
          eq(issues.id, plan.row.id),
          isNull(issues.movingSince),
          isNull(issues.movedAt),
          // The trash's own write is guarded the same way, so exactly one of
          // the two lands (T-666).
          isNull(issues.deletedAt),
        ),
      )
      .returning();
    const held = frozen[0];
    if (held === undefined) {
      // Another move or the trash got there first. The registration row has
      // to go before the 409, or the sweep would later thaw a freeze that is
      // not ours.
      await system
        .delete(issueMoves)
        .where(eq(issueMoves.moveToken, moveToken));
      const [now] = await plan.source.db
        .select()
        .from(issues)
        .where(eq(issues.id, plan.row.id));
      if (now === undefined) throw new NotFoundError("issue not found");
      assertStillMovable(now);
      throw new IssueMovingError();
    }
    // The freeze's predicate already re-asked what `assertStillMovable` asks.
    try {
      plan = await replanHeld(plan, held, {
        source: plan.source.db,
        target: plan.target.db,
        system,
      });
    } catch (err) {
      // Nothing was copied yet, so this is the sweep's rollback done now
      // rather than an hour from now.
      await plan.source.db
        .update(issues)
        .set({ movingSince: null })
        .where(
          and(eq(issues.id, plan.row.id), eq(issues.movingSince, plan.movedAt)),
        );
      await system
        .delete(issueMoves)
        .where(eq(issueMoves.moveToken, moveToken));
      throw err;
    }
    await step(2);

    // 3. The whole copy, in one transaction in the destination.
    const copied = await copyInDestination(
      ctx,
      plan,
      actor,
      agentContext,
      moveToken,
    );
    await step(3);

    // 4. Publish it: the address book and the aliases. Commit point.
    await finishCopying(ctx, plan, copied, moveToken);
    await step(4);

    // 5. Empty the source and raise the tombstone.
    await retireSource(plan, copied, moveToken, actor, agentContext);
    await step(5);

    // 6. Nothing left for the sweep to do.
    await markDone(system, moveToken);
    await step(6);

    return {
      number: copied.number,
      issueId: copied.idMap.issueId,
      idMap: copied.idMap,
      movedOutEventId: undefined,
      movedInEventId: copied.movedInEventId,
      tombstoneId: plan.row.id,
      plan,
    };
  } catch (err) {
    // Whatever this move left unfinished is the next sweep's at once,
    // rather than when the lease runs out.
    await releaseLease(system, moveToken, moveToken);
    throw err;
  } finally {
    stopRenewing();
  }
}

type Copied = {
  number: number;
  idMap: IdMap;
  movedInEventId: number | undefined;
};

async function copyInDestination(
  ctx: AppContext,
  plan: MovePlan,
  actor: UserRow,
  agentContext: AgentContext | null,
  moveToken: string,
): Promise<Copied> {
  const lineage =
    plan.lineage ??
    // Minted here rather than at step 4 because the `moved_in` payload
    // carries it, and that event is written inside this transaction.
    (await registerLineageOnly(ctx, plan));

  return plan.target.db.transaction(async (tx) => {
    if (plan.sameProjectDb) {
      // The copy deletes the source card's attachment rows below, so it
      // locks that card first, as the last step does (see retireSource).
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, plan.row.id))
        .for("update");
    }
    const number =
      plan.reinhabit ?? (await nextNumber(tx, plan.target.project.id));
    // When both projects live in one database the source has to be read
    // through this transaction as well. Reaching for the outer handle would
    // block on the transaction that is waiting for the read — and it is the
    // same database, so the source attachment delete belongs in here anyway.
    const src = plan.sameProjectDb ? tx : plan.source.db;
    const idMap = await copyIssueTree(src, tx, plan, {
      number,
      reinhabit: plan.reinhabit !== null,
    });
    const movedInEventId = await writeMovedIn(
      tx,
      plan,
      { number, issueId: idMap.issueId },
      idMap,
      moveToken,
      actor,
      agentContext,
      lineage,
    );
    return { number, idMap, movedInEventId };
  });
}

/**
 * The lineage alone, without flattening anything onto an address that does
 * not exist yet — step 4 does that once the copy has actually landed.
 */
async function registerLineageOnly(
  ctx: AppContext,
  plan: MovePlan,
): Promise<number> {
  const source = { projectId: plan.source.project.id, number: plan.row.number };
  return ctx.router
    .system()
    .transaction((tx) => ensureLineage(tx, source, source));
}

/** Step 4: the redirects start working here. */
async function finishCopying(
  ctx: AppContext,
  plan: MovePlan,
  copied: Copied,
  moveToken: string,
): Promise<void> {
  const system = ctx.router.system();
  await registerMove(system, {
    lineage: plan.lineage,
    from: { projectId: plan.source.project.id, number: plan.row.number },
    to: { projectId: plan.target.project.id, number: copied.number },
  });
  await recordAllAliases(system, plan, copied.idMap);
  await system
    .update(issueMoves)
    .set({ state: "copied", toNumber: copied.number })
    .where(eq(issueMoves.moveToken, moveToken));
}

/**
 * Step 5: replayable, because the sweep may run it again.
 *
 * The card before anything under it, like every write (see lockIssueRows): a
 * write holding the card while it attaches a draft there finishes first, and
 * one that comes after finds the card gone.
 */
async function retireSource(
  plan: MovePlan,
  copied: Copied,
  moveToken: string,
  actor: UserRow,
  agentContext: AgentContext | null,
): Promise<void> {
  await plan.source.db.transaction(async (tx) => {
    await tx
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, plan.row.id))
      .for("update");
    // Read here rather than taken from the plan: a recovered plan carries
    // no assignees, while the source still holds them until the clear below.
    const heldBy = await sourceAssigneeIds(tx, plan.row.id);
    await clearIssueChildren(tx, plan.row.id);
    await raiseTombstone(tx, plan);
    // `move_token` carries no unique index, and this step is replayed, so
    // the guard is what keeps the source's one remaining trace from
    // becoming two.
    await tx.execute(sql`
      insert into issue_events
        (project_id, issue_id, actor_id, type, payload, agent_context,
         created_at)
      select ${plan.source.project.id}, ${plan.row.id}, ${actor.id},
             'moved_out', ${JSON.stringify({
               move_token: moveToken,
               to_project_id: plan.target.project.id,
               to_project: plan.target.project.slug,
               to_number: copied.number,
               assignee_ids: heldBy,
             })}::jsonb,
             ${agentContext === null ? null : JSON.stringify(agentContext)}::jsonb,
             ${plan.movedAt.toISOString()}::timestamptz
      where not exists (
        select 1 from issue_events
        where issue_id = ${plan.row.id}
          and type = 'moved_out'
          and payload ->> 'move_token' = ${moveToken}
      )
    `);
  });
}

async function markDone(system: Db, moveToken: string): Promise<void> {
  await system
    .update(issueMoves)
    .set({ state: "done", finishedAt: new Date() })
    .where(eq(issueMoves.moveToken, moveToken));
}

/**
 * Drive every unfinished cross-database move whose lease has run out, or
 * was given up, to a conclusion. `now` is the time leases are judged at.
 *
 * Safe to run concurrently from several instances and safe to replay, which
 * `housekeeping.ts` requires of everything it sweeps. Three things buy that:
 * the lease on the registration row, the `NOT EXISTS` guard on `moved_out`,
 * and thawing a freeze only when it still carries this row's own `moved_at`.
 *
 * The lease keeps the sweep off a move that is still running and keeps two
 * sweeps off one row. A mover holds it from step 1 to its end, renewing it
 * all along; a sweep claims a row with one conditional UPDATE, which a
 * second instance's identical UPDATE re-reads once this one commits, and
 * finds the lease taken. `moved_out` carries no unique index, so its
 * `NOT EXISTS` guard alone would not stop two replays of step 5.
 *
 * The recovery itself runs outside any transaction. A transaction held
 * across it would wait on its own statements wherever a project's database
 * is the system database on PGlite, whose one connection is the whole
 * process.
 */
export async function sweepMoves(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<number> {
  const system = ctx.router.system();
  // `IN` rather than `<> 'done'`: done rows are never deleted, and only this
  // form can use `issue_moves_state_idx`.
  const unfinished = inArray(issueMoves.state, ["copying", "copied"]);
  const pending = await system
    .select({ id: issueMoves.id })
    .from(issueMoves)
    .where(unfinished);
  let finished = 0;

  for (const { id } of pending) {
    const holder = randomUUID();
    let claimed: typeof issueMoves.$inferSelect | undefined;
    try {
      [claimed] = await system
        .update(issueMoves)
        .set({ leasedBy: holder, leasedUntil: leaseUntil(ctx, now) })
        .where(
          and(
            eq(issueMoves.id, id),
            unfinished,
            or(isNull(issueMoves.leasedUntil), lt(issueMoves.leasedUntil, now)),
          ),
        )
        .returning();
      if (claimed === undefined) continue;
      if (await recoverOne(ctx, claimed, holder)) finished += 1;
    } catch (err) {
      console.error(`recovering move ${claimed?.moveToken ?? id} failed`, err);
      if (claimed !== undefined) {
        await releaseLease(system, claimed.moveToken, holder);
      }
    }
  }
  return finished;
}

/** `row` as claimed under `holder`'s lease. */
async function recoverOne(
  ctx: AppContext,
  row: typeof issueMoves.$inferSelect,
  holder: string,
): Promise<boolean> {
  const system = ctx.router.system();
  const source = await projectRowById(system, row.fromProjectId);
  const target = await projectRowById(system, row.toProjectId);
  if (source === undefined || target === undefined) return false;

  const sourceDb = await ctx.router.forProject(routeInfoOf(source));
  const targetDb = await ctx.router.forProject(routeInfoOf(target));
  const landedEvent = await findMovedIn(targetDb, target.id, row.moveToken);

  if (row.state === "copying" && landedEvent === null) {
    // The copy never landed: unfreeze the source and forget the move. The
    // `moving_since` check is what stops this from thawing a later attempt
    // that has since frozen the same card.
    await sourceDb
      .update(issues)
      .set({ movingSince: null })
      .where(
        and(
          eq(issues.projectId, source.id),
          eq(issues.number, row.fromNumber),
          eq(issues.movingSince, row.movedAt),
        ),
      );
    await system
      .delete(issueMoves)
      .where(and(eq(issueMoves.id, row.id), eq(issueMoves.leasedBy, holder)));
    return true;
  }
  if (landedEvent === null) return false;

  const sourceRow = await sourceDb
    .select()
    .from(issues)
    .where(
      and(eq(issues.projectId, source.id), eq(issues.number, row.fromNumber)),
    );
  const issueRow = sourceRow[0];
  if (issueRow === undefined) return false;

  const plan = await replanFromRow(ctx, row, source, target, issueRow);
  const copied: Copied = {
    number: landedEvent.number,
    idMap: landedEvent.idMap,
    movedInEventId: undefined,
  };
  if (row.state === "copying") {
    await finishCopying(ctx, plan, copied, row.moveToken);
  }
  await retireSource(
    plan,
    copied,
    row.moveToken,
    { id: row.actorId } as UserRow,
    null,
  );
  await markDone(system, row.moveToken);
  return true;
}

/** The copy's own record of itself: its number and its id map. */
async function findMovedIn(
  db: Db,
  projectId: number,
  moveToken: string,
): Promise<{ number: number; idMap: IdMap } | null> {
  const rows = await db
    .select({
      issueId: issueEvents.issueId,
      payload: issueEvents.payload,
      number: issues.number,
    })
    .from(issueEvents)
    .innerJoin(issues, eq(issueEvents.issueId, issues.id))
    .where(
      and(
        eq(issueEvents.projectId, projectId),
        eq(issueEvents.type, "moved_in"),
        sql`${issueEvents.payload} ->> 'move_token' = ${moveToken}`,
      ),
    );
  const row = rows[0];
  if (row === undefined) return null;
  const payload = row.payload as {
    id_map?: {
      comments?: Record<string, number>;
      attachments?: Record<string, number>;
    };
    activity_imported_max_ids?: ActivityImportedMaxIds;
  };
  const toMap = (raw: Record<string, number> | undefined) =>
    new Map(Object.entries(raw ?? {}).map(([k, v]) => [Number(k), v]));
  return {
    number: row.number,
    idMap: {
      issueId: row.issueId,
      comments: toMap(payload.id_map?.comments),
      attachments: toMap(payload.id_map?.attachments),
      // Recovery must reuse the committed copy boundary, even if new
      // destination activity has arrived since the move was interrupted.
      // Do not turn a legacy missing field into three null maxima.
      ...(Object.hasOwn(payload, "activity_imported_max_ids")
        ? { activityImportedMaxIds: payload.activity_imported_max_ids }
        : {}),
    },
  };
}

/**
 * Enough of a plan to finish a move nobody is holding in memory any more.
 * Only the fields the remaining steps read are filled; the mapping decisions
 * were made and applied before the crash.
 */
async function replanFromRow(
  ctx: AppContext,
  row: typeof issueMoves.$inferSelect,
  source: ProjectRow,
  target: ProjectRow,
  issueRow: typeof issues.$inferSelect,
): Promise<MovePlan> {
  const sourceDb = await ctx.router.forProject(routeInfoOf(source));
  const targetDb = await ctx.router.forProject(routeInfoOf(target));
  const sourceUrl = ctx.router.resolveProjectUrl(routeInfoOf(source));
  const targetUrl = ctx.router.resolveProjectUrl(routeInfoOf(target));
  const placeholder = {
    id: issueRow.statusId,
    name: "",
    category: "open" as const,
    color: "#000000",
    position: 0,
    isDefault: false,
    projectId: source.id,
  };
  return {
    source: { project: source, db: sourceDb },
    target: { project: target, db: targetDb },
    row: issueRow,
    status: { from: placeholder, to: placeholder },
    labelIds: [],
    assigneeIds: [],
    dropped: { labels: [], assignees: [] },
    reinhabit: row.toNumber,
    lineage: row.lineage,
    movedAt: row.movedAt,
    sameProjectDb: sourceUrl === targetUrl,
    systemColocated: false,
  };
}

async function projectRowById(
  system: Db,
  id: number,
): Promise<ProjectRow | undefined> {
  const rows = await system.select().from(projects).where(eq(projects.id, id));
  return rows[0];
}

async function nextNumber(tx: Db, projectId: number): Promise<number> {
  const meta = await tx
    .update(projectMeta)
    .set({ nextIssueNumber: sql`${projectMeta.nextIssueNumber} + 1` })
    .where(eq(projectMeta.projectId, projectId))
    .returning({ next: projectMeta.nextIssueNumber });
  const next = meta[0]?.next;
  if (next === undefined) throw new Error("project_meta row missing");
  return next - 1;
}

/**
 * The source row, emptied. The title stays: it is what the 410 body and the
 * activity stream's one remaining line have to show.
 */
async function raiseTombstone(tx: Db, plan: MovePlan): Promise<void> {
  await tx
    .update(issues)
    .set({
      movedAt: plan.movedAt,
      movingSince: null,
      // A tombstone is never in the trash: restoring refuses one, so a mark
      // left from before the move could never be taken off again.
      deletedAt: null,
      deletedBy: null,
      body: "",
      openQuestions: 0,
      specVersion: null,
      specReviewStatus: null,
      specUnresolvedComments: 0,
    })
    .where(eq(issues.id, plan.row.id));
}

async function writeMovedIn(
  tx: Db,
  plan: MovePlan,
  landed: { number: number; issueId: number },
  idMap: IdMap,
  moveToken: string,
  actor: UserRow,
  agentContext: AgentContext | null,
  lineage: number,
): Promise<number | undefined> {
  const inserted = await tx
    .insert(issueEvents)
    .values({
      projectId: plan.target.project.id,
      issueId: landed.issueId,
      actorId: actor.id,
      type: "moved_in",
      createdAt: plan.movedAt,
      agentContext,
      payload: {
        move_token: moveToken,
        lineage,
        from_project_id: plan.source.project.id,
        from_project: plan.source.project.slug,
        from_number: plan.row.number,
        status_from: plan.status.from.name,
        status_to: plan.status.to.name,
        dropped_labels: plan.dropped.labels,
        dropped_assignees: plan.dropped.assignees.map((u) => u.login),
        // Server-side only, stripped from every response: across databases
        // this is the sole durable record of which copy became which, and
        // the recovery sweep has nothing else to reconstruct it from.
        id_map: {
          comments: Object.fromEntries(idMap.comments),
          attachments: Object.fromEntries(idMap.attachments),
        },
        ...(idMap.activityImportedMaxIds === undefined
          ? {}
          : { activity_imported_max_ids: idMap.activityImportedMaxIds }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: explicit created_at
    } as any)
    .returning({ id: issueEvents.id });
  return inserted[0]?.id;
}

/**
 * Who held the card before the move, every one of them — the plan's list is
 * already narrowed to the target's members. The tombstone keeps no assignee
 * rows and no assignment events, so `moved_out` is the only place left to
 * say whose card left (T-576: a scoped watch reads it from there).
 */
async function sourceAssigneeIds(tx: Db, issueId: number): Promise<number[]> {
  const rows = await tx
    .select({ userId: issueAssignees.userId })
    .from(issueAssignees)
    .where(eq(issueAssignees.issueId, issueId));
  return rows.map((row) => row.userId).sort((a, b) => a - b);
}

async function writeMovedOut(
  tx: Db,
  plan: MovePlan,
  number: number,
  moveToken: string,
  actor: UserRow,
  agentContext: AgentContext | null,
  heldBy: number[],
): Promise<number | undefined> {
  const inserted = await tx
    .insert(issueEvents)
    .values({
      projectId: plan.source.project.id,
      issueId: plan.row.id,
      actorId: actor.id,
      type: "moved_out",
      createdAt: plan.movedAt,
      agentContext,
      payload: {
        move_token: moveToken,
        to_project_id: plan.target.project.id,
        to_project: plan.target.project.slug,
        to_number: number,
        assignee_ids: heldBy,
      },
      // biome-ignore lint/suspicious/noExplicitAny: explicit created_at
    } as any)
    .returning({ id: issueEvents.id });
  return inserted[0]?.id;
}

/** Both alias kinds, from one id map. */
async function recordAllAliases(
  system: Db,
  plan: MovePlan,
  idMap: IdMap,
): Promise<void> {
  for (const [kind, map] of [
    ["comment", idMap.comments],
    ["attachment", idMap.attachments],
  ] as const) {
    await recordAliases(
      system,
      kind,
      [...map].map(([fromId, toId]) => ({ fromId, toId })),
      { projectId: plan.source.project.id },
      { projectId: plan.target.project.id },
    );
  }
}

/**
 * The SSE announcements, which must not hold the move open.
 *
 * A move used to rewrite the card's text and every reference event pointing
 * at it, here, in the source and in any third project. None of that survives
 * T-266: the text carries permanent addresses, and an event names the
 * referring project by an id no move changes. What is left is telling
 * subscribers where the card went.
 */
async function afterCommit(
  ctx: AppContext,
  plan: MovePlan,
  landed: Landed,
): Promise<void> {
  const events: Array<[number, ChangeEvent]> = [
    [
      plan.source.project.id,
      {
        entity: "issue",
        id: landed.tombstoneId,
        action: "deleted",
        issue_number: plan.row.number,
        // It left this project's lists; where it went is the target
        // project's own event to announce (T-279).
        list_row: { kind: "gone" },
      },
    ],
    [
      plan.target.project.id,
      {
        entity: "issue",
        id: landed.issueId,
        action: "created",
        issue_number: landed.number,
        // The mapped fields the plan settled on, in the target's own id
        // space — the same values the copy just wrote.
        list_row: {
          kind: "fields",
          status_id: plan.status.to.id,
          label_ids: plan.labelIds,
          assignee_ids: plan.assigneeIds,
        },
      },
    ],
  ];
  if (landed.movedOutEventId !== undefined) {
    events.push([
      plan.source.project.id,
      {
        entity: "timeline",
        id: landed.movedOutEventId,
        action: "created",
        issue_number: plan.row.number,
      },
    ]);
  }
  if (landed.movedInEventId !== undefined) {
    events.push([
      plan.target.project.id,
      {
        entity: "timeline",
        id: landed.movedInEventId,
        action: "created",
        issue_number: landed.number,
      },
    ]);
  }
  for (const [projectId, event] of events) ctx.bus.publish(projectId, event);
}
