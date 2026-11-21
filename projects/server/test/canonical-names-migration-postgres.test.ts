import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCanonicalNamesMigration } from "./canonical-names-migration-cases.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { createNameTables, migrationStatements } from "./name-migration.ts";
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
        `ENCODING '${encoding}' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
      );
      const client = new pg.Client({ connectionString: database.url });
      try {
        await client.connect();
        if (encoding === "SQL_ASCII") {
          // No conversion either way: the bytes sent are the bytes stored.
          await client.query("SET client_encoding = 'SQL_ASCII'");
        }
        await client.query(`SET standard_conforming_strings = ${conforming}`);
        await createNameTables(client);
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

        for (const statement of await migrationStatements("canonical_names")) {
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

  /**
   * Three sessions on a new database holding the two tables: one writes as
   * an older server would, one migrates, one watches the other two.
   */
  async function sessions() {
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
    await createNameTables(writer);
    return {
      writer,
      watcher,
      /**
       * Starts the migration in one transaction, as drizzle runs it, and
       * resolves once it waits on a lock or has ended; `done` settles to its
       * error, or null. Wrapped, since an async function returning a promise
       * would wait for it.
       */
      async migrate(begin = "BEGIN") {
        const { rows } = await migrator.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        let settled = false;
        const done = (async () => {
          await migrator.query(begin);
          for (const statement of await migrationStatements(
            "canonical_names",
          )) {
            await migrator.query(statement);
          }
          await migrator.query("COMMIT");
        })().then(
          () => null,
          (err: unknown) => err,
        );
        void done.then(() => {
          settled = true;
        });
        for (let tries = 0; !settled; tries++) {
          const { rows: wait } = await watcher.query<{ type: string | null }>(
            "SELECT wait_event_type AS type FROM pg_stat_activity " +
              "WHERE pid = $1",
            [rows[0]?.pid],
          );
          if (wait[0]?.type === "Lock") break;
          if (tries > 200) throw new Error("the migration never waited");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return { done };
      },
      async end() {
        await writer.end();
        await migrator.end();
        await watcher.end();
        await database.drop();
      },
    };
  }

  // An older server can still be writing while the migration runs: a name it
  // commits after the clash check must not abort the upgrade, and a rename
  // it commits must not be undone.
  it("works around names another session writes while it runs", async () => {
    const s = await sessions();
    try {
      const seeded: Record<string, { zed: number; yak: number }> = {};
      for (const table of ["statuses", "labels"]) {
        const { rows } = await s.writer.query<{ id: number }>(
          `INSERT INTO ${table} (project_id, name) ` +
            "VALUES (1, 'Zed '), (1, 'Yak ') RETURNING id",
        );
        const [zed, yak] = rows.map((row) => row.id) as [number, number];
        seeded[table] = { zed, yak };
      }

      await s.writer.query("BEGIN");
      for (const table of ["statuses", "labels"]) {
        await s.writer.query(
          `INSERT INTO ${table} (project_id, name) VALUES (1, 'Zed')`,
        );
        await s.writer.query(
          `UPDATE ${table} SET name = 'Yam' WHERE name = 'Yak '`,
        );
      }
      const { done: migrated } = await s.migrate();
      await s.writer.query("COMMIT");
      const failure = await migrated;
      if (failure) throw failure;

      for (const table of ["statuses", "labels"]) {
        const { rows } = await s.watcher.query<{ id: number; name: string }>(
          `SELECT id, name FROM ${table} ORDER BY id`,
        );
        const { zed, yak } = seeded[table] as { zed: number; yak: number };
        expect(rows, table).toEqual([
          { id: zed, name: `Zed (${zed})` },
          { id: yak, name: "Yam" },
          { id: yak + 1, name: "Zed" },
        ]);
      }
    } finally {
      await s.end();
    }
  });

  // A table lock taken by the migration would make this a deadlock: the
  // writer holds the row the migration renames, then needs to write it.
  it("lets a session that locked a row before writing it finish", async () => {
    const s = await sessions();
    try {
      const { rows } = await s.writer.query<{ id: number }>(
        "INSERT INTO statuses (project_id, name) VALUES (1, 'Kip ') " +
          "RETURNING id",
      );
      const id = (rows[0] as { id: number }).id;

      await s.writer.query("BEGIN");
      await s.writer.query(
        "SELECT id FROM statuses WHERE id = $1 FOR NO KEY UPDATE",
        [id],
      );
      const { done: migrated } = await s.migrate();
      await s.writer.query("UPDATE statuses SET name = name WHERE id = $1", [
        id,
      ]);
      await s.writer.query("COMMIT");
      const failure = await migrated;
      if (failure) throw failure;

      const { rows: after } = await s.watcher.query<{ name: string }>(
        "SELECT name FROM statuses WHERE id = $1",
        [id],
      );
      expect(after).toEqual([{ name: "Kip" }]);
    } finally {
      await s.end();
    }
  });

  // Under REPEATABLE READ the clash check never sees the row that beat it,
  // so the rename has to give up rather than try forever.
  it("gives up on a name it cannot see after three tries", async () => {
    const s = await sessions();
    try {
      await s.writer.query(
        "INSERT INTO statuses (project_id, name) VALUES (1, 'Zed ')",
      );
      await s.writer.query("BEGIN");
      await s.writer.query(
        "INSERT INTO statuses (project_id, name) VALUES (1, 'Zed')",
      );
      const { done: migrated } = await s.migrate(
        "BEGIN ISOLATION LEVEL REPEATABLE READ",
      );
      await s.writer.query("COMMIT");
      expect(await migrated).toMatchObject({ code: "23505" });
    } finally {
      await s.end();
    }
  });
});
