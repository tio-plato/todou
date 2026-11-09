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
    // created_at meets d2 first.
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

  it("a command that removes and re-adds a label queues behind its deletion", async () => {
    const p = await project();
    const x = await card(p.slug, "X");
    const created = await send("POST", `/projects/${p.slug}/labels`, {
      name: "L",
    });
    expect(created.status).toBe(201);
    const label = (await json(created)).id as number;
    const labeled = await send(
      "PATCH",
      `/projects/${p.slug}/issues/${x.number}`,
      {
        label_ids: [label],
      },
    );
    expect(labeled.status).toBe(200);

    // The holder deletes the label: the label row first, then the card rows
    // its cascade removes. It rolls back, so the label is still there for
    // the command to put back.
    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("SELECT id FROM labels WHERE id = $1 FOR UPDATE", [
        label,
      ]);
      pending = send(
        "POST",
        `/projects/${p.slug}/issues/${x.number}/commands`,
        {
          body: "",
          commands: [
            { type: "label_remove", label_id: label },
            { type: "label_add", label_id: label },
          ],
        },
      );
      await waitForLockWaiters(1);
      await holder.query("DELETE FROM labels WHERE id = $1", [label]);
      await holder.query("ROLLBACK");
      expect((await pending).status).toBe(200);
      const kept = await observer.query<{ label_id: string }>(
        "SELECT label_id FROM issue_labels WHERE issue_id = $1",
        [x.id],
      );
      expect(kept.rows).toEqual([{ label_id: String(label) }]);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([pending]);
    }
  });

  it("a command removing a label that is being deleted reads the card after it", async () => {
    const p = await project();
    const x = await card(p.slug, "X");
    const created = await send("POST", `/projects/${p.slug}/labels`, {
      name: "L",
    });
    expect(created.status).toBe(201);
    const label = (await json(created)).id as number;
    const labeled = await send(
      "PATCH",
      `/projects/${p.slug}/issues/${x.number}`,
      {
        label_ids: [label],
      },
    );
    expect(labeled.status).toBe(200);

    // The holder deletes the label and commits: the command finds the card
    // without it, and owes no event for a removal it did not make.
    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("SELECT id FROM labels WHERE id = $1 FOR UPDATE", [
        label,
      ]);
      pending = send(
        "POST",
        `/projects/${p.slug}/issues/${x.number}/commands`,
        { body: "", commands: [{ type: "label_remove", label_id: label }] },
      );
      await waitForLockWaiters(1);
      await holder.query("DELETE FROM labels WHERE id = $1", [label]);
      await holder.query("COMMIT");
      expect((await pending).status).toBe(200);
      const removed = await observer.query<{ count: string }>(
        `SELECT count(*) FROM issue_events
         WHERE issue_id = $1 AND type = 'label_removed'`,
        [x.id],
      );
      expect(removed.rows).toEqual([{ count: "0" }]);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([pending]);
    }
  });

  it("marking everything read locks read positions in id order", async () => {
    const p = await project();
    const a = await card(p.slug, "a");
    const b = await card(p.slug, "b");
    // Reading a again writes a new version of its position, behind b's.
    for (const x of [a, b, a]) {
      const read = await send(
        "PUT",
        `/projects/${p.slug}/issues/${x.number}/read`,
        {},
      );
      expect(read.status).toBe(204);
    }
    const positions = await observer.query<{ id: string; issue_id: string }>(
      "SELECT id, issue_id FROM issue_reads WHERE issue_id = ANY($1)",
      [[a.id, b.id]],
    );
    const idOf = (x: { id: number }) =>
      Number(positions.rows.find((row) => Number(row.issue_id) === x.id)?.id);
    const [ra, rb] = [idOf(a), idOf(b)];
    expect(ra).toBeLessThan(rb);
    expect(await physicalOrder("issue_reads", [ra, rb])).toEqual([rb, ra]);
    const [start] = (await observer.query<{ now: Date }>("SELECT now() AS now"))
      .rows;

    // The holder is another "mark all read" by the same reader.
    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      await holder.query(
        "SELECT id FROM issue_reads WHERE id = $1 FOR UPDATE",
        [ra],
      );
      pending = send("PUT", "/me/read", { projects: [p.slug] }, seq);
      await waitForLockWaiters(1);
      await holder.query(
        "SELECT id FROM issue_reads WHERE id = $1 FOR UPDATE",
        [rb],
      );
      await holder.query("COMMIT");
      expect((await pending).status).toBe(204);
      const after = await observer.query<{ seen: boolean }>(
        "SELECT last_seen_at >= $2 AS seen FROM issue_reads WHERE id = ANY($1)",
        [[ra, rb], start?.now],
      );
      expect(after.rows).toEqual([{ seen: true }, { seen: true }]);
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
  let admin: pg.Client | undefined;
  const owned: string[] = [];
  let t: TestApp;
  let author: { headers: { authorization: string } };
  const clients: pg.Client[] = [];
  const stamp = Date.now().toString(36);
  let pause:
    | { step: number; reached: () => void; release: Promise<void> }
    | undefined;
  const projects: Array<{ slug: string; id: number; url: string }> = [];
  let systemUrl: string;

  const send = (method: string, path: string, body?: unknown) =>
    Promise.resolve(
      t.app.request(`/api${path}`, {
        method,
        headers: { ...author.headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  const databaseUrl = (name: string, options?: string) => {
    const url = new URL(PG_URL as string);
    url.pathname = `/${name}`;
    url.searchParams.delete("database");
    url.searchParams.delete("dbname");
    if (options !== undefined) url.searchParams.set("options", options);
    return url.toString();
  };

  beforeAll(async () => {
    if (!PG_URL) return;
    admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    // Only generated identifiers enter CREATE/DROP DATABASE.
    const base = `lock_moves_${randomUUID().replaceAll("-", "")}`;
    for (const name of [base, `${base}_b0`, `${base}_b1`]) {
      await admin.query(`CREATE DATABASE "${name}"`);
      owned.push(name);
    }
    systemUrl = databaseUrl(base);
    const scanning = "-c enable_indexscan=off -c enable_bitmapscan=off";
    const template = databaseUrl(`${base}_b`, scanning).replace(
      /_b(\?|$)/,
      `_b\${project.id % 2}$1`,
    );
    t = await makeTestApp(
      "dedicated",
      { systemUrl: databaseUrl(base, scanning), urlTemplate: template },
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
    try {
      for (const name of owned) await admin?.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin?.end();
    }
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

  /** Sessions in `observer`'s database queued behind `pid`, at any depth. */
  const waitersOn = async (observer: pg.Client, pid: number) => {
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
      [pid],
    );
    return Number(result.rows[0]?.count);
  };
  const pidOf = async (client: pg.Client) =>
    Number(
      (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]?.pid,
    );

  const card = async (slug: string, title: string) => {
    const created = await send("POST", `/projects/${slug}/issues`, { title });
    expect(created.status).toBe(201);
    return (await json(created)) as { id: number; number: number };
  };
  const uploadDraft = async (slug: string, number: number) => {
    const form = new FormData();
    form.set("file", new File(["draft"], "draft.txt"));
    form.set("issue_number", String(number));
    form.set("draft", "true");
    const res = await t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: author.headers,
      body: form,
    });
    expect(res.status).toBe(201);
    return (await json(res)).id as number;
  };

  /** Waits for the pause, or fails if the move ends before reaching it. */
  const reach = (atStep: Promise<void>, moving: Promise<Response>) =>
    Promise.race([
      atStep,
      moving.then((res) => {
        throw new Error(`the move ended before its pause: ${res.status}`);
      }),
    ]);

  // The holder attaches two drafts on the frozen card the way a write does:
  // the card, then the drafts. The step that deletes the card's attachment
  // rows meets d2 first, so it has to wait for the card before it touches
  // either.
  const draftsRace = async (
    from: { slug: string; url: string },
    to: { slug: string },
    after: 2 | 4,
    f: { id: number; number: number },
  ) => {
    const d1 = await uploadDraft(from.slug, f.number);
    const d2 = await uploadDraft(from.slug, f.number);
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
        .poll(() => waitersOn(observer, pid), { timeout: 5000, interval: 10 })
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
    if (!from || !to) throw new Error("no projects");
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
    const first = await connect(systemUrl);
    const second = await connect(systemUrl);
    const observer = await connect(systemUrl);
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
        .poll(() => waitersOn(observer, firstPid), {
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
        .poll(() => waitersOn(observer, firstPid), {
          timeout: 5000,
          interval: 10,
        })
        .toBe(2);
      await first.query("COMMIT");
      await queued;
      // Either the move is done with the edges, or it waits on the second.
      await expect
        .poll(
          async () => settled || (await waitersOn(observer, secondPid)) > 0,
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
