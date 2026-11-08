import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reapDraftAttachments } from "../src/services/storage-admin.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

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
// The suite makes a database of its own: test files that start together on
// a new database race to create its migration tables.
describe.skipIf(!PG_URL)("lock order on PostgreSQL", () => {
  let admin: pg.Client | undefined;
  let owned: string | undefined;
  let t: TestApp;
  let seq: TestApp;
  let indexed: TestApp;
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
    admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    // Only a generated identifier enters CREATE/DROP DATABASE.
    const name = `lock_order_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    owned = name;
    const url = new URL(PG_URL);
    url.pathname = `/${name}`;
    // pg connection strings may specify dbname separately from pathname.
    url.searchParams.delete("database");
    url.searchParams.delete("dbname");
    t = await makeTestApp("shared", { systemUrl: url.toString() });
    const scanning = new URL(url);
    scanning.searchParams.set(
      "options",
      "-c enable_indexscan=off -c enable_bitmapscan=off",
    );
    seq = await makeTestApp("shared", { systemUrl: scanning.toString() });
    const ordered = new URL(url);
    ordered.searchParams.set(
      "options",
      "-c enable_seqscan=off -c enable_bitmapscan=off",
    );
    indexed = await makeTestApp("shared", { systemUrl: ordered.toString() });
    const unscanned = (await indexed.ctx.router
      .system()
      .execute(sql`SHOW enable_seqscan`)) as { rows: unknown[] };
    expect(unscanned.rows).toEqual([{ enable_seqscan: "off" }]);
    // The setting reaches the app's own connections: SHOW answers "off".
    const shown = (await seq.ctx.router
      .system()
      .execute(sql`SHOW enable_indexscan`)) as { rows: unknown[] };
    expect(shown.rows).toEqual([{ enable_indexscan: "off" }]);
    holder = new pg.Client({ connectionString: url.toString() });
    observer = new pg.Client({ connectionString: url.toString() });
    await holder.connect();
    await observer.connect();
    const [backend] = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows;
    if (!backend) throw new Error("holder has no backend pid");
    holderPid = backend.pid;
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
      indexed?.cleanup(),
    ]);
    try {
      if (owned) await admin?.query(`DROP DATABASE "${owned}"`);
    } finally {
      await admin?.end();
    }
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

  const uploadDraft = async (slug: string, card: { number: number }) => {
    const form = new FormData();
    form.set("file", new File(["draft"], "draft.txt"));
    form.set("issue_number", String(card.number));
    form.set("draft", "true");
    const res = await t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: author.headers,
      body: form,
    });
    expect(res.status).toBe(201);
    return (await json(res)).id as number;
  };

  /** Requests queued behind the holder, directly or behind one another. */
  const lockWaiters = async () => {
    const result = await observer.query<{ count: string }>(
      `WITH RECURSIVE blocked(pid) AS (
         SELECT $1::integer
         UNION
         SELECT activity.pid
         FROM pg_stat_activity activity
         JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
       )
       SELECT count(*) FROM pg_stat_activity
       WHERE pid IN (SELECT pid FROM blocked WHERE pid <> $1)
         AND datname = current_database()
         AND wait_event_type = 'Lock'`,
      [holderPid],
    );
    return Number(result.rows[0]?.count);
  };
  const waitForLockWaiters = (count: number) =>
    expect.poll(lockWaiters, { timeout: 5000, interval: 10 }).toBe(count);

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
      await waitForLockWaiters(2);
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
      await waitForLockWaiters(1);
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
      await waitForLockWaiters(1);
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

  it("the draft reaper skips drafts a write holds", async () => {
    const p = await project();
    const x = await card(p.slug, "X");
    const d1 = await uploadDraft(p.slug, x);
    const d2 = await uploadDraft(p.slug, x);
    expect(d1).toBeLessThan(d2);
    // Both past a 24-hour threshold, d2 the older: the reaper's index on
    // created_at meets d2 first. Not a zero threshold, which would reach
    // drafts other suites have on the server.
    await observer.query(
      "UPDATE attachments SET created_at = now() - interval '25 hours' WHERE id = $1",
      [d1],
    );
    await observer.query(
      "UPDATE attachments SET created_at = now() - interval '26 hours' WHERE id = $1",
      [d2],
    );

    // The holder attaches both drafts the way a write does: the card, then
    // the drafts in id order.
    const lines: string[] = [];
    await holder.query("BEGIN");
    let reaping: ReturnType<typeof reapDraftAttachments> | undefined;
    try {
      await holder.query(
        "SELECT id FROM issues WHERE id = $1 FOR NO KEY UPDATE",
        [x.id],
      );
      await holder.query("UPDATE attachments SET draft = false WHERE id = $1", [
        d1,
      ]);
      let settled = false;
      // The storage the drafts were uploaded to, with the router whose
      // connections scan by index.
      reaping = reapDraftAttachments(indexed.ctx.router, t.ctx.storage, {
        dryRun: false,
        minAgeHours: 24,
        log: (line) => lines.push(line),
      }).finally(() => {
        settled = true;
      });
      await expect
        .poll(async () => settled || (await lockWaiters()) > 0, {
          timeout: 5000,
          interval: 10,
        })
        .toBe(true);
      await holder.query("UPDATE attachments SET draft = false WHERE id = $1", [
        d2,
      ]);
      await holder.query("COMMIT");
      const report = await reaping;
      expect(report.failedProjects).toBe(0);
      expect(lines.filter((line) => line.startsWith("FAIL"))).toEqual([]);
      const left = await observer.query<{ id: string; draft: boolean }>(
        "SELECT id, draft FROM attachments WHERE id = ANY($1) ORDER BY id",
        [[d1, d2]],
      );
      // d1 was attached; d2 was either reaped or attached.
      expect(left.rows[0]).toEqual({ id: String(d1), draft: false });
      expect(left.rows.slice(1).map((row) => row.draft)).not.toContain(true);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([reaping]);
    }
  });
});
