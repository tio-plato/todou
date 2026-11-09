import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relabelAttachments } from "../src/services/attachment-relabel.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (response: Response): Promise<any> => response.json();
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

type Card = { id: number; number: number };

// PGlite serializes on its one connection, so the race never shows there.
// An outside connection holds the card the way a server write does, the
// card first and then the rows under it, and plays the write racing relabel.
describe.skipIf(!PG_URL)("attachments relabel on PostgreSQL", () => {
  let t: TestApp;
  let holder: pg.Client;
  let observer: pg.Client;
  let holderPid: number;
  let author: { headers: { authorization: string } };
  let projectId = 0;
  let attachmentId = 0;
  let original = "";
  const stamp = Date.now().toString(36);
  const slug = `relabel-pg-${stamp}`;
  const lines: string[] = [];

  const send = (method: string, path: string, body?: unknown) =>
    Promise.resolve(
      t.app.request(`/api${path}`, {
        method,
        headers: { ...author.headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const at = (name: string) =>
    `/api/projects/${projectId}/attachments/${attachmentId}/download/${name}`;
  const renamed = () => {
    const name = `foo-${attachmentId}.png`;
    return `[${name}](${at(name)})`;
  };

  const card = async (title: string): Promise<Card> => {
    const created = await send("POST", `/projects/${slug}/issues`, { title });
    expect(created.status).toBe(201);
    return json(created);
  };
  const comment = async (x: Card, body: string): Promise<number> => {
    const posted = await send(
      "POST",
      `/projects/${slug}/issues/${x.number}/comments`,
      { body },
    );
    expect(posted.status).toBe(201);
    return (await json(posted)).id;
  };
  const commentBody = async (id: number) =>
    (
      await observer.query<{ body: string }>(
        "SELECT body FROM comments WHERE id = $1",
        [id],
      )
    ).rows[0]?.body;
  const relabel = () => {
    lines.length = 0;
    return relabelAttachments(
      { router: t.ctx.router },
      { dryRun: false, slug, log: (line) => lines.push(line) },
    );
  };

  beforeAll(async () => {
    if (!PG_URL) return;
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    holder = new pg.Client({ connectionString: PG_URL });
    observer = new pg.Client({ connectionString: PG_URL });
    await holder.connect();
    await observer.connect();
    const [backend] = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows;
    if (!backend) throw new Error("holder has no backend pid");
    holderPid = backend.pid;
    author = await addUserWithToken(t.ctx, `${slug}-author`);

    const created = await send("POST", "/projects", {
      slug,
      name: "Relabel on PostgreSQL",
    });
    expect(created.status).toBe(201);
    projectId = (await json(created)).id;
    const first = await card("with a renamed attachment");

    const form = new FormData();
    form.set("file", new File(["bytes"], "foo.png", { type: "text/plain" }));
    form.set("issue_number", String(first.number));
    const uploaded = await t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: author.headers,
      body: form,
    });
    expect(uploaded.status).toBe(201);
    attachmentId = (await json(uploaded)).id;
    // What migration 0013 leaves behind: the row carries the new name, the
    // `attachment_added` event still the old one.
    await observer.query("UPDATE attachments SET filename = $1 WHERE id = $2", [
      `foo-${attachmentId}.png`,
      attachmentId,
    ]);

    // Every case links this one attachment from a card of its own.
    const sent = `[foo.png](${at("foo.png")})`;
    original = (await commentBody(await comment(first, sent))) ?? "";
    // The expected text below is built from this one.
    expect(original).toBe(sent);
    await relabel();
  });

  afterAll(async () => {
    await Promise.allSettled([holder?.end(), observer?.end()]);
    await t?.cleanup();
  });

  /** Connections queued behind the holder, directly or behind one another. */
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

  /**
   * Run relabel while the holder has done `before` in an open transaction,
   * wait until relabel queues behind it, then let the holder do `after` and
   * commit.
   */
  const behindHolder = async (
    before: () => Promise<unknown>,
    after: () => Promise<unknown> = async () => {},
  ) => {
    await holder.query("BEGIN");
    let running: Promise<unknown> | undefined;
    try {
      await before();
      running = relabel();
      await waitForLockWaiters(1);
      await after();
      await holder.query("COMMIT");
      await running;
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([running]);
    }
  };
  const lockCard = (x: Card, mode: string) =>
    holder.query(`SELECT id FROM issues WHERE id = $1 FOR ${mode}`, [x.id]);

  it("an edit committed while relabel runs survives it", async () => {
    const x = await card("edited before relabel read it");
    const id = await comment(x, original);
    const added = "\n\nadded while relabel ran";
    const edited = `${original}${added}`;

    await behindHolder(async () => {
      await lockCard(x, "NO KEY UPDATE");
      await holder.query("UPDATE comments SET body = $1 WHERE id = $2", [
        edited,
        id,
      ]);
    });

    expect(await commentBody(id)).toBe(`${renamed()}${added}`);
    // The revision holds what this rewrite replaced: the edit, not the text
    // relabel first read.
    const revision = await observer.query<{ body: string }>(
      `SELECT body FROM revisions
       WHERE subject_type = 'comment' AND subject_id = $1
       ORDER BY id DESC LIMIT 1`,
      [id],
    );
    expect(revision.rows[0]?.body).toBe(edited);
  });

  it("queues behind a write holding the card instead of deadlocking", async () => {
    const x = await card("edited while relabel waits");
    const id = await comment(x, original);
    const added = "\n\nadded once relabel waited";

    // The comment is written only once relabel waits for the card: had
    // relabel locked the comment first, each would wait for the other.
    await behindHolder(
      () => lockCard(x, "NO KEY UPDATE"),
      () =>
        holder.query("UPDATE comments SET body = $1 WHERE id = $2", [
          `${original}${added}`,
          id,
        ]),
    );

    expect(await commentBody(id)).toBe(`${renamed()}${added}`);
  });

  it.each(["comment", "spec file"])(
    "writes nothing for a %s deleted while it waited for the card",
    async (kind) => {
      const x = await card(`its ${kind} goes`);
      let remove: () => Promise<unknown>;
      let id = 0;
      if (kind === "comment") {
        id = await comment(x, original);
        remove = () => holder.query("DELETE FROM comments WHERE id = $1", [id]);
      } else {
        const pushed = await send(
          "POST",
          `/projects/${slug}/issues/${x.number}/spec/push`,
          { files: [{ path: "plan.md", body: `see ${original}\n` }] },
        );
        expect(pushed.status).toBeLessThan(300);
        remove = () =>
          holder.query(
            `DELETE FROM spec_version_files WHERE version_id IN
               (SELECT id FROM spec_versions WHERE issue_id = $1)`,
            [x.id],
          );
      }

      // A move and a project delete take the card FOR UPDATE, then delete
      // the rows under it. Relabel waits for the card and finds the text
      // gone; had it locked the text first, each would wait for the other.
      await behindHolder(() => lockCard(x, "UPDATE"), remove);

      expect(
        lines.filter((line) => line.startsWith(`${slug}/${x.number} `)),
      ).toEqual([]);
      const revisions = await observer.query<{ count: string }>(
        `SELECT count(*) FROM revisions
         WHERE subject_type = 'comment' AND subject_id = $1`,
        [id],
      );
      expect(Number(revisions.rows[0]?.count)).toBe(0);
    },
  );

  it("leaves a card alone that a move froze while relabel waited for it", async () => {
    const x = await card("frozen while relabel waits");
    const id = await comment(x, original);

    try {
      await behindHolder(() =>
        holder.query("UPDATE issues SET moving_since = now() WHERE id = $1", [
          x.id,
        ]),
      );
      expect(await commentBody(id)).toBe(original);
      const named = lines.filter((line) =>
        line.startsWith(`${slug}/${x.number} `),
      );
      expect(named).toHaveLength(1);
      expect(named[0]).not.toContain("→");
    } finally {
      await observer.query(
        "UPDATE issues SET moving_since = NULL WHERE id = $1",
        [x.id],
      );
    }
  });

  it("does not wait for a write that only inserts under the card", async () => {
    const x = await card("a row is being added under it");
    const id = await comment(x, original);

    // The KEY SHARE a foreign-key check takes on the card when a write
    // inserts an event or a mention under it.
    await holder.query("BEGIN");
    let running: Promise<unknown> | undefined;
    try {
      await lockCard(x, "KEY SHARE");
      running = relabel();
      const finished = await Promise.race([
        running.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      expect(finished).toBe(true);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([running]);
    }
    expect(await commentBody(id)).toBe(renamed());
  });
});
