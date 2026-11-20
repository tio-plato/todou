import { afterAll, beforeAll, describe, it } from "vitest";
import { checkCanonicalNamesMigration } from "./canonical-names-migration-cases.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

const json = (res: Response) => res.json() as Promise<{ id: number }>;

describe("canonical_names migration", () => {
  let t: TestApp;

  beforeAll(async () => {
    // Shared placement: two projects in one database is where a name in
    // another project could be mistaken for a clash.
    t = await makeTestApp("shared");
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("makes every status and label name canonical, renaming clashes by id", async () => {
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    const create = async (slug: string) =>
      json(
        await t.app.request("/api/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({ slug, name: slug }),
        }),
      );
    const projectA = await create("canon-a");
    const projectB = await create("canon-b");

    const db = await t.ctx.router.forProject({
      id: projectA.id,
      slug: "canon-a",
      database_url: null,
    });
    await checkCanonicalNamesMigration(db, {
      projectA: projectA.id,
      projectB: projectB.id,
    });
  });
});
