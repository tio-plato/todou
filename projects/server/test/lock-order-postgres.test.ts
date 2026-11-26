import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";
import {
  lockWaiters,
  pidOf,
  uploadDraft,
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
});
