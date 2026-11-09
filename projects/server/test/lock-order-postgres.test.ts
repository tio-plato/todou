import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  let holder: pg.Client;
  let observer: pg.Client;
  let holderPid: number;
  let author: { headers: { authorization: string } };
  const stamp = Date.now().toString(36);
  let projects = 0;

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

  /** Requests queued behind the holder, directly or behind one another. */
  const waitForLockWaiters = (count: number) =>
    expect
      .poll(
        async () => {
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
        },
        { timeout: 5000, interval: 10 },
      )
      .toBe(count);

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
});
