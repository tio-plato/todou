import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCanonicalNames } from "./canonical-names-cases.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { TABLES } from "./name-migration.ts";

const json = (res: Response) => res.json() as Promise<{ id: number }>;

describe("canonical names", () => {
  let t: TestApp;
  let create: (slug: string) => Promise<{ id: number }>;

  beforeAll(async () => {
    // Shared placement: two projects in one database is where a name in
    // another project could be mistaken for a clash.
    t = await makeTestApp("shared");
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    create = async (slug: string) =>
      json(
        await t.app.request("/api/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({ slug, name: slug }),
        }),
      );
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("makes every status and label name canonical, renaming clashes by id", async () => {
    const projectA = await create("canon-a");
    const projectB = await create("canon-b");

    const db = await t.ctx.router.forProject({
      id: projectA.id,
      slug: "canon-a",
      database_url: null,
    });
    await checkCanonicalNames(db, {
      projectA: projectA.id,
      projectB: projectB.id,
    });
  });

  // An older server still running beside this one, or one rolled back to,
  // stores a name as it was given; the next migration puts it right.
  it("puts right a name an older server writes after the upgrade", async () => {
    const project = await create("canon-late");
    const db = await t.ctx.router.forProject({
      id: project.id,
      slug: "canon-late",
      database_url: null,
    });
    const ids = [];
    for (const table of TABLES) {
      ids.push(await table.insert(db, project.id, " Late  one "));
    }

    await t.ctx.router.systemHandle().migrate("project");

    for (const [at, table] of TABLES.entries()) {
      const id = ids[at] as number;
      expect(await table.names(db, [id]), table.label).toEqual(
        new Map([[id, "Late one"]]),
      );
    }
  });
});
