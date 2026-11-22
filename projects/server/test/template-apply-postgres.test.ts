import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

// PGlite runs one transaction at a time, so a card cannot move while an apply
// is under way. Here an external transaction holds the move open and the test
// watches PostgreSQL's lock waiters; scheduling is never a timed guess.
describe.skipIf(!PG_URL)("applying a template on PostgreSQL", () => {
  let t: TestApp;
  let cookie: string;
  let holder: pg.Client;
  let observer: pg.Client;
  let holderPid: number;
  const slug = `apply-pg-${Date.now().toString(36)}`;

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    holder = new pg.Client({ connectionString: PG_URL });
    observer = new pg.Client({ connectionString: PG_URL });
    await holder.connect();
    await observer.connect();
    const result = await holder.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    holderPid = result.rows[0]!.pid;
  });

  afterAll(async () => {
    await holder?.end();
    await observer?.end();
    await t?.cleanup();
  });

  const call = (method: string, path: string, body?: unknown) =>
    Promise.resolve(
      t.app.request(`/api${path}`, {
        method,
        headers: { "content-type": "application/json", cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  async function created(path: string, body: unknown): ReturnType<typeof json> {
    const res = await call("POST", path, body);
    expect(res.status, path).toBe(201);
    return json(res);
  }

  async function waitersOnHolder() {
    const result = await observer.query<{ count: string }>(
      `SELECT count(*) FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    );
    return Number(result.rows[0]?.count);
  }

  it("skips a status a card moves into while the apply deletes it, and does the rest", async () => {
    await created("/projects", { slug, name: slug });
    // Neither is in Basic, so the preview offers to delete both.
    const parked = await created(`/projects/${slug}/statuses`, {
      name: "Parked",
      category: "open",
    });
    const docs = await created(`/projects/${slug}/labels`, {
      name: "kind:docs",
    });
    const card = await created(`/projects/${slug}/issues`, { title: "moving" });
    const preview = await call("POST", `/projects/${slug}/template/preview`, {
      template: "basic",
    });
    expect(preview.status).toBe(200);
    const { expected } = await json(preview);

    // The card's move into Parked, not yet committed: the apply's snapshot
    // misses it, and its delete of Parked waits on the move.
    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("UPDATE issues SET status_id = $1 WHERE id = $2", [
        parked.id,
        card.id,
      ]);
      pending = call("POST", `/projects/${slug}/template/apply`, {
        template: "basic",
        expected,
        selected: [`status.delete:${parked.id}`, `label.delete:${docs.id}`],
      });
      await expect
        .poll(waitersOnHolder, { timeout: 5000, interval: 10 })
        .toBe(1);
      await holder.query("COMMIT");
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({
        skipped: [`status.delete:${parked.id}`],
      });
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([pending]);
    }
    const statuses = await json(
      await call("GET", `/projects/${slug}/statuses`),
    );
    expect(statuses.map((x: { id: number }) => x.id)).toContain(parked.id);
    const labels = await json(await call("GET", `/projects/${slug}/labels`));
    expect(labels.map((x: { id: number }) => x.id)).not.toContain(docs.id);
  });
});
