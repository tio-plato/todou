import { randomUUID } from "node:crypto";
import { and, eq, inArray, max, ne, or } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/driver.ts";
import {
  comments,
  issueEvents,
  issues,
  projectMeta,
  revisions,
  statuses,
} from "../src/db/project-schema.ts";
import {
  issueAddresses,
  issueMoves,
  projects,
  users,
} from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { startHousekeeping } from "../src/services/housekeeping.ts";
import type { ActivityImportedMaxIds } from "../src/services/move/copy.ts";
import { sweepMoves } from "../src/services/move/execute.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;
type Step = 1 | 2 | 3 | 4 | 5 | 6;
type MovedInEvent = typeof issueEvents.$inferSelect & {
  payload: Record<string, unknown> & {
    activity_imported_max_ids?: ActivityImportedMaxIds;
  };
};

const movedInFor = async (db: Db, projectId: number): Promise<MovedInEvent> => {
  const rows = await db
    .select()
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.projectId, projectId),
        eq(issueEvents.type, "moved_in"),
      ),
    );
  expect(rows).toHaveLength(1);
  const row = rows[0] as typeof issueEvents.$inferSelect;
  return { ...row, payload: row.payload as MovedInEvent["payload"] };
};

/** Read the copied rows independently of the boundary stored in moved_in. */
const copiedActivityMaxIds = async (
  db: Db,
  projectId: number,
  issueId: number,
): Promise<ActivityImportedMaxIds> => {
  const [events, copiedComments, copiedRevisions] = await Promise.all([
    db
      .select({ id: max(issueEvents.id) })
      .from(issueEvents)
      .where(
        and(eq(issueEvents.issueId, issueId), ne(issueEvents.type, "moved_in")),
      ),
    db
      .select({ id: max(comments.id) })
      .from(comments)
      .where(eq(comments.issueId, issueId)),
    db
      .select({ id: max(revisions.id) })
      .from(revisions)
      .where(
        and(
          eq(revisions.projectId, projectId),
          or(
            and(
              eq(revisions.subjectType, "issue_body"),
              eq(revisions.subjectId, issueId),
            ),
            and(
              eq(revisions.subjectType, "comment"),
              inArray(
                revisions.subjectId,
                db
                  .select({ id: comments.id })
                  .from(comments)
                  .where(eq(comments.issueId, issueId)),
              ),
            ),
          ),
        ),
      ),
  ]);
  return {
    v: 1,
    events: events[0]?.id ?? null,
    comments: copiedComments[0]?.id ?? null,
    revisions: copiedRevisions[0]?.id ?? null,
  };
};

/** Direct rows also let us exercise the unpublished copy after step 3. */
const addActivity = async (db: Db, projectId: number, issueId: number) => {
  const [issue] = await db
    .select({ authorId: issues.authorId })
    .from(issues)
    .where(eq(issues.id, issueId));
  const actorId = issue?.authorId as number;
  const [event] = await db
    .insert(issueEvents)
    .values({
      projectId,
      issueId,
      actorId,
      type: "title_changed",
      payload: { from: "before", to: "after" },
    })
    .returning({ id: issueEvents.id });
  const [comment] = await db
    .insert(comments)
    .values({ projectId, issueId, authorId: actorId, body: "activity" })
    .returning({ id: comments.id });
  const addedRevisions = await db
    .insert(revisions)
    .values([
      {
        projectId,
        subjectType: "issue_body",
        subjectId: issueId,
        actorId,
        body: "previous body",
      },
      {
        projectId,
        subjectType: "comment",
        subjectId: comment?.id as number,
        actorId,
        body: "first comment body",
      },
      {
        projectId,
        subjectType: "comment",
        subjectId: comment?.id as number,
        actorId,
        body: "second comment body",
      },
    ])
    .returning({ id: revisions.id });
  return {
    events: event?.id as number,
    comments: comment?.id as number,
    revisions: Math.max(...addedRevisions.map((row) => row.id)),
  };
};

const expectPreservedAcrossSweeps = async (
  t: TestApp,
  db: Db,
  projectId: number,
  committed: MovedInEvent,
  firstSweep = 1,
) => {
  const boundary = committed.payload.activity_imported_max_ids;
  for (const recovered of [firstSweep, 0, 0]) {
    const later = await addActivity(db, projectId, committed.issueId);
    for (const kind of ["events", "comments", "revisions"] as const) {
      expect(later[kind]).toBeGreaterThan(boundary?.[kind] ?? 0);
    }
    expect(later.events).toBeGreaterThan(committed.id);
    expect(await sweepMoves(t.ctx)).toBe(recovered);
    // Exact equality checks all three values, null keys, legacy absence,
    // the original event id, and the id map needed to finish recovery.
    expect(await movedInFor(db, projectId)).toStrictEqual(committed);
  }
};

