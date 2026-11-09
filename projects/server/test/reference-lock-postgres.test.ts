import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (response: Response): Promise<any> => response.json();
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

type Card = { id: number; number: number };

// PGlite serializes on its one connection, so lock order never shows there.
// External connections hold locks between two statements of a request and
// play the writes racing it.
describe.skipIf(!PG_URL)("reference lock order", () => {
  let t: TestApp;
  let holder: pg.Client;
  let m2: pg.Client;
  let c2: pg.Client;
  let observer: pg.Client;
  let author: { headers: { authorization: string } };
  let projectId: number;
  const stamp = Date.now().toString(36);
  const slug = `reflock-pg-${stamp}`;
  const headers = () => ({
    ...author.headers,
    "content-type": "application/json",
  });
  const send = (method: string, path: string, body?: unknown) =>
    Promise.resolve(
      t.app.request(`/api${path}`, {
        method,
        headers: headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const createProject = async (projectSlug: string): Promise<number> => {
    const created = await send("POST", "/projects", {
      slug: projectSlug,
      name: "Reference lock order",
    });
    expect(created.status).toBe(201);
    return (await json(created)).id;
  };
  const createCard = async (projectSlug: string, title: string) => {
    const created = await send("POST", `/projects/${projectSlug}/issues`, {
      title,
    });
    expect(created.status).toBe(201);
    return (await json(created)) as Card;
  };
  const referencedOf = async (projectSlug: string, number: number) => {
    const res = await send(
      "GET",
      `/projects/${projectSlug}/issues/${number}/timeline?types=referenced&limit=100`,
    );
    expect(res.status).toBe(200);
    return (await json(res)).items as Array<{
      payload: Record<string, unknown>;
    }>;
  };
  const pidOf = async (client: pg.Client) =>
    (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]?.pid;
  // Counted by blocker rather than by query text: other suites share this
  // database, and what matters is who the waiter waits on, not which
  // statement it waits in.
  const blockedBy = (pid: number | undefined) =>
    expect
      .poll(
        async () => {
          const result = await observer.query<{ count: string }>(
            `SELECT count(*) FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`,
            [pid],
          );
          return Number(result.rows[0]?.count);
        },
        { timeout: 5000, interval: 10 },
      )
      .toBe(1);

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    holder = new pg.Client({ connectionString: PG_URL });
    m2 = new pg.Client({ connectionString: PG_URL });
    c2 = new pg.Client({ connectionString: PG_URL });
    observer = new pg.Client({ connectionString: PG_URL });
    await Promise.all([holder, m2, c2, observer].map((c) => c.connect()));
    author = await addUserWithToken(t.ctx, `${slug}-author`);
    projectId = await createProject(slug);
  });

  afterAll(async () => {
    await Promise.allSettled([holder, m2, c2, observer].map((c) => c?.end()));
    await t?.cleanup();
  });

  // The holder is the write on B that references A: it writes B's row, then
  // locks A. B has the smaller id, so that is also the order the fixed server
  // takes them in.
  const race = async (request: (a: Card, b: Card) => Promise<Response>) => {
    const b = await createCard(slug, "B");
    const a = await createCard(slug, "A");
    expect(a.id).toBeGreaterThan(b.id);

    const pid = await pidOf(holder);
    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("UPDATE issues SET updated_at = now() WHERE id = $1", [
        b.id,
      ]);
      pending = request(a, b);
      await blockedBy(pid);
      await holder.query("SELECT id FROM issues WHERE id = $1 FOR SHARE", [
        a.id,
      ]);
      await holder.query("COMMIT");
      return { a, b, response: await pending };
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([pending]);
    }
  };

  it("a comment referencing a card waits for it before locking its own", async () => {
    const { a, b, response } = await race((a, b) =>
      send("POST", `/projects/${slug}/issues/${a.number}/comments`, {
        body: `see #${b.number}`,
      }),
    );
    expect(response.status).toBe(201);
    const comment = await json(response);
    const events = await referencedOf(slug, b.number);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      by_issue: a.number,
      by_comment: comment.id,
    });
  });

  it("a body edit referencing a card waits for it before locking its own", async () => {
    const { a, b, response } = await race((a, b) =>
      send("PATCH", `/projects/${slug}/issues/${a.number}`, {
        body: `see #${b.number}`,
      }),
    );
    expect(response.status).toBe(200);
    const events = await referencedOf(slug, b.number);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ by_issue: a.number });
  });

  // The four-way cycle between creating and moving cards. The request
  // creates a card in T whose body references T's card tCard; the holder is
  // m1 and, with m2 and c2, plays the other three: moving tCard to S (lock
  // it, then S's project_meta), creating a card in S the way the server did
  // before (S's project_meta, then share-lock sCard), and moving sCard to T
  // (lock it, then T's project_meta).
  it("a new card locks the cards it references before taking a number", async () => {
    const m1 = holder;
    const other = `reflock-pg-s-${stamp}`;
    const otherId = await createProject(other);
    const tCard = await createCard(slug, "t");
    const sCard = await createCard(other, "s");

    const [m1Pid, m2Pid, c2Pid] = await Promise.all([m1, m2, c2].map(pidOf));
    const takeNumber =
      "UPDATE project_meta SET next_issue_number = next_issue_number + 1 WHERE project_id = $1";
    await Promise.all([m1, m2, c2].map((c) => c.query("BEGIN")));
    const pending: Array<Promise<unknown>> = [];
    try {
      await m1.query("SELECT id FROM issues WHERE id = $1 FOR UPDATE", [
        tCard.id,
      ]);
      await m2.query("SELECT id FROM issues WHERE id = $1 FOR UPDATE", [
        sCard.id,
      ]);
      await c2.query(takeNumber, [otherId]);

      const created = send("POST", `/projects/${slug}/issues`, {
        title: "new",
        body: `see #${tCard.number}`,
      });
      pending.push(created);
      await blockedBy(m1Pid);

      const m1Number = m1.query(takeNumber, [otherId]);
      pending.push(m1Number);
      await blockedBy(c2Pid);

      const c2Share = c2.query(
        "SELECT id FROM issues WHERE id = $1 FOR SHARE",
        [sCard.id],
      );
      pending.push(c2Share);
      await blockedBy(m2Pid);

      await m2.query(takeNumber, [projectId]);
      await m2.query("COMMIT");
      await c2Share;
      await c2.query("COMMIT");
      await m1Number;
      await m1.query("COMMIT");

      const response = await created;
      expect(response.status).toBe(201);
      const issue = (await json(response)) as Card;
      const events = await referencedOf(slug, tCard.number);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ by_issue: issue.number });
    } finally {
      await Promise.allSettled([m1, m2, c2].map((c) => c.query("ROLLBACK")));
      await Promise.allSettled(pending);
    }
  });
});
