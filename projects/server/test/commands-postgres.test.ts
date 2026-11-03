import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../src/auth/pat.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (response: Response): Promise<any> => response.json();
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

// PGlite serializes on its one connection, so lock order never shows there.
// The holder plays the two halves of an answer: lock the question comment,
// then, once the submission waits on a lock it holds, write the issue row.
describe.skipIf(!PG_URL)("command submission lock order", () => {
  let t: TestApp;
  let holder: pg.Client;
  let observer: pg.Client;
  let author: { user: UserRow; headers: { authorization: string } };
  const slug = `commands-pg-${Date.now().toString(36)}`;
  const headers = () => ({
    ...author.headers,
    "content-type": "application/json",
  });
  const post = (path: string, body: unknown) =>
    Promise.resolve(
      t.app.request(`/api/projects/${slug}${path}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    holder = new pg.Client({ connectionString: PG_URL });
    observer = new pg.Client({ connectionString: PG_URL });
    await holder.connect();
    await observer.connect();
    author = await addUserWithToken(t.ctx, `${slug}-author`);
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Command lock order" }),
    });
    expect(created.status).toBe(201);
  });

  afterAll(async () => {
    await holder?.end();
    await observer?.end();
    await t?.cleanup();
  });

  it("a submission with a body and a hide locks the comments before the issue row", async () => {
    const card = await post("/issues", { title: "Hide an asked question" });
    expect(card.status).toBe(201);
    const issue = (await json(card)) as { id: number; number: number };
    const asked = await post(`/issues/${issue.number}/comments`, {
      body: "which one?",
      component: {
        type: "questions",
        questions: [
          { question: "Which?", options: [{ label: "a" }, { label: "b" }] },
        ],
      },
    });
    expect(asked.status).toBe(201);
    const question = await json(asked);
    const key = question.component.questions[0].key as string;

    const pid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]?.pid;
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM comments WHERE id = $1 FOR UPDATE", [
      question.id,
    ]);
    const pending = post(`/issues/${issue.number}/commands`, {
      body: "the conclusion",
      commands: [
        { type: "comments_hide", hidden: true, comment_ids: [question.id] },
      ],
    });
    try {
      // Counted by blocker rather than by query text: other suites share
      // this database, and what matters is that the holder is what the
      // submission waits on, not which statement it waits in.
      await expect
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
      await holder.query(
        `INSERT INTO issue_events (project_id, issue_id, actor_id, type, payload)
         VALUES ((SELECT project_id FROM issues WHERE id = $1), $1, $2,
                 'question_answered', $3::jsonb)`,
        [
          issue.id,
          author.user.id,
          JSON.stringify({
            comment_id: question.id,
            answers: [
              {
                key,
                selected: [{ index: 0, label: "a" }],
                other: null,
                declined: false,
              },
            ],
            via: "answer",
          }),
        ],
      );
      await holder.query(
        `UPDATE issues SET open_questions = greatest(open_questions - 1, 0),
                           updated_at = now()
         WHERE id = $1`,
        [issue.id],
      );
      await holder.query("COMMIT");

      const submitted = await pending;
      expect(submitted.status).toBe(200);
      const result = await json(submitted);
      // The answer committed while the hide waited, so the hide must take
      // it as given rather than decline the question on its own.
      expect(result.hide.settled).toBeUndefined();
      expect(result.hide.unchanged).toEqual([]);
      const after = await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}`,
        { headers: headers() },
      );
      expect((await json(after)).open_questions).toBe(0);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([pending]);
    }
  });
});