/**
 * Holds the next move after `at` until `release` is called. Swapped in once
 * the app exists: the move reads `ctx.testHooks` only when it runs.
 */
const pauseAfter = (t: TestApp, at: Step) => {
  let arrive = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.ctx.testHooks = {
    ...t.ctx.testHooks,
    afterMoveStep: async (step) => {
      if (step !== at) return;
      arrive();
      await released;
    },
  };
  return { reached, release: () => release() };
};

/** Waits for the pause, or fails at once if the move ended before it. */
const reach = (reached: Promise<void>, moving: Response | Promise<Response>) =>
  Promise.race([
    reached,
    Promise.resolve(moving).then((res) => {
      throw new Error(`the move ended before its pause: ${res.status}`);
    }),
  ]);

/**
 * The cross-database protocol, interrupted on purpose.
 *
 * With no transaction spanning the two databases, "it recovers" is not
 * something the happy path can demonstrate — every one of these tests kills
 * the move between two steps and asserts that `sweepMoves` reaches the same
 * end state the uninterrupted move would have.
 */
describe.each(["dedicated", "dedicated-bucketed"] as const)(
  "cross-database move protocol (%s placement)",
  (placement) => {
    const A = `pmv-a-${placement}`;
    const B = `pmv-b-${placement}`;

    /** A fresh app per test: the injected failure is per-run, not per-suite. */
    const setup = async (failAt?: Step) => {
      const t = await makeTestApp(placement, undefined, {
        afterMoveStep: async (step) => {
          if (step === failAt) throw new Error(`injected failure at ${step}`);
        },
      });
      const cookie = await t.login();
      const admin: Who = { cookie };
      const ids: Record<string, number> = {};
      for (const slug of [A, B]) {
        const res = await t.app.request("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ slug, name: slug }),
        });
        expect(res.status).toBe(201);
        ids[slug] = ((await json(res)) as { id: number }).id;
      }
      return { t, admin, cookie, ids };
    };

    let open: TestApp | null = null;
    const app = async (failAt?: Step) => {
      const made = await setup(failAt);
      open = made.t;
      return made;
    };

    afterEach(async () => {
      await open?.cleanup();
      open = null;
    });

    const req = (t: TestApp, path: string, who: Who, init?: RequestInit) =>
      t.app.request(`/api${path}`, {
        ...init,
        headers: {
          ...(init?.body
            ? { "content-type": "application/json", ...who }
            : who),
          ...init?.headers,
        },
      });

    const createIssue = async (
      t: TestApp,
      who: Who,
      slug: string,
      title: string,
    ) => {
      const res = await req(t, `/projects/${slug}/issues`, who, {
        method: "POST",
        body: JSON.stringify({ title, body: "body" }),
      });
      expect(res.status).toBe(201);
      return (await json(res)) as { id: number; number: number };
    };

    const dbOf = async (t: TestApp, id: number, slug: string) =>
      t.ctx.router.forProject(
        routeInfoOf({ id, slug, databaseUrl: null } as Parameters<
          typeof routeInfoOf
        >[0]),
      );

    const move = (
      t: TestApp,
      who: Who,
      from: string,
      number: number,
      to: string,
    ) =>
      req(t, `/projects/${from}/issues/${number}/move`, who, {
        method: "POST",
        body: JSON.stringify({ to_project: to }),
      });

    it("finishes a move that died before the address book", async () => {
      const { t, admin, ids } = await app(3);
      const source = await createIssue(t, admin, A, "interrupted at 3");
      const comment = await req(
        t,
        `/projects/${A}/issues/${source.number}/comments`,
        admin,
        { method: "POST", body: JSON.stringify({ body: "travels" }) },
      );
      const oldCommentId = ((await json(comment)) as { id: number }).id;
      const dbA = await dbOf(t, ids[A] as number, A);
      await addActivity(dbA, ids[A] as number, source.id);

      expect((await move(t, admin, A, source.number, B)).status).toBe(500);
      const dbB = await dbOf(t, ids[B] as number, B);
      const committed = await movedInFor(dbB, ids[B] as number);
      const boundary = await copiedActivityMaxIds(
        dbB,
        ids[B] as number,
        committed.issueId,
      );
      expect(committed.payload.activity_imported_max_ids).toStrictEqual(
        boundary,
      );
      for (const kind of ["events", "comments", "revisions"] as const) {
        expect(boundary[kind]).toBeGreaterThan(0);
      }
      expect(boundary.events).toBeLessThan(committed.id);

      // Frozen, not gone: reads pass, writes do not, and no redirect yet.
      const read = await req(
        t,
        `/projects/${A}/issues/${source.number}`,
        admin,
      );
      expect(read.status).toBe(200);
      const write = await req(
        t,
        `/projects/${A}/issues/${source.number}`,
        admin,
        { method: "PATCH", body: JSON.stringify({ title: "nope" }) },
      );
      expect(write.status).toBe(409);
      expect((await json(write)).error.code).toBe("issue_moving");

      await expectPreservedAcrossSweeps(t, dbB, ids[B] as number, committed);

      // Converged: the tombstone redirects, and exactly one copy exists.
      const after = await req(
        t,
        `/projects/${A}/issues/${source.number}`,
        admin,
      );
      expect(after.status).toBe(301);
      const to = (await json(after)).moved_to as {
        slug: string;
        number: number;
      };
      expect(to.slug).toBe(B);

      const copies = await dbB
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.projectId, ids[B] as number));
      expect(copies).toHaveLength(1);

      // The aliases landed too — which is only possible if the id map
      // survived the crash inside the moved_in event.
      const aliased = await req(
        t,
        `/projects/${A}/comments/${oldCommentId}`,
        admin,
      );
      expect(aliased.status).toBe(301);
      expect((await json(aliased)).moved_to.slug).toBe(B);
    });

    it("finishes a move that died after the commit point", async () => {
      const { t, admin, ids } = await app(4);
      const source = await createIssue(t, admin, A, "interrupted at 4");
      const dbA = await dbOf(t, ids[A] as number, A);
      await addActivity(dbA, ids[A] as number, source.id);
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);

      // The window the design admits to: past step 4 the copy is live and
      // the source has not been retired yet, so both are readable.
      const dbB = await dbOf(t, ids[B] as number, B);
      const committed = await movedInFor(dbB, ids[B] as number);
      const boundary = await copiedActivityMaxIds(
        dbB,
        ids[B] as number,
        committed.issueId,
      );
      expect(committed.payload.activity_imported_max_ids).toStrictEqual(
        boundary,
      );
      for (const kind of ["events", "comments", "revisions"] as const) {
        expect(boundary[kind]).toBeGreaterThan(0);
      }
      expect(boundary.events).toBeLessThan(committed.id);
      const copies = await dbB
        .select({ number: issues.number })
        .from(issues)
        .where(eq(issues.projectId, ids[B] as number));
      expect(copies).toHaveLength(1);
      const copyNumber = copies[0]?.number as number;
      expect(
        (await req(t, `/projects/${B}/issues/${copyNumber}`, admin)).status,
      ).toBe(200);
      expect(
        (await req(t, `/projects/${A}/issues/${source.number}`, admin)).status,
      ).toBe(200);

      await expectPreservedAcrossSweeps(t, dbB, ids[B] as number, committed);
      expect(
        (await req(t, `/projects/${A}/issues/${source.number}`, admin)).status,
      ).toBe(301);
    });

    describe.each([3, 4] as const)(
      "empty-source recovery at step %s",
      (step) => {
        it.each(["legacy absent", "explicit all-null"] as const)(
          "preserves a %s watermark",
          async (watermark) => {
            const { t, admin, ids } = await app(step);
            const source = await createIssue(t, admin, A, "no source activity");
            const dbA = await dbOf(t, ids[A] as number, A);
            // Issue creation normally emits opened; remove it to model an
            // imported card with no events, comments, or revisions at all.
            await dbA
              .delete(issueEvents)
              .where(eq(issueEvents.issueId, source.id));
            const empty = {
              v: 1,
              events: null,
              comments: null,
              revisions: null,
            };
            expect(
              await copiedActivityMaxIds(dbA, ids[A] as number, source.id),
            ).toStrictEqual(empty);
            expect((await move(t, admin, A, source.number, B)).status).toBe(
              500,
            );

            const dbB = await dbOf(t, ids[B] as number, B);
            let committed = await movedInFor(dbB, ids[B] as number);
            expect(committed.payload.activity_imported_max_ids).toStrictEqual(
              empty,
            );
            if (watermark === "legacy absent") {
              // Model an event committed by a server predating watermarks;
              // keep its move token and id map so real recovery still runs.
              const payload = { ...committed.payload };
              delete payload.activity_imported_max_ids;
              await dbB
                .update(issueEvents)
                .set({ payload })
                .where(eq(issueEvents.id, committed.id));
              committed = await movedInFor(dbB, ids[B] as number);
              expect(
                Object.hasOwn(committed.payload, "activity_imported_max_ids"),
              ).toBe(false);
            }

            await expectPreservedAcrossSweeps(
              t,
              dbB,
              ids[B] as number,
              committed,
            );
            expect(
              (await req(t, `/projects/${A}/issues/${source.number}`, admin))
                .status,
            ).toBe(301);
            const recovered = await movedInFor(dbB, ids[B] as number);
            expect(
              Object.hasOwn(recovered.payload, "activity_imported_max_ids"),
            ).toBe(watermark === "explicit all-null");
            if (watermark === "explicit all-null") {
              expect(recovered.payload.activity_imported_max_ids).toStrictEqual(
                empty,
              );
            }
          },
        );
      },
    );

    it("rolls back a move that died before anything was copied", async () => {
      const { t, admin, ids } = await app(2);
      const source = await createIssue(t, admin, A, "interrupted at 2");
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);
      const [interrupted] = await t.ctx.router
        .system()
        .select()
        .from(issueMoves);
      expect(interrupted?.state).toBe("copying");

      expect(await sweepMoves(t.ctx)).toBe(1);
      expect(await sweepMoves(t.ctx)).toBe(0);

      // Thawed and forgotten: the card is writable again and no registration
      // row is left for a later sweep to act on.
      const write = await req(
        t,
        `/projects/${A}/issues/${source.number}`,
        admin,
        { method: "PATCH", body: JSON.stringify({ title: "writable again" }) },
      );
      expect(write.status).toBe(200);
      expect(
        await t.ctx.router.system().select().from(issueMoves),
      ).toHaveLength(0);
      const dbB = await dbOf(t, ids[B] as number, B);
      expect(
        await dbB
          .select()
          .from(issues)
          .where(eq(issues.projectId, ids[B] as number)),
      ).toHaveLength(0);
      expect(
        await dbB
          .select()
          .from(issueEvents)
          .where(eq(issueEvents.projectId, ids[B] as number)),
      ).toHaveLength(0);

      // New source activity belongs to the next copy, not the abandoned
      // pre-copy attempt. Retry through the endpoint with the fault removed.
      const dbA = await dbOf(t, ids[A] as number, A);
      await addActivity(dbA, ids[A] as number, source.id);
      t.ctx.testHooks = {};
      expect((await move(t, admin, A, source.number, B)).status).toBe(200);
      const committed = await movedInFor(dbB, ids[B] as number);
      expect(committed.payload.move_token).toEqual(expect.any(String));
      expect(committed.payload.move_token).not.toBe(interrupted?.moveToken);
      const boundary = await copiedActivityMaxIds(
        dbB,
        ids[B] as number,
        committed.issueId,
      );
      expect(committed.payload.activity_imported_max_ids).toStrictEqual(
        boundary,
      );
      for (const kind of ["events", "comments", "revisions"] as const) {
        expect(boundary[kind]).toBeGreaterThan(0);
      }
      expect(boundary.events).toBeLessThan(committed.id);
      await expectPreservedAcrossSweeps(t, dbB, ids[B] as number, committed, 0);
    });

    it("leaves one moved_out however often the sweep runs", async () => {
      const { t, admin, ids } = await app(5);
      const source = await createIssue(t, admin, A, "interrupted at 5");
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);

      await sweepMoves(t.ctx);
      await sweepMoves(t.ctx);

      const dbA = await dbOf(t, ids[A] as number, A);
      const trace = await dbA
        .select({ id: issueEvents.id })
        .from(issueEvents)
        .where(
          and(
            eq(issueEvents.issueId, source.id),
            eq(issueEvents.type, "moved_out"),
          ),
        );
      // The source project's only remaining record of the card; a replayed
      // step 5 must not turn it into two.
      expect(trace).toHaveLength(1);
    });

    it("recovers an interrupted move once when two sweeps find it", async () => {
      const { t, admin, ids } = await app(3);
      const source = await createIssue(t, admin, A, "two sweeps");
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);

      const [first, second] = await Promise.all([
        sweepMoves(t.ctx),
        sweepMoves(t.ctx),
      ]);
      expect(first + second).toBe(1);

      const dbA = await dbOf(t, ids[A] as number, A);
      const trace = await dbA
        .select({ id: issueEvents.id })
        .from(issueEvents)
        .where(
          and(
            eq(issueEvents.issueId, source.id),
            eq(issueEvents.type, "moved_out"),
          ),
        );
      expect(trace).toHaveLength(1);
      expect(
        (await req(t, `/projects/${A}/issues/${source.number}`, admin)).status,
      ).toBe(301);
    });

    it("takes over a move that has gone quiet, which then still finishes", async () => {
      const { t, admin, ids } = await app();
      const source = await createIssue(t, admin, A, "gone quiet");
      const paused = pauseAfter(t, 3);
      const moving = move(t, admin, A, source.number, B);
      try {
        await reach(paused.reached, moving);
        // An hour on: far past any lease the move could have renewed.
        const later = new Date(Date.now() + 60 * 60 * 1000);
        expect(await sweepMoves(t.ctx, later)).toBe(1);
        expect(
          (await req(t, `/projects/${A}/issues/${source.number}`, admin))
            .status,
        ).toBe(301);
      } finally {
        // Pass or fail, the move ends before the app closes under it.
        paused.release();
        await moving;
      }

      // Every step after the copy replays, so the move finishing what the
      // sweep already finished leaves one card behind.
      expect((await moving).status).toBe(200);
      const dbB = await dbOf(t, ids[B] as number, B);
      expect(
        await dbB
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.projectId, ids[B] as number)),
      ).toHaveLength(1);
    });

    it("leaves a running move to its mover", async () => {
      const { t, admin } = await app();
      const source = await createIssue(t, admin, A, "still moving");
      const paused = pauseAfter(t, 2);
      const moving = move(t, admin, A, source.number, B);
      try {
        await reach(paused.reached, moving);
        expect(await sweepMoves(t.ctx)).toBe(0);
        // Accepted here, this write would be emptied out with the source.
        const write = await req(
          t,
          `/projects/${A}/issues/${source.number}`,
          admin,
          { method: "PATCH", body: JSON.stringify({ title: "lost" }) },
        );
        expect(write.status).toBe(409);
        expect((await json(write)).error.code).toBe("issue_moving");
      } finally {
        // Pass or fail, the move ends before the app closes under it.
        paused.release();
        await moving;
      }

      expect((await moving).status).toBe(200);
      expect(
        (await req(t, `/projects/${A}/issues/${source.number}`, admin)).status,
      ).toBe(301);
      expect(
        await t.ctx.router
          .system()
          .select({ state: issueMoves.state })
          .from(issueMoves),
      ).toEqual([{ state: "done" }]);
    });

    // Real timers on a short lease: the interval does not depend on the
    // placement.
    it.runIf(placement === "dedicated")(
      "recovers a move whose lease runs out after boot, without a restart",
      async () => {
        const { t, admin, ids } = await app();
        t.ctx.testHooks = { ...t.ctx.testHooks, moveLeaseMs: 300 };
        const source = await createIssue(t, admin, A, "cut off");
        // What a crash moments before boot leaves: the card frozen and a
        // registration row whose dead mover's lease has not run out yet.
        const dbA = await dbOf(t, ids[A] as number, A);
        const movedAt = new Date();
        const [frozen] = await dbA
          .update(issues)
          .set({ movingSince: movedAt })
          .where(eq(issues.id, source.id))
          .returning({ authorId: issues.authorId });
        await t.ctx.router
          .system()
          .insert(issueMoves)
          .values({
            moveToken: randomUUID(),
            fromProjectId: ids[A] as number,
            fromNumber: source.number,
            toProjectId: ids[B] as number,
            actorId: frozen?.authorId as number,
            movedAt,
            state: "copying",
            leasedBy: "crashed",
            leasedUntil: new Date(Date.now() + 1000),
          });

        // An hourly tick, so only the move interval can reach the row.
        const stop = startHousekeeping(t.ctx, 60 * 60 * 1000);
        try {
          await vi.waitFor(
            async () => {
              const write = await req(
                t,
                `/projects/${A}/issues/${source.number}`,
                admin,
                { method: "PATCH", body: JSON.stringify({ title: "thawed" }) },
              );
              expect(write.status).toBe(200);
            },
            { timeout: 5000, interval: 100 },
          );
        } finally {
          stop();
        }
      },
    );

    // The source's one PGlite connection, held by a transaction, stands in
    // for a lock the recovery waits on.
    it.runIf(placement === "dedicated")(
      "keeps a row a recovery is still working on from the next sweep",
      async () => {
        const { t, admin, ids } = await app(2);
        t.ctx.testHooks = { ...t.ctx.testHooks, moveLeaseMs: 300 };
        const source = await createIssue(t, admin, A, "slow recovery");
        expect((await move(t, admin, A, source.number, B)).status).toBe(500);

        const dbA = await dbOf(t, ids[A] as number, A);
        let hold = () => {};
        let release = () => {};
        const held = new Promise<void>((resolve) => {
          hold = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const holding = dbA.transaction(async (tx) => {
          await tx
            .select({ id: issues.id })
            .from(issues)
            .where(eq(issues.id, source.id));
          hold();
          await released;
        });
        let first: Promise<number> | undefined;
        let second: Promise<number> | undefined;
        try {
          await held;
          first = sweepMoves(t.ctx);
          // Three leases: only a renewal keeps the first sweep's claim.
          await new Promise((resolve) => setTimeout(resolve, 900));
          second = sweepMoves(t.ctx);
          let timer: NodeJS.Timeout | undefined;
          const outcome = await Promise.race([
            second,
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve("still waiting after 2s"), 2000);
            }),
          ]);
          clearTimeout(timer);
          expect(outcome).toBe(0);
        } finally {
          // Pass or fail, both sweeps end before the app closes under them.
          release();
          await holding;
          await Promise.all([first, second]);
        }

        expect(await first).toBe(1);
        const write = await req(
          t,
          `/projects/${A}/issues/${source.number}`,
          admin,
          { method: "PATCH", body: JSON.stringify({ title: "thawed" }) },
        );
        expect(write.status).toBe(200);
      },
    );

    // The renewals do not depend on the placement, and this waits for real.
    it.runIf(placement === "dedicated")(
      "keeps the lease of a move slower than the lease",
      async () => {
        const { t, admin } = await app();
        t.ctx.testHooks = { ...t.ctx.testHooks, moveLeaseMs: 2000 };
        const source = await createIssue(t, admin, A, "slow move");
        const paused = pauseAfter(t, 2);
        const moving = move(t, admin, A, source.number, B);
        try {
          await reach(paused.reached, moving);
          // Two and a half leases: only a renewal keeps the row held.
          await new Promise((resolve) => setTimeout(resolve, 5000));
          expect(await sweepMoves(t.ctx)).toBe(0);
          const write = await req(
            t,
            `/projects/${A}/issues/${source.number}`,
            admin,
            { method: "PATCH", body: JSON.stringify({ title: "lost" }) },
          );
          expect(write.status).toBe(409);
        } finally {
          // Pass or fail, the move ends before the app closes under it.
          paused.release();
          await moving;
        }
        expect((await moving).status).toBe(200);
      },
    );

    it("refuses a second move during the freeze and leaves no second row", async () => {
      const { t, admin } = await app(3);
      const source = await createIssue(t, admin, A, "contested");
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);

      const second = await move(t, admin, A, source.number, B);
      expect(second.status).toBe(409);
      expect((await json(second)).error.code).toBe("issue_moving");
      const rows = await t.ctx.router.system().select().from(issueMoves);
      expect(rows).toHaveLength(1);

      // …and the sweep still finishes the first move rather than thawing it.
      expect(await sweepMoves(t.ctx)).toBe(1);
      expect(
        (await req(t, `/projects/${A}/issues/${source.number}`, admin)).status,
      ).toBe(301);
    });

    it("leaves no tombstone in the trash when the source was trashed during the freeze", async () => {
      const { t, admin, ids } = await app(3);
      const source = await createIssue(t, admin, A, "trashed while frozen");
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);
      // What a delete during the freeze could do before deletes refused a
      // card being moved: the sweep then finishes the move on a trashed row.
      const dbA = await dbOf(t, ids[A] as number, A);
      const [author] = await dbA
        .select({ id: issues.authorId })
        .from(issues)
        .where(eq(issues.id, source.id));
      await dbA
        .update(issues)
        .set({ deletedAt: new Date(), deletedBy: author?.id })
        .where(eq(issues.id, source.id));

      expect(await sweepMoves(t.ctx)).toBe(1);
      const [row] = await dbA
        .select({
          deletedAt: issues.deletedAt,
          deletedBy: issues.deletedBy,
          movedAt: issues.movedAt,
        })
        .from(issues)
        .where(eq(issues.id, source.id));
      expect(row?.movedAt).not.toBeNull();
      expect(row).toMatchObject({ deletedAt: null, deletedBy: null });
    });

    it("keeps the address book flat for every address the card has had", async () => {
      const { t, admin, ids } = await app();
      const source = await createIssue(t, admin, A, "walks the book");
      const out = await json(await move(t, admin, A, source.number, B));
      const back = await json(await move(t, admin, B, out.moved_to.number, A));

      const rows = await t.ctx.router
        .system()
        .select()
        .from(issueAddresses)
        .where(eq(issueAddresses.projectId, ids[A] as number));
      expect(rows).toHaveLength(1);
      // Every address of a lineage points at the same place — the invariant
      // that makes resolution one lookup instead of a chase.
      const all = await t.ctx.router.system().select().from(issueAddresses);
      const targets = new Set(
        all.map((r) => `${r.currentProjectId}/${r.currentNumber}`),
      );
      expect(targets.size).toBe(1);
      expect([...targets][0]).toBe(`${ids[A]}/${back.moved_to.number}`);
    });
  },
);

