import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";
import {
  lockWaiters,
  pidOf,
  uploadDraft,
  waitForLockWaiters,
  withOptions,
} from "./pg-lock-helpers.ts";
import { createTestDatabase, type TestDatabase } from "./postgres-database.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (response: Response): Promise<any> => response.json();
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

// PGlite has one connection, so lock order never shows there. An outside
// connection, the holder, plays the transaction a request races: it takes a
// first row, waits for the request to queue behind it, then takes a second.
// What the holder plays is always a path the server takes once fixed, so
// neither side may be aborted as a deadlock.
// Where the order a request takes rows in is the order a scan meets them,
// the request goes to an app whose connections never use an index, and the
// test puts the rows in the table out of id order first.
describe.skipIf(!PG_URL)("lock order on PostgreSQL", () => {
  let database: TestDatabase | undefined;
  let t: TestApp;
  let seq: TestApp;
  let holder: pg.Client;
  let observer: pg.Client;
  let holderPid: number;
  let author: { headers: { authorization: string } };
  const stamp = Date.now().toString(36);
  let projects = 0;

  const send = (
    method: string,
    path: string,
    body?: unknown,
    via: TestApp = t,
  ) =>
    Promise.resolve(
      via.app.request(`/api${path}`, {
        method,
        headers: { ...author.headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    if (!PG_URL) return;
    database = await createTestDatabase(PG_URL, "lock_order");
    t = await makeTestApp("shared", { systemUrl: database.url });
    seq = await makeTestApp("shared", {
      systemUrl: withOptions(
        database.url,
        "-c enable_indexscan=off -c enable_bitmapscan=off",
      ),
    });
    // The setting reaches the app's own connections: SHOW answers "off".
    const shown = (await seq.ctx.router
      .system()
      .execute(sql`SHOW enable_indexscan`)) as { rows: unknown[] };
    expect(shown.rows).toEqual([{ enable_indexscan: "off" }]);
    holder = new pg.Client({ connectionString: database.url });
    observer = new pg.Client({ connectionString: database.url });
    await holder.connect();
    await observer.connect();
    holderPid = await pidOf(holder);
    author = await addUserWithToken(t.ctx, `lockorder-${stamp}`);
  });

  afterAll(async () => {
    // Every connection to the database closes before the drop, even when
    // closing another one fails.
    const closed = await Promise.allSettled([
      holder?.end(),
      observer?.end(),
      t?.cleanup(),
      seq?.cleanup(),
    ]);
    await database?.drop();
    for (const result of closed) {
      if (result.status === "rejected") throw result.reason;
    }
  });

  /** A fresh project for one test. */
  const project = async () => {
    projects += 1;
    const slug = `lockorder-${stamp}-${projects}`;
    const created = await send("POST", "/projects", { slug, name: slug });
    expect(created.status).toBe(201);
    return { slug, id: (await json(created)).id as number };
  };

  const card = async (slug: string, title: string) => {
    const created = await send("POST", `/projects/${slug}/issues`, { title });
    expect(created.status).toBe(201);
    return (await json(created)) as { id: number; number: number };
  };

  /** `blocked` waits for `blocker`, both in the project `slug`. */
  const block = async (
    slug: string,
    blocked: { number: number },
    blocker: { number: number },
  ) => {
    const res = await send(
      "POST",
      `/projects/${slug}/issues/${blocked.number}/blocked-by`,
      { ref: `#${blocker.number}` },
    );
    expect(res.status).toBe(200);
  };

  /** The rows' ids in the order a sequential scan meets them. */
  const physicalOrder = async (table: string, ids: number[]) =>
    (
      await observer.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE id = ANY($1) ORDER BY ctid`,
        [ids],
      )
    ).rows.map((row) => Number(row.id));

  it("two renames of one project queue instead of deadlocking", async () => {
    const p = await project();
    const renames = [`${p.slug}-one`, `${p.slug}-two`];

    // The holder is any transaction holding the project row in KEY SHARE,
    // which is what inserting a row that references it takes.
    await holder.query("BEGIN");
    let pending: Array<Promise<Response>> = [];
    try {
      await holder.query(
        "SELECT id FROM projects WHERE id = $1 FOR KEY SHARE",
        [p.id],
      );
      pending = renames.map((slug) =>
        send("PATCH", `/projects/${p.slug}`, { slug }),
      );
      await waitForLockWaiters(observer, holderPid, 2);
      await holder.query("COMMIT");
      const responses = await Promise.all(pending);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      const now = await observer.query<{ slug: string }>(
        "SELECT slug FROM projects WHERE id = $1",
        [p.id],
      );
      expect(renames).toContain(now.rows[0]?.slug);
      const history = await observer.query<{ slug: string }>(
        "SELECT slug FROM slug_history WHERE project_id = $1",
        [p.id],
      );
      expect(history.rows.map((r) => r.slug)).toEqual(
        expect.arrayContaining(renames),
      );
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled(pending);
    }
  });

  it("marking a trashed blocker locks its edges in id order", async () => {
    const p = await project();
    const x = await card(p.slug, "X");
    const b1 = await card(p.slug, "B1");
    const b2 = await card(p.slug, "B2");
    await block(p.slug, b1, x);
    await block(p.slug, b2, x);
    const edges = await observer.query<{ id: string }>(
      `SELECT id FROM issue_blocks
       WHERE blocker_project_id = $1 AND blocker_number = $2 ORDER BY id`,
      [p.id, x.number],
    );
    const [e1, e2] = edges.rows.map((row) => Number(row.id));
    if (e1 === undefined || e2 === undefined) throw new Error("no edges");
    // A new version of e1 lands behind e2, so a sequential scan meets e2
    // first.
    await observer.query(
      "UPDATE issue_blocks SET cleared_at = cleared_at WHERE id = $1",
      [e1],
    );
    expect(await physicalOrder("issue_blocks", [e1, e2])).toEqual([e2, e1]);

    // The holder locks edges in id order, as every write of several does.
    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      await holder.query(
        "SELECT id FROM issue_blocks WHERE id = $1 FOR UPDATE",
        [e1],
      );
      // Trashing commits the card, then marks its edges.
      pending = send(
        "DELETE",
        `/projects/${p.slug}/issues/${x.number}`,
        undefined,
        seq,
      );
      await waitForLockWaiters(observer, holderPid, 1);
      await holder.query(
        "SELECT id FROM issue_blocks WHERE id = $1 FOR UPDATE",
        [e2],
      );
      await holder.query("COMMIT");
      expect((await pending).status).toBe(204);
      const marked = await observer.query<{ deleted: boolean }>(
        `SELECT blocker_deleted_at IS NOT NULL AS deleted FROM issue_blocks
         WHERE id = ANY($1)`,
        [[e1, e2]],
      );
      expect(marked.rows).toEqual([{ deleted: true }, { deleted: true }]);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([pending]);
    }
  });

  it("a move rewrites the edges at its address in id order", async () => {
    const p = await project();
    const q = await project();
    const z = await card(p.slug, "Z");
    const x = await card(p.slug, "X");
    const w = await card(p.slug, "W");
    await block(p.slug, x, z);
    await block(p.slug, w, x);
    const edgeAt = async (side: "blocker" | "blocked") => {
      const rows = await observer.query<{ id: string }>(
        `SELECT id FROM issue_blocks
         WHERE ${side}_project_id = $1 AND ${side}_number = $2`,
        [p.id, x.number],
      );
      return Number(rows.rows[0]?.id);
    };
    // X is on the blocked side of e1 and the blocker side of e2.
    const e1 = await edgeAt("blocked");
    const e2 = await edgeAt("blocker");
    expect(e1).toBeLessThan(e2);
    // A new version of e1 lands behind e2, so a sequential scan meets e2
    // first.
    await observer.query(
      "UPDATE issue_blocks SET cleared_at = cleared_at WHERE id = $1",
      [e1],
    );
    expect(await physicalOrder("issue_blocks", [e1, e2])).toEqual([e2, e1]);

    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      await holder.query(
        "SELECT id FROM issue_blocks WHERE id = $1 FOR UPDATE",
        [e1],
      );
      pending = send(
        "POST",
        `/projects/${p.slug}/issues/${x.number}/move`,
        { to_project: q.slug },
        seq,
      );
      await waitForLockWaiters(observer, holderPid, 1);
      await holder.query(
        "SELECT id FROM issue_blocks WHERE id = $1 FOR UPDATE",
        [e2],
      );
      await holder.query("COMMIT");
      const moved = await pending;
      expect(moved.status).toBe(200);
      const at = (await json(moved)).moved_to.number as number;
      const rows = await observer.query<{
        id: string;
        blocker_project_id: string;
        blocker_number: string;
        blocked_project_id: string;
        blocked_number: string;
      }>(
        `SELECT id, blocker_project_id, blocker_number, blocked_project_id,
                blocked_number
         FROM issue_blocks WHERE id = ANY($1) ORDER BY id`,
        [[e1, e2]],
      );
      const [first, second] = rows.rows;
      expect([first?.blocked_project_id, first?.blocked_number]).toEqual([
        String(q.id),
        String(at),
      ]);
      expect([second?.blocker_project_id, second?.blocker_number]).toEqual([
        String(q.id),
        String(at),
      ]);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([pending]);
    }
  });
});

// The same holder, against the steps of a move to another database: the
// move is paused between two steps, the holder takes its first row, and the
// next step is let go. Projects live in two bucket databases by id, and
// every database the app uses scans without an index.
describe.skipIf(!PG_URL)("lock order of moves across databases", () => {
  const databases: TestDatabase[] = [];
  let t: TestApp;
  let author: { headers: { authorization: string } };
  const clients: pg.Client[] = [];
  const stamp = Date.now().toString(36);
  let pause:
    | { step: number; reached: () => void; release: Promise<void> }
    | undefined;
  const projects: Array<{ slug: string; id: number; url: string }> = [];

  const send = (method: string, path: string, body?: unknown) =>
    Promise.resolve(
      t.app.request(`/api${path}`, {
        method,
        headers: { ...author.headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    if (!PG_URL) return;
    for (const prefix of ["lock_moves", "lock_moves_b0", "lock_moves_b1"]) {
      databases.push(await createTestDatabase(PG_URL, prefix));
    }
    const scanning = "-c enable_indexscan=off -c enable_bitmapscan=off";
    const [system, b0, b1] = databases.map((database) =>
      withOptions(database.url, scanning),
    );
    t = await makeTestApp(
      "dedicated",
      {
        systemUrl: system,
        urlTemplate: `\${project.id % 2 ? ${JSON.stringify(b1)} : ${JSON.stringify(b0)}}`,
      },
      {
        afterMoveStep: async (step) => {
          const held = pause;
          if (held?.step !== step) return;
          pause = undefined;
          held.reached();
          await held.release;
        },
      },
    );
    author = await addUserWithToken(t.ctx, `lockmoves-${stamp}`);
    // Consecutive ids: the first and the third share a bucket database.
    for (const name of ["one", "two", "three"]) {
      const slug = `lockmoves-${stamp}-${name}`;
      const created = await send("POST", "/projects", { slug, name: slug });
      expect(created.status).toBe(201);
      const id = (await json(created)).id as number;
      const url = t.ctx.router.resolveProjectUrl({
        id,
        slug,
        database_url: null,
      });
      projects.push({ slug, id, url });
    }
    const [one, two, three] = projects;
    expect(one?.url).toBe(three?.url);
    expect(one?.url).not.toBe(two?.url);
  });

  afterAll(async () => {
    const closed = await Promise.allSettled([
      ...clients.map((client) => client.end()),
      t?.cleanup(),
    ]);
    for (const database of databases) await database.drop();
    for (const result of closed) {
      if (result.status === "rejected") throw result.reason;
    }
  });

  const connect = async (url: string) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
  };

  /** The next move stops after `step` until `release` is called. */
  const pauseAfter = (step: number) => {
    let reached = () => {};
    let release = () => {};
    const atStep = new Promise<void>((resolve) => {
      reached = resolve;
    });
    pause = {
      step,
      reached,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    return { atStep, release: () => release() };
  };

  const card = async (slug: string, title: string) => {
    const created = await send("POST", `/projects/${slug}/issues`, { title });
    expect(created.status).toBe(201);
    return (await json(created)) as { id: number; number: number };
  };

  /** Waits for the pause, or fails if the move ends before reaching it. */
  const reach = (atStep: Promise<void>, moving: Promise<Response>) =>
    Promise.race([
      atStep,
      moving.then((res) => {
        throw new Error(`the move ended before its pause: ${res.status}`);
      }),
    ]);

  // The holder takes the frozen card and then writes two of its attachment
  // rows, the order every write keeps. The step that deletes the card's
  // attachment rows meets d2 first, so it has to wait for the card before it
  // touches either.
  const draftsRace = async (
    from: { slug: string; url: string },
    to: { slug: string },
    after: 2 | 4,
    f: { id: number; number: number },
  ) => {
    const d1 = (await uploadDraft(t, author.headers, from.slug, f.number)).id;
    const d2 = (await uploadDraft(t, author.headers, from.slug, f.number)).id;
    const holder = await connect(from.url);
    const observer = await connect(from.url);
    // A new version of d1 lands behind d2 in the table, which these
    // databases scan without an index.
    await observer.query(
      "UPDATE attachments SET filename = filename WHERE id = $1",
      [d1],
    );
    const order = await observer.query<{ id: string }>(
      "SELECT id FROM attachments WHERE id = ANY($1) ORDER BY ctid",
      [[d1, d2]],
    );
    expect(order.rows.map((row) => Number(row.id))).toEqual([d2, d1]);

    const paused = pauseAfter(after);
    const moving = send(
      "POST",
      `/projects/${from.slug}/issues/${f.number}/move`,
      { to_project: to.slug },
    );
    const pid = await pidOf(holder);
    try {
      await reach(paused.atStep, moving);
      await holder.query("BEGIN");
      await holder.query(
        "SELECT id FROM issues WHERE id = $1 FOR NO KEY UPDATE",
        [f.id],
      );
      await holder.query("UPDATE attachments SET draft = false WHERE id = $1", [
        d1,
      ]);
      paused.release();
      await expect
        .poll(() => lockWaiters(observer, pid), { timeout: 5000, interval: 10 })
        .toBe(1);
      await holder.query("UPDATE attachments SET draft = false WHERE id = $1", [
        d2,
      ]);
      await holder.query("COMMIT");
      const moved = await moving;
      expect(moved.status).toBe(200);
      const source = await observer.query<{ moved: boolean }>(
        "SELECT moved_at IS NOT NULL AS moved FROM issues WHERE id = $1",
        [f.id],
      );
      expect(source.rows).toEqual([{ moved: true }]);
      return (await json(moved)) as { reinhabited: boolean };
    } finally {
      paused.release();
      await holder.query("ROLLBACK");
      await Promise.allSettled([moving]);
    }
  };

  it("the last step of a move locks the card before it empties it", async () => {
    const [from, to] = projects;
    if (!from || !to) throw new Error("no projects");
    await draftsRace(from, to, 4, await card(from.slug, "F"));
  });

  it("the copy of a move within one database locks the card before it deletes its files", async () => {
    const [from, , to] = projects;
    if (!from || !to) throw new Error("no projects");
    await draftsRace(from, to, 2, await card(from.slug, "F"));
  });

  it("the copy of a move back into its tombstone locks the card first too", async () => {
    const [home, , away] = projects;
    if (!home || !away) throw new Error("no projects");
    const f = await card(home.slug, "F");
    const out = await send(
      "POST",
      `/projects/${home.slug}/issues/${f.number}/move`,
      {
        to_project: away.slug,
      },
    );
    expect(out.status).toBe(200);
    const landed = (await json(out)) as {
      moved_to: { number: number };
      issue: { id: number };
    };
    const back = await draftsRace(away, home, 2, {
      id: landed.issue.id,
      number: landed.moved_to.number,
    });
    expect(back.reinhabited).toBe(true);
  });

  // Publishing the move rewrites the edges at the card's address on the
  // system pool, in a transaction of its own. A second holder queues behind
  // the move for e1 and takes it the moment the move lets go of it, then
  // goes for e2.
  it("publishing a move holds its edges until both sides are rewritten", async () => {
    const [from, to] = projects;
    const [system] = databases;
    if (!from || !to || !system) throw new Error("no projects");
    const x = await card(from.slug, "X");
    const w1 = await card(from.slug, "W1");
    const w2 = await card(from.slug, "W2");
    for (const blocked of [w1, w2]) {
      const res = await send(
        "POST",
        `/projects/${from.slug}/issues/${blocked.number}/blocked-by`,
        { ref: `#${x.number}` },
      );
      expect(res.status).toBe(200);
    }
    const first = await connect(system.url);
    const second = await connect(system.url);
    const observer = await connect(system.url);
    const edges = await observer.query<{ id: string }>(
      `SELECT id FROM issue_blocks
       WHERE blocker_project_id = $1 AND blocker_number = $2 ORDER BY id`,
      [from.id, x.number],
    );
    const [e1, e2] = edges.rows.map((row) => Number(row.id));
    // A new version of e1 lands behind e2, so a sequential scan meets e2
    // first.
    await observer.query(
      "UPDATE issue_blocks SET cleared_at = cleared_at WHERE id = $1",
      [e1],
    );
    const order = await observer.query<{ id: string }>(
      "SELECT id FROM issue_blocks WHERE id = ANY($1) ORDER BY ctid",
      [[e1, e2]],
    );
    expect(order.rows.map((row) => Number(row.id))).toEqual([e2, e1]);

    const paused = pauseAfter(3);
    let settled = false;
    const moving = send(
      "POST",
      `/projects/${from.slug}/issues/${x.number}/move`,
      {
        to_project: to.slug,
      },
    ).finally(() => {
      settled = true;
    });
    const [firstPid, secondPid] = [await pidOf(first), await pidOf(second)];
    let queued: Promise<unknown> | undefined;
    try {
      await reach(paused.atStep, moving);
      await first.query("BEGIN");
      await first.query(
        "SELECT id FROM issue_blocks WHERE id = $1 FOR UPDATE",
        [e1],
      );
      paused.release();
      await expect
        .poll(() => lockWaiters(observer, firstPid), {
          timeout: 5000,
          interval: 10,
        })
        .toBe(1);
      await second.query("BEGIN");
      queued = second.query(
        "SELECT id FROM issue_blocks WHERE id = $1 FOR UPDATE",
        [e1],
      );
      await expect
        .poll(() => lockWaiters(observer, firstPid), {
          timeout: 5000,
          interval: 10,
        })
        .toBe(2);
      await first.query("COMMIT");
      await queued;
      // Either the move is done with the edges, or it waits on the second.
      await expect
        .poll(
          async () => settled || (await lockWaiters(observer, secondPid)) > 0,
          {
            timeout: 5000,
            interval: 10,
          },
        )
        .toBe(true);
      await second.query(
        "SELECT id FROM issue_blocks WHERE id = $1 FOR UPDATE",
        [e2],
      );
      await second.query("COMMIT");
      const moved = await moving;
      expect(moved.status).toBe(200);
      const at = (await json(moved)).moved_to.number as number;
      const rewritten = await observer.query<{
        blocker_project_id: string;
        blocker_number: string;
      }>(
        `SELECT blocker_project_id, blocker_number FROM issue_blocks
         WHERE id = ANY($1)`,
        [[e1, e2]],
      );
      expect(rewritten.rows).toEqual([
        { blocker_project_id: String(to.id), blocker_number: String(at) },
        { blocker_project_id: String(to.id), blocker_number: String(at) },
      ]);
    } finally {
      paused.release();
      await Promise.allSettled([first.query("ROLLBACK"), queued]);
      await second.query("ROLLBACK");
      await Promise.allSettled([moving]);
    }
  });
});
