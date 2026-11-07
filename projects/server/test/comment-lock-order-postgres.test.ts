import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (response: Response): Promise<any> => response.json();
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

// PGlite serializes on its one connection, so lock order never shows there;
// an outside connection holds the locks and plays the transaction that runs
// alongside the request. The suite makes a database of its own: a plan that
// scans in physical order meets rows where they sit in the table, and only a
// new table holds them where these cases put them. In the database the other
// suites share, rows land in the gaps their deletes and VACUUM leave, and a
// bigger table can change the plan.
describe.skipIf(!PG_URL)("bulk comment locks on PostgreSQL", () => {
  let admin: pg.Client | undefined;
  let owned: string | undefined;
  let t: TestApp | undefined;
  let holder: pg.Client | undefined;
  let observer: pg.Client | undefined;
  let holderPid: number;
  let author: { headers: { authorization: string } };
  const slug = "comment-lock-order";
  const request = (method: string, path: string, body?: unknown) => {
    if (!t) throw new Error("app not started");
    return Promise.resolve(
      t.app.request(`/api/projects/${slug}${path}`, {
        method,
        headers: { ...author.headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  };
  const post = (path: string, body: unknown) => request("POST", path, body);
  const db = () => {
    if (!holder || !observer) throw new Error("clients not connected");
    return { holder, observer };
  };

  beforeAll(async () => {
    if (!PG_URL) return;
    admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    // Only a generated identifier enters CREATE/DROP DATABASE.
    const name = `comment_lock_${randomUUID().replaceAll("-", "")}`;
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
    const pid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]?.pid;
    if (pid === undefined) throw new Error("no backend pid");
    holderPid = pid;
    author = await addUserWithToken(t.ctx, "lock-order-author");
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: { ...author.headers, "content-type": "application/json" },
      body: JSON.stringify({ slug, name: "Comment lock order" }),
    });
    expect(created.status).toBe(201);
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

  const createIssue = async (title: string) => {
    const created = await post("/issues", { title });
    expect(created.status).toBe(201);
    return ((await json(created)) as { number: number }).number;
  };

  const addComment = async (number: number, body: string) => {
    const created = await post(`/issues/${number}/comments`, { body });
    expect(created.status).toBe(201);
    return ((await json(created)) as { id: number }).id;
  };

  // `body` is in a trigram index, so editing it is not a HOT update: the new
  // version lands after `higher`, and a plan that scans in physical order
  // meets `higher` first. Both halves are checked rather than assumed, the
  // layout and a plan that scans the heap in place, so that a layout or a
  // plan this no longer produces fails here instead of letting the race pass
  // vacuously: an index scan would lock in id order with or without the fix.
  const editBehind = async (number: number, lower: number, higher: number) => {
    const edited = await request(
      "PATCH",
      `/issues/${number}/comments/${lower}`,
      { body: "edited so the row moves" },
    );
    expect(edited.status).toBe(200);
    const { observer } = db();
    const layout = await observer.query<{ id: string; issue_id: string }>(
      "SELECT id, issue_id FROM comments WHERE id = ANY($1::bigint[]) ORDER BY ctid",
      [[lower, higher]],
    );
    expect(layout.rows.map((row) => Number(row.id))).toEqual([higher, lower]);
    const explained = await observer.query<{
      "QUERY PLAN": Array<{ Plan: { Plans?: Array<{ "Node Type": string }> } }>;
    }>(
      `EXPLAIN (FORMAT JSON) SELECT id FROM comments
       WHERE issue_id = $1 AND id IN ($2, $3) FOR UPDATE`,
      [layout.rows[0]?.issue_id, lower, higher],
    );
    const scan = explained.rows[0]?.["QUERY PLAN"][0]?.Plan.Plans?.[0];
    expect(["Bitmap Heap Scan", "Seq Scan"]).toContain(scan?.["Node Type"]);
  };

  // The holder is a transaction that keeps the order, locking the two rows by
  // id. A request that also locks by id waits on `lower` holding no comment
  // row; one that locks in physical order already holds `higher`, and the
  // holder's second lock closes the cycle. (A hide holds the card before its
  // comments, so no real write plays the holder's part any more; the case
  // pins that several comments are still taken in id order.)
  const race = async (
    lower: number,
    higher: number,
    send: () => Promise<Response>,
  ) => {
    const { holder, observer } = db();
    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("SELECT id FROM comments WHERE id = $1 FOR UPDATE", [
        lower,
      ]);
      pending = send();
      await expect
        .poll(
          async () => {
            const result = await observer.query<{ count: string }>(
              `SELECT count(*) FROM pg_stat_activity
               WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`,
              [holderPid],
            );
            return Number(result.rows[0]?.count);
          },
          { timeout: 5000, interval: 10 },
        )
        .toBe(1);
      await holder.query("SELECT id FROM comments WHERE id = $1 FOR UPDATE", [
        higher,
      ]);
      await holder.query("COMMIT");
      return await pending;
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([pending]);
    }
  };

  it("a hide takes the comments it hides in id order", async () => {
    const number = await createIssue("Hide two comments");
    const lower = await addComment(number, "first");
    const higher = await addComment(number, "second");
    await editBehind(number, lower, higher);

    const hidden = await race(lower, higher, () =>
      post(`/issues/${number}/comments/hide`, {
        comment_ids: [lower, higher],
        hidden: true,
      }),
    );
    expect(hidden.status).toBe(200);
    expect(await json(hidden)).toMatchObject({
      hidden: [lower, higher],
      unchanged: [],
    });
  });

  it("a command submission takes the comments it hides in id order", async () => {
    const number = await createIssue("Hide two comments with a conclusion");
    const lower = await addComment(number, "first");
    const higher = await addComment(number, "second");
    await editBehind(number, lower, higher);

    const submitted = await race(lower, higher, () =>
      post(`/issues/${number}/commands`, {
        body: "the conclusion",
        commands: [
          {
            type: "comments_hide",
            hidden: true,
            comment_ids: [lower, higher],
          },
        ],
      }),
    );
    expect(submitted.status).toBe(200);
    expect((await json(submitted)).hide.unchanged).toEqual([]);
  });

  it("a resolve takes the annotations it resolves in id order", async () => {
    const number = await createIssue("Resolve two annotations");
    const pushed = await post(`/issues/${number}/spec/push`, {
      files: [{ path: "design.md", body: "One.\nTwo.\n" }],
    });
    expect(pushed.status).toBe(200);
    const annotation = (line: number) => ({
      anchor: {
        version: 1,
        path: "design.md",
        line_start: line,
        line_end: line,
      },
      body: `line ${line}`,
    });
    const reviewed = await post(`/issues/${number}/spec/reviews`, {
      version: 1,
      verdict: "comment",
      comments: [annotation(1), annotation(2)],
    });
    expect(reviewed.status).toBe(201);
    const [lower, higher] = ((await json(reviewed)).comment_ids as number[])
      .slice()
      .sort((a, b) => a - b);
    if (lower === undefined || higher === undefined) {
      throw new Error("missing annotations");
    }
    await editBehind(number, lower, higher);

    const resolved = await race(lower, higher, () =>
      post(`/issues/${number}/spec/comments/resolve`, {
        comment_ids: [lower, higher],
      }),
    );
    expect(resolved.status).toBe(200);
    expect(await json(resolved)).toEqual({ resolved: [lower, higher] });
  });
});