/**
 * Two projects in ONE dedicated database while the system tables sit
 * elsewhere: the deployment that makes the two path judgements disagree.
 */
describe("two projects sharing a database", () => {
  it("takes the protocol path without colliding on the storage key", async () => {
    const t = await makeTestApp("dedicated-bucketed");
    try {
      const cookie = await t.login();
      const headers = { "content-type": "application/json", cookie };
      const created: Array<{ slug: string; id: number }> = [];
      // `project.id % 2` buckets them, so the first and third share a target.
      for (const slug of ["bkt-one", "bkt-two", "bkt-three"]) {
        const res = await t.app.request("/api/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({ slug, name: slug }),
        });
        expect(res.status).toBe(201);
        created.push({ slug, id: ((await json(res)) as { id: number }).id });
      }
      const pair = created.filter(
        (p) => p.id % 2 === (created[0] as { id: number }).id % 2,
      );
      expect(pair.length).toBeGreaterThanOrEqual(2);
      const from = pair[0] as { slug: string; id: number };
      const to = pair[1] as { slug: string; id: number };

      const issue = await json(
        await t.app.request(`/api/projects/${from.slug}/issues`, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "carries a file", body: "body" }),
        }),
      );
      const form = new FormData();
      form.set(
        "file",
        new File(["bytes"], "shared.txt", { type: "text/plain" }),
      );
      form.set("issue_number", String(issue.number));
      const uploaded = await t.app.request(
        `/api/projects/${from.slug}/attachments`,
        { method: "POST", headers: { cookie }, body: form },
      );
      expect(uploaded.status).toBe(201);
      const db = await t.ctx.router.forProject(
        routeInfoOf({ ...to, databaseUrl: null } as Parameters<
          typeof routeInfoOf
        >[0]),
      );
      await addActivity(db, from.id, issue.id);
      const sourceBoundary = await copiedActivityMaxIds(db, from.id, issue.id);

      // The copy keeps the storage key, and the unique index on it spans the
      // whole database — so the source row has to go first even though this
      // is the cross-database path.
      const res = await t.app.request(
        `/api/projects/${from.slug}/issues/${issue.number}/move`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ to_project: to.slug }),
        },
      );
      expect(res.status).toBe(200);
      const moved = await json(res);
      expect(moved.moved_to.slug).toBe(to.slug);
      const committed = await movedInFor(db, to.id);
      const boundary = await copiedActivityMaxIds(db, to.id, committed.issueId);
      expect(committed.payload.activity_imported_max_ids).toStrictEqual(
        boundary,
      );
      for (const kind of ["events", "comments", "revisions"] as const) {
        // Shared sequences make source ids plausible but wrong boundaries.
        expect(boundary[kind]).toBeGreaterThan(sourceBoundary[kind] as number);
      }
      expect(boundary.events).toBeLessThan(committed.id);
      await expectPreservedAcrossSweeps(t, db, to.id, committed, 0);

      const listed = await t.app.request(
        `/api/projects/${to.slug}/attachments?issue_number=${moved.moved_to.number}`,
        { headers: { cookie } },
      );
      expect(listed.status).toBe(200);
      expect(await json(listed)).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });
});

