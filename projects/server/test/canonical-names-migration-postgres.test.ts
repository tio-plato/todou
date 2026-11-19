import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkCanonicalNamesMigration,
  migrationStatements,
} from "./canonical-names-migration-cases.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { createTestDatabase } from "./postgres-database.ts";

const json = (res: Response) => res.json() as Promise<{ id: number }>;

/**
 * canonical_names is plpgsql with regular expressions whose character class
 * depends on the database encoding; PGlite passing it says nothing about the
 * server that will actually run the upgrade. Runs only when
 * TODOU_TEST_POSTGRES_URL points at a live server:
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server test canonical-names-migration-postgres
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("canonical_names migration on postgres", () => {
  let t: TestApp;
  // The database persists across runs; unique slugs isolate each one.
  const run = Date.now().toString(36);

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
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
    const projectA = await create(`canon-a-${run}`);
    const projectB = await create(`canon-b-${run}`);

    const db = await t.ctx.router.forProject({
      id: projectA.id,
      slug: `canon-a-${run}`,
      database_url: null,
    });
    await checkCanonicalNamesMigration(db, {
      projectA: projectA.id,
      projectB: projectB.id,
    });
  });

  // Outside UTF8 the migration knows only ASCII whitespace: there the wider
  // class matches bytes, and in SQL_ASCII byte 0xA0 is the tail of "à" (c3 a0)
  // and of many CJK characters, so it would garble the name for good.
  it("leaves multi-byte names intact on a database that is not UTF-8", async () => {
    const encodings = {
      SQL_ASCII: {
        seed: [
          "进行中 ",
          "a  b\t",
          "进行\u3000中 ",
          "\u00e0  la carte ",
          "Done",
          "Done ",
        ],
        expected: (done: number) => [
          "进行中",
          "a b",
          "进行\u3000中",
          "\u00e0 la carte",
          "Done",
          `Done (${done})`,
        ],
      },
      LATIN1: {
        seed: ["Café  au lait ", "x\u00a0y ", "Done", "Done "],
        expected: (done: number) => [
          "Café au lait",
          "x\u00a0y",
          "Done",
          `Done (${done})`,
        ],
      },
    };
    // standard_conforming_strings = off has PostgreSQL decode \u escapes in
    // a plain string literal itself, which fails outside UTF8 for any code
    // point beyond ASCII; a deployment may still have it set.
    const runs = Object.entries(encodings).flatMap(([encoding, names]) =>
      ["on", "off"].map((conforming) => ({ encoding, conforming, ...names })),
    );
    for (const { encoding, conforming, seed, expected } of runs) {
      const database = await createTestDatabase(
        PG_URL as string,
        "canonical_names",
        `ENCODING '${encoding}' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
      );
      const client = new pg.Client({ connectionString: database.url });
      try {
        await client.connect();
        if (encoding === "SQL_ASCII") {
          // No conversion either way: the bytes sent are the bytes stored.
          await client.query("SET client_encoding = 'SQL_ASCII'");
        }
        await client.query(`SET standard_conforming_strings = ${conforming}`);
        const ids: Record<string, number[]> = {};
        for (const table of ["statuses", "labels"]) {
          await client.query(
            `CREATE TABLE ${table} (id serial PRIMARY KEY, ` +
              "project_id int NOT NULL, name text NOT NULL)",
          );
          await client.query(
            `CREATE UNIQUE INDEX ${table}_project_name_idx ` +
              `ON ${table} (project_id, name)`,
          );
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

        for (const statement of await migrationStatements()) {
          await client.query(statement);
        }

        for (const table of ["statuses", "labels"]) {
          const tableIds = ids[table] as number[];
          const { rows } = await client.query<{ id: number; name: Buffer }>(
            `SELECT id, name::bytea AS name FROM ${table} ORDER BY id`,
          );
          const want = expected(tableIds.at(-1) as number);
          expect(
            rows.map((row) => row.name.toString("hex")),
            `${encoding}, standard_conforming_strings ${conforming}, ${table}`,
          ).toEqual(
            want.map((name) =>
              Buffer.from(
                name,
                encoding === "LATIN1" ? "latin1" : "utf8",
              ).toString("hex"),
            ),
          );
        }
      } finally {
        await client.end();
        await database.drop();
      }
    }
  });

  // An older server can still be writing while the migration runs: a name it
  // writes mid-run must be seen before the rename that would clash with it,
  // not trip the unique index and abort the upgrade.
  it("waits for a concurrent write of the canonical name instead of failing on it", async () => {
    const database = await createTestDatabase(
      PG_URL as string,
      "canonical_names",
    );
    const connect = async () => {
      const client = new pg.Client({ connectionString: database.url });
      await client.connect();
      return client;
    };
    const writer = await connect();
    const migrator = await connect();
    const watcher = await connect();
    try {
      const stale: Record<string, number> = {};
      for (const table of ["statuses", "labels"]) {
        await writer.query(
          `CREATE TABLE ${table} (id serial PRIMARY KEY, ` +
            "project_id int NOT NULL, name text NOT NULL)",
        );
        await writer.query(
          `CREATE UNIQUE INDEX ${table}_project_name_idx ` +
            `ON ${table} (project_id, name)`,
        );
        const { rows } = await writer.query<{ id: number }>(
          `INSERT INTO ${table} (project_id, name) VALUES (1, 'Zed ') ` +
            "RETURNING id",
        );
        stale[table] = (rows[0] as { id: number }).id;
      }

      await writer.query("BEGIN");
      for (const table of ["statuses", "labels"]) {
        await writer.query(
          `INSERT INTO ${table} (project_id, name) VALUES (1, 'Zed')`,
        );
      }
      const { rows: me } = await migrator.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const migrated = (async () => {
        for (const statement of await migrationStatements()) {
          await migrator.query(statement);
        }
      })().then(
        () => null,
        (err: unknown) => err,
      );
      // Commit only once the migration waits on the writer.
      for (let tries = 0; ; tries++) {
        const { rows } = await watcher.query<{ wait: string | null }>(
          "SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = $1",
          [me[0]?.pid],
        );
        if (rows[0]?.wait === "Lock") break;
        if (tries > 200) throw new Error("the migration never waited");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await writer.query("COMMIT");
      const failure = await migrated;
      if (failure) throw failure;

      for (const table of ["statuses", "labels"]) {
        const { rows } = await watcher.query<{ id: number; name: string }>(
          `SELECT id, name FROM ${table} ORDER BY id`,
        );
        const id = stale[table] as number;
        expect(rows, table).toEqual([
          { id, name: `Zed (${id})` },
          { id: id + 1, name: "Zed" },
        ]);
      }
    } finally {
      await writer.end();
      await migrator.end();
      await watcher.end();
      await database.drop();
    }
  });
});
