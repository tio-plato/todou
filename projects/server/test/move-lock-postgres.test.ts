import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../src/auth/pat.ts";
import { type FakeS3, startFakeS3 } from "./fake-s3.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (response: Response): Promise<any> => response.json();
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

type Card = { id: number; number: number };

// PGlite serializes on its one connection, so lock order never shows there.
// An outside connection holds a lock between two statements of a request:
// it plays the write running alongside a move, or parks the move halfway.
// The suite makes a database of its own: test files that start together on
// a new database race to create its migration tables.
describe.skipIf(!PG_URL)("moves and writes on PostgreSQL", () => {
  let admin: pg.Client | undefined;
  let owned: string | undefined;
  let t: TestApp;
  let fake: FakeS3 | undefined;
  let holder: pg.Client;
  let observer: pg.Client;
  let holderPid: number;
  let author: { user: UserRow; headers: { authorization: string } };
  let referenced: Card;
  const stamp = Date.now().toString(36);
  const source = `movelock-${stamp}`;
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
    const name = `move_lock_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    owned = name;
    const url = new URL(PG_URL);
    url.pathname = `/${name}`;
    // pg connection strings may specify dbname separately from pathname.
    url.searchParams.delete("database");
    url.searchParams.delete("dbname");
    // A bucket rather than the filesystem, for the direct-upload write.
    fake = await startFakeS3();
    t = await makeTestApp("shared", {
      systemUrl: url.toString(),
      s3: { endpoint: fake.url },
    });
    holder = new pg.Client({ connectionString: url.toString() });
    observer = new pg.Client({ connectionString: url.toString() });
    await holder.connect();
    await observer.connect();
    const [backend] = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows;
    if (!backend) throw new Error("holder has no backend pid");
    holderPid = backend.pid;
    author = await addUserWithToken(t.ctx, `movelock-${stamp}`);
    const created = await send("POST", "/projects", {
      slug: source,
      name: "Move lock order",
    });
    expect(created.status).toBe(201);
    referenced = await card();
  });

  afterAll(async () => {
    // Every connection to the database closes before the drop, even when
    // closing another one fails.
    const closed = await Promise.allSettled([
      holder?.end(),
      observer?.end(),
      t?.cleanup(),
      fake?.close(),
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

  /** A fresh target project for one move. */
  const project = async () => {
    projects += 1;
    const slug = `movelock-${stamp}-to-${projects}`;
    const created = await send("POST", "/projects", { slug, name: slug });
    expect(created.status).toBe(201);
    return { slug, id: (await json(created)).id as number };
  };

  async function card() {
    const created = await send("POST", `/projects/${source}/issues`, {
      title: "Moving",
    });
    expect(created.status).toBe(201);
    return (await json(created)) as Card;
  }

  const comment = async (number: number, body: unknown) => {
    const created = await send(
      "POST",
      `/projects/${source}/issues/${number}/comments`,
      body,
    );
    expect(created.status).toBe(201);
    return json(created);
  };

  const move = (number: number, to: string) =>
    send("POST", `/projects/${source}/issues/${number}/move`, {
      to_project: to,
    });

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

  it("an edit that waited on the card finds its comment deleted", async () => {
    const x = await card();
    const edited = (await comment(x.number, { body: "plain" })).id as number;

    // The holder plays a delete of the comment that holds the card first.
    await holder.query("BEGIN");
    await holder.query(
      "SELECT id FROM issues WHERE id = $1 FOR NO KEY UPDATE",
      [x.id],
    );
    const editing = send(
      "PATCH",
      `/projects/${source}/issues/${x.number}/comments/${edited}`,
      { body: "too late" },
    );
    try {
      await waitForLockWaiters(1);
      await holder.query("DELETE FROM comments WHERE id = $1", [edited]);
      await holder.query("COMMIT");
      const refused = await editing;
      expect(refused.status).toBe(404);
      expect((await json(refused)).error.code).toBe("not_found");
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([editing]);
    }
  });

  const on = (x: Card, path: string) =>
    `/projects/${source}/issues/${x.number}${path}`;
  const upload = (number: number) => {
    const form = new FormData();
    form.set("file", new File(["late"], "late.txt", { type: "text/plain" }));
    form.set("issue_number", String(number));
    return Promise.resolve(
      t.app.request(`/api/projects/${source}/attachments`, {
        method: "POST",
        headers: author.headers,
        body: form,
      }),
    );
  };

  type Write = {
    name: string;
    /** What the write needs on the card, made before the move starts. */
    prepare: (x: Card) => Promise<number>;
    send: (x: Card, prepared: number) => Promise<Response>;
  };
  const nothing = async () => 0;
  const plain = async (x: Card) =>
    (await comment(x.number, { body: "plain" })).id as number;
  const asked = async (x: Card) =>
    (
      await comment(x.number, {
        body: "which one?",
        component: {
          type: "questions",
          questions: [
            { question: "Which?", options: [{ label: "a" }, { label: "b" }] },
          ],
        },
      })
    ).id as number;
  const annotated = async (x: Card) => {
    const pushed = await send("POST", on(x, "/spec/push"), {
      files: [{ path: "design.md", body: "One.\n" }],
    });
    expect(pushed.status).toBe(200);
    const reviewed = await send("POST", on(x, "/spec/reviews"), {
      version: 1,
      verdict: "comment",
      comments: [
        {
          anchor: { version: 1, path: "design.md", line_start: 1, line_end: 1 },
          body: "line 1",
        },
      ],
    });
    expect(reviewed.status).toBe(201);
    const rows = await observer.query<{ id: string }>(
      `SELECT id FROM comments
       WHERE issue_id = $1 AND component ->> 'type' = 'spec_comment'`,
      [x.id],
    );
    return Number(rows.rows[0]?.id);
  };
  const assigned = async (x: Card) => {
    const res = await send("PATCH", on(x, ""), {
      assignee_ids: [author.user.id],
    });
    expect(res.status).toBe(200);
    return author.user.id;
  };
  const uploaded = async (x: Card) => {
    const res = await upload(x.number);
    expect(res.status).toBe(201);
    return (await json(res)).id as number;
  };
  const ticketed = async (x: Card) => {
    const res = await send(
      "POST",
      `/projects/${source}/attachments/direct-uploads`,
      {
        issue_number: x.number,
        filename: "late.txt",
        content_type: "text/plain",
        size: 4,
      },
    );
    expect(res.status).toBe(201);
    const ticket = await json(res);
    const put = await fetch(ticket.url, { method: "PUT", body: "late" });
    expect(put.status).toBe(200);
    return ticket.upload_id as number;
  };
  const hideCommand = (id: number) => ({
    type: "comments_hide",
    hidden: true,
    comment_ids: [id],
  });

  const writes: Write[] = [
    {
      name: "comment",
      prepare: nothing,
      send: (x) => send("POST", on(x, "/comments"), { body: "late" }),
    },
    {
      name: "edit comment referencing a card",
      prepare: plain,
      send: (x, id) =>
        send("PATCH", on(x, `/comments/${id}`), {
          body: `see #${referenced.number}`,
        }),
    },
    {
      name: "delete comment",
      prepare: plain,
      send: (x, id) => send("DELETE", on(x, `/comments/${id}`)),
    },
    {
      name: "answer",
      prepare: asked,
      send: (x, id) =>
        send("POST", on(x, `/comments/${id}/answers`), {
          answers: [{ key: "q1", selected: [0] }],
        }),
    },
    {
      name: "withdraw",
      prepare: asked,
      send: (x, id) =>
        send("POST", on(x, `/comments/${id}/questions/withdraw`), {
          reason: "moot",
        }),
    },
    {
      name: "hide",
      prepare: asked,
      send: (x, id) =>
        send("POST", on(x, "/comments/hide"), {
          hidden: true,
          comment_ids: [id],
        }),
    },
    {
      name: "resolve",
      prepare: annotated,
      send: (x, id) =>
        send("POST", on(x, "/spec/comments/resolve"), { comment_ids: [id] }),
    },
    {
      name: "unassign command",
      prepare: assigned,
      send: (x, userId) =>
        send("POST", on(x, "/commands"), {
          body: "",
          commands: [{ type: "unassign", user_id: userId }],
        }),
    },
    {
      name: "hide command",
      prepare: asked,
      send: (x, id) =>
        send("POST", on(x, "/commands"), {
          body: "",
          commands: [hideCommand(id)],
        }),
    },
    {
      name: "comment and hide command",
      prepare: asked,
      send: (x, id) =>
        send("POST", on(x, "/commands"), {
          body: "the conclusion",
          commands: [hideCommand(id)],
        }),
    },
    {
      name: "edit title",
      prepare: nothing,
      send: (x) => send("PATCH", on(x, ""), { title: "Renamed late" }),
    },
    {
      name: "metadata",
      prepare: nothing,
      send: (x) =>
        send("PATCH", on(x, "/metadata"), {
          entries: [{ namespace: "orch", key: "phase", value: "late" }],
        }),
    },
    { name: "upload", prepare: nothing, send: (x) => upload(x.number) },
    {
      name: "delete attachment",
      prepare: uploaded,
      send: (_x, id) => send("DELETE", `/projects/${source}/attachments/${id}`),
    },
    {
      name: "complete direct upload",
      prepare: ticketed,
      send: (_x, id) =>
        send(
          "POST",
          `/projects/${source}/attachments/direct-uploads/${id}/complete`,
        ),
    },
  ];

  it.each(writes)(
    "a write queued behind a move is refused rather than lost: $name",
    async ({ prepare, send: write }) => {
      const x = await card();
      const prepared = await prepare(x);
      const target = await project();

      // Parks the move once it holds the card, before it takes a number in
      // its target.
      await holder.query("BEGIN");
      await holder.query(
        "UPDATE project_meta SET next_issue_number = next_issue_number WHERE project_id = $1",
        [target.id],
      );
      const moving = move(x.number, target.slug);
      let writing: Promise<Response> | undefined;
      try {
        await waitForLockWaiters(1);
        writing = write(x, prepared);
        // The write waits on the card, behind the move.
        await waitForLockWaiters(2);
        await holder.query("COMMIT");

        expect((await moving).status).toBe(200);
        // Refused by the first statement of its transaction, so it wrote
        // nothing under the tombstone.
        const refused = await writing;
        expect(refused.status).toBe(409);
        expect((await json(refused)).error.code).toBe("issue_moved");
      } finally {
        await holder.query("ROLLBACK");
        await Promise.allSettled([moving, writing]);
      }
    },
  );
});