/**
 * The source project in the system database on PGlite, the target pinned to
 * a database of its own: the recovery reaches the source through the one
 * connection the whole process shares.
 */
describe("recovery through PGlite's one connection", () => {
  it("does not wait on itself", async () => {
    const t = await makeTestApp("shared", undefined, {
      afterMoveStep: async (step) => {
        if (step === 2) throw new Error("injected failure at 2");
      },
    });
    try {
      const cookie = await t.login();
      const headers = { "content-type": "application/json", cookie };
      for (const slug of ["pin-a", "pin-b"]) {
        const res = await t.app.request("/api/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({ slug, name: slug }),
        });
        expect(res.status).toBe(201);
      }

      // Not a state the API reaches: under shared placement a project is
      // never pinned, so the pin is written here by hand, with the rows a
      // new project gets in its own database.
      const system = t.ctx.router.system();
      const [shared] = await system
        .select()
        .from(projects)
        .where(eq(projects.slug, "pin-b"));
      if (shared === undefined) throw new Error("expected pin-b");
      const seeded = await (await t.ctx.router.forProject(routeInfoOf(shared)))
        .select()
        .from(statuses)
        .where(eq(statuses.projectId, shared.id));
      await system
        .update(projects)
        .set({ databaseUrl: `pglite://memory/pinned-${randomUUID()}` })
        .where(eq(projects.id, shared.id));
      const [pinnedRow] = await system
        .select()
        .from(projects)
        .where(eq(projects.id, shared.id));
      if (pinnedRow === undefined) throw new Error("expected pin-b");
      const pinned = await t.ctx.router.forProject(routeInfoOf(pinnedRow));
      await pinned.insert(projectMeta).values({ projectId: shared.id });
      await pinned
        .insert(statuses)
        .values(seeded.map(({ id: _id, ...status }) => status));

      const card = await json(
        await t.app.request("/api/projects/pin-a/issues", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "one connection", body: "body" }),
        }),
      );
      const moved = await t.app.request(
        `/api/projects/pin-a/issues/${card.number}/move`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ to_project: "pin-b" }),
        },
      );
      expect(moved.status).toBe(500);

      // A timer of its own, so a hang fails here rather than as the
      // runner's timeout.
      let timer: NodeJS.Timeout | undefined;
      const swept = await Promise.race([
        sweepMoves(t.ctx),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still waiting after 5s"), 5000);
        }),
      ]);
      clearTimeout(timer);
      expect(swept).toBe(1);
      const write = await t.app.request(
        `/api/projects/pin-a/issues/${card.number}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "writable again" }),
        },
      );
      expect(write.status).toBe(200);
    } finally {
      await t.cleanup();
    }
  });
});

describe("claiming a row", () => {
  it("leases each row from the time it is claimed", async () => {
    let claims = 0;
    // The first claim stands in for a recovery that takes ten minutes.
    const t = await makeTestApp("shared", undefined, {
      onQuery: (sql) => {
        if (!sql.startsWith('update "issue_moves" set "leased_by"')) return;
        claims += 1;
        if (claims === 1) vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      },
    });
    try {
      await t.login();
      const system = t.ctx.router.system();
      const [user] = await system.select({ id: users.id }).from(users);
      // Rows whose source project is gone: the sweep claims them and leaves
      // them as they are, so each keeps the lease it was given.
      await system.insert(issueMoves).values(
        [1, 2].map((number) => ({
          moveToken: randomUUID(),
          fromProjectId: 999_999,
          fromNumber: number,
          toProjectId: 999_998,
          actorId: user?.id as number,
          movedAt: new Date(),
          state: "copying" as const,
        })),
      );

      vi.useFakeTimers({ toFake: ["Date"] });
      expect(await sweepMoves(t.ctx)).toBe(0);
      expect(claims).toBe(2);
      const leases = await system
        .select({ until: issueMoves.leasedUntil })
        .from(issueMoves);
      // The row claimed after the slow one holds a lease that runs from then.
      const latest = Math.max(
        ...leases.map((row) => row.until?.getTime() ?? 0),
      );
      expect(latest).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
      await t.cleanup();
    }
  });
});
