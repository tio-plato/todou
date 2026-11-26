import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCaseInsensitiveNamesMigration } from "./case-insensitive-names-migration-cases.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { createNameTables, migrationStatements } from "./name-migration.ts";
import { createTestDatabase } from "./postgres-database.ts";

const json = (res: Response) => res.json() as Promise<{ id: number }>;

/**
 * case_insensitive_names leans on lower() and normalize(), both of which
 * depend on the database's encoding and locale; PGlite passing it says
 * nothing about the server that will actually run the upgrade. Runs only
 * when TODOU_TEST_POSTGRES_URL points at a live server:
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server test case-insensitive-names-migration-postgres
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("case_insensitive_names migration on postgres", () => {
  let t: TestApp;
  // The database persists across runs; unique slugs isolate each one.
  const run = Date.now().toString(36);

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("renames names that differ only in case or composition, by id", async () => {
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
    const projectA = await create(`fold-a-${run}`);
    const projectB = await create(`fold-b-${run}`);

    const db = await t.ctx.router.forProject({
      id: projectA.id,
      slug: `fold-a-${run}`,
      database_url: null,
    });
    await checkCaseInsensitiveNamesMigration(db, {
      projectA: projectA.id,
      projectB: projectB.id,
    });
  });

  // normalize() fails outside UTF8, and there lower() folds ASCII letters
  // alone: the migration must still run, and leave other bytes as they are.
  it("folds ASCII case only, and composes nothing, on a SQL_ASCII database", async () => {
    const database = await createTestDatabase(
      PG_URL as string,
      "case_insensitive_names",
      "ENCODING 'SQL_ASCII' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0",
    );
    const client = new pg.Client({ connectionString: database.url });
    try {
      await client.connect();
      // No conversion either way: the bytes sent are the bytes stored.
      await client.query("SET client_encoding = 'SQL_ASCII'");
      await createNameTables(client);
      const seed = ["Done", "done", "Cafe\u0301", "\u00e9tat", "\u00c9tat"];
      const ids: Record<string, number[]> = {};
      for (const table of ["statuses", "labels"]) {
        ids[table] = [];
        for (const name of seed) {
          const { rows } = await client.query<{ id: number }>(
            `INSERT INTO ${table} (project_id, name) VALUES (1, $1) ` +
              "RETURNING id",
            [name],
          );
          ids[table]?.push((rows[0] as { id: number }).id);
        }
      }

      for (const statement of await migrationStatements(
        "case_insensitive_names",
      )) {
        await client.query(statement);
      }

      for (const table of ["statuses", "labels"]) {
        const done = (ids[table] as number[])[1] as number;
        const { rows } = await client.query<{ name: Buffer }>(
          `SELECT name::bytea AS name FROM ${table} ORDER BY id`,
        );
        expect(
          rows.map((row) => row.name.toString("hex")),
          table,
        ).toEqual(
          [
            "Done",
            `done (${done})`,
            "Cafe\u0301",
            "\u00e9tat",
            "\u00c9tat",
          ].map((name) => Buffer.from(name, "utf8").toString("hex")),
        );
      }
    } finally {
      await client.end();
      await database.drop();
    }
  });
});
