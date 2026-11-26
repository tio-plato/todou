import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalizeNames } from "../src/db/canonical-names.ts";
import { openDb } from "../src/db/driver.ts";
import { checkCanonicalNames } from "./canonical-names-cases.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { createNameTables, TABLES } from "./name-migration.ts";
import { createTestDatabase } from "./postgres-database.ts";

const json = (res: Response) => res.json() as Promise<{ id: number }>;

/**
 * The canonical name pass is SQL with regular expressions whose character
 * class depends on the database encoding, and it runs beside sessions an
 * older server may hold; PGlite passing it says nothing about the server
 * that will actually run it. Runs only when TODOU_TEST_POSTGRES_URL points
 * at a live server:
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server test canonical-names-postgres
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("canonical names on postgres", () => {
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
    await checkCanonicalNames(db, {
      projectA: projectA.id,
      projectB: projectB.id,
    });
  });

  // An older server still running beside this one, or one rolled back to,
  // stores a name as it was given; the next migration puts it right. A
  // database of its own, since the name has to be committed to be seen.
  it("puts right a name an older server writes after the upgrade", async ({
    onTestFinished,
  }) => {
    const database = await createTestDatabase(
      PG_URL as string,
      "canonical_names",
    );
    const handle = await openDb(database.url);
    onTestFinished(async () => {
      await handle.close();
      await database.drop();
    });
    await handle.migrate("system");
    await handle.migrate("project");
    const ids = [];
    for (const table of TABLES) {
      ids.push(await table.insert(handle.db, 1, " Late  one "));
    }

    await handle.migrate("project");

    for (const [at, table] of TABLES.entries()) {
      const id = ids[at] as number;
      expect(await table.names(handle.db, [id]), table.label).toEqual(
        new Map([[id, "Late one"]]),
      );
    }
  });

  // Outside UTF8 the pass knows only ASCII whitespace: there the wider class
  // matches bytes, and in SQL_ASCII byte 0xA0 is the tail of "à" (c3 a0) and
  // of many CJK characters, so it would garble the name for good. SQL_ASCII
  // may also hold bytes that are not UTF-8 at all, such as a lone e0, which
  // node-postgres reads as U+FFFD: a name taken through JavaScript and back
  // would be stored as that.
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
        // Hex in, hex out: " \xe0  x\t " becomes "\xe0 x".
        raw: { seed: "20e02020780920", expected: "e02078" },
      },
      LATIN1: {
        seed: ["Café  au lait ", "x\u00a0y ", "Done", "Done "],
        expected: (done: number) => [
          "Café au lait",
          "x\u00a0y",
          "Done",
          `Done (${done})`,
        ],
        raw: undefined,
      },
    };
    // standard_conforming_strings = off has PostgreSQL decode \u escapes in
    // a plain string literal itself, which fails outside UTF8 for any code
    // point beyond ASCII; a deployment may still have it set.
    const runs = Object.entries(encodings).flatMap(([encoding, names]) =>
      ["on", "off"].map((conforming) => ({ encoding, conforming, ...names })),
    );
    for (const { encoding, conforming, seed, expected, raw } of runs) {
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
          if (raw) {
            await client.query(
              `INSERT INTO ${table} (project_id, name) VALUES (1, ` +
                "convert_from(decode($1, 'hex'), 'SQL_ASCII'))",
              [raw.seed],
            );
          }
        }

        await canonicalizeNames(drizzle(client));

        for (const table of ["statuses", "labels"]) {
          const tableIds = ids[table] as number[];
          const { rows } = await client.query<{ id: number; name: Buffer }>(
            `SELECT id, name::bytea AS name FROM ${table} ORDER BY id`,
          );
          const want = expected(tableIds.at(-1) as number).map((name) =>
            Buffer.from(
              name,
              encoding === "LATIN1" ? "latin1" : "utf8",
            ).toString("hex"),
          );
          if (raw) want.push(raw.expected);
          expect(
            rows.map((row) => row.name.toString("hex")),
            `${encoding}, standard_conforming_strings ${conforming}, ${table}`,
          ).toEqual(want);
        }
      } finally {
        await client.end();
        await database.drop();
      }
    }
  });

  /**
   * Three sessions on a new database holding the two tables: one writes as
   * an older server would, one runs the pass, one watches the other two.
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
       * Starts the pass on its own connection, as a migration runs it, and
       * resolves once it waits on a lock or has ended; `done` settles to
       * its error, or null. Wrapped, since an async function returning a
       * promise would wait for it.
       */
      async canonicalize() {
        const { rows } = await migrator.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        let settled = false;
        const done = canonicalizeNames(drizzle(migrator)).then(
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
          if (tries > 200) throw new Error("the pass never waited");
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

  // An older server can still be writing while the pass runs: a name it
  // commits after the clash check must not stop the pass, and a rename it
  // commits must not be undone.
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
      const { done } = await s.canonicalize();
      await s.writer.query("COMMIT");
      const failure = await done;
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

  // A table lock taken by the pass would make this a deadlock: the writer
  // holds the row the pass renames, then needs to write it.
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
      const { done } = await s.canonicalize();
      await s.writer.query("UPDATE statuses SET name = name WHERE id = $1", [
        id,
      ]);
      await s.writer.query("COMMIT");
      const failure = await done;
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

  // Renaming in one transaction would keep the lock on the row renamed
  // first while waiting for the next one, which the writer holds; the
  // writer then writing the first row would close a deadlock.
  it("never holds one row while it waits for another", async () => {
    const s = await sessions();
    try {
      const { rows } = await s.writer.query<{ id: number }>(
        "INSERT INTO statuses (project_id, name) " +
          "VALUES (1, 'Ant '), (1, 'Bee ') RETURNING id",
      );
      const [ant, bee] = rows.map((row) => row.id) as [number, number];

      await s.writer.query("BEGIN");
      await s.writer.query(
        "SELECT id FROM statuses WHERE id = $1 FOR NO KEY UPDATE",
        [bee],
      );
      const { done } = await s.canonicalize();
      await s.writer.query("UPDATE statuses SET name = 'Ant' WHERE id = $1", [
        ant,
      ]);
      await s.writer.query("COMMIT");
      const failure = await done;
      if (failure) throw failure;

      const { rows: after } = await s.watcher.query<{ name: string }>(
        "SELECT name FROM statuses ORDER BY id",
      );
      expect(after).toEqual([{ name: "Ant" }, { name: "Bee" }]);
    } finally {
      await s.end();
    }
  });

  // The rename has locked its row and waits to see whether the writer's
  // uncommitted "zed" takes the name under lower(); the writer then writes
  // that row. The pass waited first, so PostgreSQL ends its statement, and
  // the rename runs again once the writer is through.
  it("tries a rename again after it loses a deadlock", async () => {
    const s = await sessions();
    try {
      await s.writer.query("DROP INDEX statuses_project_name_idx");
      await s.writer.query(
        "CREATE UNIQUE INDEX statuses_project_name_idx " +
          "ON statuses (project_id, lower(name))",
      );
      const { rows } = await s.writer.query<{ id: number }>(
        "INSERT INTO statuses (project_id, name) VALUES (1, 'Zed ') " +
          "RETURNING id",
      );
      const zed = (rows[0] as { id: number }).id;

      await s.writer.query("BEGIN");
      await s.writer.query(
        "INSERT INTO statuses (project_id, name) VALUES (1, 'zed')",
      );
      const { done } = await s.canonicalize();
      await s.writer.query("UPDATE statuses SET name = 'Zed ' WHERE id = $1", [
        zed,
      ]);
      await s.writer.query("COMMIT");
      const failure = await done;
      if (failure) throw failure;

      const { rows: after } = await s.watcher.query<{ name: string }>(
        "SELECT name FROM statuses ORDER BY id",
      );
      expect(after).toEqual([{ name: `Zed (${zed})` }, { name: "zed" }]);
    } finally {
      await s.end();
    }
  });
});
