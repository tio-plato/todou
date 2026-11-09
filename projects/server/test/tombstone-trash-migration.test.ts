import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issues } from "../src/db/project-schema.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const MIGRATION = new URL(
  "../drizzle/project/0024_tombstones_out_of_trash.sql",
  import.meta.url,
);

// Migrations run on an empty database before a test can seed it, so the
// state this one is for is made by hand: a tombstone marked deleted, which
// only the code from before deletes refused a moved card could leave behind.
describe("0024 tombstones out of the trash", () => {
  let t: TestApp;
  let cookie: string;
  const A = "tomb-trash-a";
  const B = "tomb-trash-b";

  const req = (path: string, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: init?.body
        ? { "content-type": "application/json", cookie }
        : { cookie },
    });
  const createIssue = async (title: string) => {
    const res = await req(`/projects/${A}/issues`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; number: number };
  };
  const trashList = async () => {
    const res = await req(`/projects/${A}/issues?deleted=1&limit=100`);
    expect(res.status).toBe(200);
    return ((await json(res)).items as Array<{ number: number }>)
      .map((item) => item.number)
      .sort((a, b) => a - b);
  };

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    for (const slug of [A, B]) {
      const res = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("takes a tombstone the old code trashed out of the trash, and nothing else", async () => {
    const moved = await createIssue("moved away");
    const out = await req(`/projects/${A}/issues/${moved.number}/move`, {
      method: "POST",
      body: JSON.stringify({ to_project: B }),
    });
    expect(out.status).toBe(200);
    const trashed = await createIssue("really trashed");
    const deleted = await req(`/projects/${A}/issues/${trashed.number}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    const kept = await createIssue("left alone");
    const me = await json(await req("/me"));

    // What a delete at the old address did before it was refused.
    const db = t.ctx.router.system();
    await db
      .update(issues)
      .set({ deletedAt: new Date(), deletedBy: me.id })
      .where(eq(issues.id, moved.id));
    expect(await trashList()).toEqual([moved.number, trashed.number]);

    await db.execute(sql.raw(await readFile(MIGRATION, "utf8")));

    expect(await trashList()).toEqual([trashed.number]);
    const rows = new Map(
      (
        await db
          .select({
            id: issues.id,
            deletedAt: issues.deletedAt,
            deletedBy: issues.deletedBy,
            movedAt: issues.movedAt,
          })
          .from(issues)
          .where(
            eq(issues.projectId, (await json(await req(`/projects/${A}`))).id),
          )
      ).map((row) => [row.id, row]),
    );
    expect(rows.get(moved.id)).toMatchObject({
      deletedAt: null,
      deletedBy: null,
    });
    expect(rows.get(moved.id)?.movedAt).not.toBeNull();
    expect(rows.get(trashed.id)?.deletedAt).not.toBeNull();
    expect(rows.get(kept.id)?.deletedAt).toBeNull();
  });
});
