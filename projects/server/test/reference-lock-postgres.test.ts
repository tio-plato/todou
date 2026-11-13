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
  // With no card, a draft uploaded before the card that will claim it.
  const uploadDraft = async (card: Card | null, name: string) => {
    const form = new FormData();
    form.set("file", new File([`bytes of ${name}`], name));
    if (card !== null) form.set("issue_number", String(card.number));
    form.set("draft", "true");
    const res = await t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: author.headers,
      body: form,
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; url: string };
  };
  const expectAttached = async (attachmentId: number, cardId: number) => {
    const draft = await observer.query<{ draft: boolean }>(
      "SELECT draft FROM attachments WHERE id = $1",
      [attachmentId],
    );
    expect(draft.rows[0]?.draft).toBe(false);
    const added = await observer.query<{ count: string }>(
      `SELECT count(*) FROM issue_events
       WHERE issue_id = $1 AND type = 'attachment_added'
         AND (payload->'attachment'->>'id')::bigint = $2`,
      [cardId, attachmentId],
    );
    expect(Number(added.rows[0]?.count)).toBe(1);
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
  // takes them in. `prepare` runs before the holder starts, and what
  // it returns reaches `request`.
  const race = async <P = undefined>(
    request: (a: Card, b: Card, prepared: P) => Promise<Response>,
    prepare?: (a: Card, b: Card) => Promise<P>,
  ) => {
    const b = await createCard(slug, "B");
    const a = await createCard(slug, "A");
    expect(a.id).toBeGreaterThan(b.id);
    const prepared = (await prepare?.(a, b)) as P;

    const pid = await pidOf(holder);
    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("UPDATE issues SET updated_at = now() WHERE id = $1", [
        b.id,
      ]);
      pending = request(a, b, prepared);
      await blockedBy(pid);
      await holder.query("SELECT id FROM issues WHERE id = $1 FOR SHARE", [
        a.id,
      ]);
      await holder.query("COMMIT");
      return { a, b, prepared, response: await pending };
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

  // Attaching a draft updates the card it was uploaded on, which need not be
  // the card the text is written on. In the three races below the draft is
  // on B, so the request updates B as well as A.
  it("a comment linking a draft on another card locks that card first", async () => {
    const { b, prepared, response } = await race(
      (a, _b, draft) =>
        send("POST", `/projects/${slug}/issues/${a.number}/comments`, {
          body: `![](${draft.url})`,
        }),
      (_a: Card, b: Card) => uploadDraft(b, "comment.txt"),
    );
    expect(response.status).toBe(201);
    await expectAttached(prepared.id, b.id);
  });

  it("a comment edit linking a draft on another card locks that card first", async () => {
    const { b, prepared, response } = await race(
      (a, _b, { comment, draft }) =>
        send(
          "PATCH",
          `/projects/${slug}/issues/${a.number}/comments/${comment.id}`,
          { body: `words ![](${draft.url})` },
        ),
      async (a: Card, b: Card) => {
        const posted = await send(
          "POST",
          `/projects/${slug}/issues/${a.number}/comments`,
          { body: "words" },
        );
        expect(posted.status).toBe(201);
        const comment = (await json(posted)) as { id: number };
        return { comment, draft: await uploadDraft(b, "edit.txt") };
      },
    );
    expect(response.status).toBe(200);
    await expectAttached(prepared.draft.id, b.id);
  });

  it("a body edit linking a draft on another card locks that card first", async () => {
    const { b, prepared, response } = await race(
      (a, _b, draft) =>
        send("PATCH", `/projects/${slug}/issues/${a.number}`, {
          body: `![](${draft.url})`,
        }),
      (_a: Card, b: Card) => uploadDraft(b, "body.txt"),
    );
    expect(response.status).toBe(200);
    await expectAttached(prepared.id, b.id);
  });

  // The holder takes `first`, waits until the request queues behind it,
  // then takes `second` and commits.
  const contend = async (
    first: () => Promise<unknown>,
    request: () => Promise<Response>,
    second: () => Promise<unknown>,
  ) => {
    const pid = await pidOf(holder);
    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      await first();
      pending = request();
      await blockedBy(pid);
      await second();
      await holder.query("COMMIT");
      return await pending;
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([pending]);
    }
  };
  const lockCard = (id: number, mode: string) =>
    holder.query(`SELECT id FROM issues WHERE id = $1 FOR ${mode}`, [id]);

  it("a new card locks the card its draft is on before taking a number", async () => {
    const c = await createCard(slug, "C");
    const draft = await uploadDraft(c, "new.txt");
    // The holder creates a card that references C: it locks C, then takes
    // this project's project_meta.
    const response = await contend(
      () => lockCard(c.id, "SHARE"),
      () =>
        send("POST", `/projects/${slug}/issues`, {
          title: "new",
          body: `![](${draft.url})`,
        }),
      () =>
        holder.query(
          "UPDATE project_meta SET next_issue_number = next_issue_number WHERE project_id = $1",
          [projectId],
        ),
    );
    expect(response.status).toBe(201);
    await expectAttached(draft.id, c.id);
  });

  // The drafts a new card's body links that were uploaded before it hang on
  // the new card, which needs no lock; the one on C still locks C before the
  // number, as above.
  it("a new card attaches the drafts uploaded before it with one on another card", async () => {
    const c = await createCard(slug, "C");
    const onC = await uploadDraft(c, "on-c.txt");
    const loose = await uploadDraft(null, "loose.txt");
    const response = await contend(
      () => lockCard(c.id, "SHARE"),
      () =>
        send("POST", `/projects/${slug}/issues`, {
          title: "new",
          body: `![](${loose.url}) ![](${onC.url})`,
        }),
      () =>
        holder.query(
          "UPDATE project_meta SET next_issue_number = next_issue_number WHERE project_id = $1",
          [projectId],
        ),
    );
    expect(response.status).toBe(201);
    const created = (await json(response)) as Card;
    await expectAttached(onC.id, c.id);
    await expectAttached(loose.id, created.id);
  });

  // R1 falls in the references below X, R2 in those between X and A, and X
  // is both referenced and updated: all three are owed a `referenced` event.
  it("a write that references the card its draft is on locks it for update at once", async () => {
    const r1 = await createCard(slug, "R1");
    const x = await createCard(slug, "X");
    const r2 = await createCard(slug, "R2");
    const a = await createCard(slug, "A");
    expect(x.id).toBeGreaterThan(r1.id);
    expect(r2.id).toBeGreaterThan(x.id);
    expect(a.id).toBeGreaterThan(r2.id);
    const draft = await uploadDraft(x, "upgrade.txt");
    // The holder is the same write on the server before the fix: it
    // share-locks X, then goes on to update it.
    const response = await contend(
      () => lockCard(x.id, "SHARE"),
      () =>
        send("POST", `/projects/${slug}/issues/${a.number}/comments`, {
          body: `see #${r1.number} #${x.number} #${r2.number} ![](${draft.url})`,
        }),
      () =>
        holder.query("UPDATE issues SET updated_at = now() WHERE id = $1", [
          x.id,
        ]),
    );
    expect(response.status).toBe(201);
    const comment = await json(response);
    await expectAttached(draft.id, x.id);
    for (const card of [r1, x, r2]) {
      const events = await referencedOf(slug, card.number);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        by_issue: a.number,
        by_comment: comment.id,
      });
    }
  });

  // X is referenced and updated, and goes to the trash while the request
  // waits for it: the request still locks it to attach the draft, but owes
  // it no reference any more.
  it("a write that references the card its draft is on records nothing on it once it is trashed", async () => {
    const x = await createCard(slug, "X");
    const a = await createCard(slug, "A");
    const draft = await uploadDraft(x, "trashed.txt");
    // The holder trashes X: it locks the card, then marks it.
    const response = await contend(
      () => lockCard(x.id, "NO KEY UPDATE"),
      () =>
        send("POST", `/projects/${slug}/issues/${a.number}/comments`, {
          body: `see #${x.number} ![](${draft.url})`,
        }),
      () =>
        holder.query("UPDATE issues SET deleted_at = now() WHERE id = $1", [
          x.id,
        ]),
    );
    expect(response.status).toBe(201);
    await expectAttached(draft.id, x.id);
    const referenced = await observer.query<{ count: string }>(
      `SELECT count(*) FROM issue_events
       WHERE issue_id = $1 AND type = 'referenced'`,
      [x.id],
    );
    expect(Number(referenced.rows[0]?.count)).toBe(0);
  });

  it("a write attaching drafts on several cards locks them in id order", async () => {
    const c1 = await createCard(slug, "C1");
    const c2 = await createCard(slug, "C2");
    const a = await createCard(slug, "A");
    // The server before the fix updated these cards in the order `UPDATE
    // attachments … RETURNING` gave the drafts back: d2, uploaded first,
    // came first, so it wrote C2 before C1.
    const d2 = await uploadDraft(c2, "second.txt");
    const d1 = await uploadDraft(c1, "first.txt");
    const response = await contend(
      () => lockCard(c1.id, "NO KEY UPDATE"),
      () =>
        send("POST", `/projects/${slug}/issues/${a.number}/comments`, {
          body: `![](${d1.url}) ![](${d2.url})`,
        }),
      () => lockCard(c2.id, "NO KEY UPDATE"),
    );
    expect(response.status).toBe(201);
    await expectAttached(d1.id, c1.id);
    await expectAttached(d2.id, c2.id);
  });

  it("a comment linking a draft that is being deleted waits for the delete", async () => {
    const x = await createCard(slug, "X");
    const y = await createCard(slug, "Y");
    expect(x.id).toBeLessThan(y.id);
    const draft = await uploadDraft(x, "deleted.txt");
    // The holder deletes the draft the way deleting an attachment does: it
    // locks the card the draft is on, then deletes the attachment row.
    const response = await contend(
      () => lockCard(x.id, "NO KEY UPDATE"),
      () =>
        send("POST", `/projects/${slug}/issues/${y.number}/comments`, {
          body: `![](${draft.url})`,
        }),
      () => holder.query("DELETE FROM attachments WHERE id = $1", [draft.id]),
    );
    expect(response.status).toBe(201);
    const left = await observer.query(
      "SELECT id FROM attachments WHERE id = $1",
      [draft.id],
    );
    expect(left.rows).toHaveLength(0);
    const added = await observer.query<{ count: string }>(
      `SELECT count(*) FROM issue_events
       WHERE issue_id = $1 AND type = 'attachment_added'
         AND (payload->'attachment'->>'id')::bigint = $2`,
      [x.id, draft.id],
    );
    expect(Number(added.rows[0]?.count)).toBe(0);
  });

  // The holder freezes T, in another project, the way a move to another
  // database does: it holds the card, then marks it. The reference waits for
  // the card and must then see the mark.
  it("a reference into another project checks the card under its lock", async () => {
    const other = `${slug}-q`;
    await createProject(other);
    const target = await createCard(other, "T");
    const writer = await createCard(slug, "W");
    const pid = await pidOf(holder);
    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("SELECT id FROM issues WHERE id = $1 FOR UPDATE", [
        target.id,
      ]);
      pending = send(
        "POST",
        `/projects/${slug}/issues/${writer.number}/comments`,
        { body: `see ${other}#${target.number}` },
      );
      await blockedBy(pid);
      await holder.query(
        "UPDATE issues SET moving_since = now() WHERE id = $1",
        [target.id],
      );
      await holder.query("COMMIT");
      expect((await pending).status).toBe(201);
      const referenced = await observer.query<{ count: string }>(
        `SELECT count(*) FROM issue_events
         WHERE issue_id = $1 AND type = 'referenced'`,
        [target.id],
      );
      expect(Number(referenced.rows[0]?.count)).toBe(0);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([pending]);
    }
  });

  // The last step of a move to another database locks the frozen card,
  // then empties it, its attachment rows included, and raises the
  // tombstone. A write attaching a draft on that card waits for the card,
  // and by the time it gets it the draft is gone.
  it("a comment linking a draft on a card a move is retiring finds it gone", async () => {
    const f = await createCard(slug, "F");
    const a = await createCard(slug, "A");
    const draft = await uploadDraft(f, "moving.txt");
    await observer.query(
      "UPDATE issues SET moving_since = now() WHERE id = $1",
      [f.id],
    );
    const pid = await pidOf(holder);
    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("SELECT id FROM issues WHERE id = $1 FOR UPDATE", [
        f.id,
      ]);
      pending = send("POST", `/projects/${slug}/issues/${a.number}/comments`, {
        body: `![](${draft.url})`,
      });
      await blockedBy(pid);
      await holder.query("DELETE FROM attachments WHERE id = $1", [draft.id]);
      await holder.query(
        "UPDATE issues SET moved_at = now(), moving_since = NULL WHERE id = $1",
        [f.id],
      );
      await holder.query("COMMIT");
      expect((await pending).status).toBe(201);
      const added = await observer.query<{ count: string }>(
        `SELECT count(*) FROM issue_events
         WHERE issue_id = $1 AND type = 'attachment_added'`,
        [f.id],
      );
      expect(Number(added.rows[0]?.count)).toBe(0);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([pending]);
    }
  });

  // Until the copy reads the card's attachments, a draft attached on the
  // frozen card still goes with it as an attachment.
  it("a comment linking a draft on a card being moved attaches it", async () => {
    const f = await createCard(slug, "F");
    const a = await createCard(slug, "A");
    const draft = await uploadDraft(f, "frozen.txt");
    await observer.query(
      "UPDATE issues SET moving_since = now() WHERE id = $1",
      [f.id],
    );
    const response = await send(
      "POST",
      `/projects/${slug}/issues/${a.number}/comments`,
      { body: `![](${draft.url})` },
    );
    expect(response.status).toBe(201);
    await expectAttached(draft.id, f.id);
  });

  // A write attaching a draft waits for a delete holding its row, so a
  // delete that rolls back leaves it to attach.
  it("a comment linking a draft whose delete rolls back attaches it", async () => {
    const x = await createCard(slug, "X");
    const a = await createCard(slug, "A");
    const draft = await uploadDraft(x, "kept.txt");
    const pid = await pidOf(holder);
    await holder.query("BEGIN");
    let pending: Promise<Response> | undefined;
    try {
      // The holder is the draft reaper: it deletes the row without locking
      // the card, then gives up.
      await holder.query("DELETE FROM attachments WHERE id = $1", [draft.id]);
      pending = send("POST", `/projects/${slug}/issues/${a.number}/comments`, {
        body: `![](${draft.url})`,
      });
      await blockedBy(pid);
      await holder.query("ROLLBACK");
      expect((await pending).status).toBe(201);
      await expectAttached(draft.id, x.id);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled([pending]);
    }
  });
});
