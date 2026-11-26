import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The name check and the write are two statements, so a concurrent create or
 * rename of the same name can win the unique index between them. The loser
 * gets the same 409 as an ordinary duplicate, not a 500.
 */
describe("a status or label name lost to a concurrent writer", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "name-race";
  const headers = () => ({ "content-type": "application/json", cookie });

  const send = (method: string, path: string, body: unknown) =>
    t.app.request(`/api/projects/${slug}${path}`, {
      method,
      headers: headers(),
      body: JSON.stringify(body),
    });

  const taken = (kind: "status" | "label", name: string) => ({
    error: { code: "conflict", message: `${kind} "${name}" already exists` },
  });

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Name race" }),
    });
    expect(created.status).toBe(201);

    // Plays the concurrent writer: after the name check has passed, and just
    // before the losing statement lands, another row takes the name. It
    // belongs to the losing statement, so it rolls back with it.
    const db = t.ctx.router.system();
    await db.execute(sql`
      create function status_name_race() returns trigger language plpgsql as $$
      begin
        if pg_trigger_depth() = 1 and NEW.name like 'race-%' then
          insert into statuses (project_id, name, category, position)
          values (NEW.project_id, NEW.name, 'open', 999);
        end if;
        return NEW;
      end $$
    `);
    await db.execute(sql`
      create trigger status_name_race before insert or update of name
      on statuses for each row execute function status_name_race()
    `);
    await db.execute(sql`
      create function label_name_race() returns trigger language plpgsql as $$
      begin
        if pg_trigger_depth() = 1 and NEW.name like 'race-%' then
          insert into labels (project_id, name) values (NEW.project_id, NEW.name);
        end if;
        return NEW;
      end $$
    `);
    await db.execute(sql`
      create trigger label_name_race before insert or update of name
      on labels for each row execute function label_name_race()
    `);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("refuses a status create with the duplicate's 409", async () => {
    const res = await send("POST", "/statuses", {
      name: "race-a",
      category: "open",
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual(taken("status", "race-a"));
  });

  it("refuses a status rename whole, default included", async () => {
    const keeper = await send("POST", "/statuses", {
      name: "Keeper",
      category: "open",
    });
    expect(keeper.status).toBe(201);
    const { id } = await json(keeper);

    const res = await send("PATCH", `/statuses/${id}`, {
      name: "race-b",
      is_default: true,
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual(taken("status", "race-b"));

    const list = await t.app.request(`/api/projects/${slug}/statuses`, {
      headers: { cookie },
    });
    const defaults = (await json(list)).filter(
      (s: { is_default: boolean }) => s.is_default,
    );
    expect(defaults.map((s: { name: string }) => s.name)).toEqual(["Todo"]);
  });

  it("refuses a label create with the duplicate's 409", async () => {
    const res = await send("POST", "/labels", { name: "race-a" });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual(taken("label", "race-a"));
  });

  it("refuses a label rename with the duplicate's 409", async () => {
    const keeper = await send("POST", "/labels", { name: "keeper" });
    expect(keeper.status).toBe(201);
    const { id } = await json(keeper);

    const res = await send("PATCH", `/labels/${id}`, { name: "race-b" });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual(taken("label", "race-b"));
  });

  it("leaves a violation of any other unique index a 500", async () => {
    // A second unique index on each table, which no name clash can trip:
    // at most one row per project in this colour.
    const db = t.ctx.router.system();
    await db.execute(sql`
      create unique index statuses_one_marked_idx on statuses (project_id)
      where color = '#010101'
    `);
    await db.execute(sql`
      create unique index labels_one_marked_idx on labels (project_id)
      where color = '#010101'
    `);
    try {
      const marked = { color: "#010101" };
      for (const [path, extra] of [
        ["/statuses", { category: "open" }],
        ["/labels", {}],
      ] as const) {
        const first = await send("POST", path, {
          name: "marked-a",
          ...extra,
          ...marked,
        });
        expect(first.status).toBe(201);

        const created = await send("POST", path, {
          name: "marked-b",
          ...extra,
          ...marked,
        });
        expect(created.status).toBe(500);

        const plain = await send("POST", path, { name: "plain", ...extra });
        expect(plain.status).toBe(201);
        const { id } = await json(plain);
        const renamed = await send("PATCH", `${path}/${id}`, {
          name: "plain-renamed",
          ...marked,
        });
        expect(renamed.status).toBe(500);
      }
    } finally {
      await db.execute(sql`drop index statuses_one_marked_idx`);
      await db.execute(sql`drop index labels_one_marked_idx`);
    }
  });
});
