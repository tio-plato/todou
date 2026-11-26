import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it, type OnTestFinishedHandler } from "vitest";
import {
  type DbTier,
  MIGRATION_LOCK_KEY,
  type MigrationSet,
  migrateNodePgQueued,
} from "../src/db/driver.ts";
import type { DbRouter } from "../src/db/router.ts";
import { rowsFrom } from "../src/services/calendar.ts";
import { makeRouter } from "./helpers.ts";
import { createTestDatabase, untilWaiting } from "./postgres-database.ts";
import { testTmpDir } from "./setup.ts";

/**
 * Several processes migrating one PostgreSQL database at once: servers
 * starting with auto_migrate, `todou-server migrate` run twice, or parallel
 * test files opening the same database. Concurrent migrations only collide
 * where migrations are pending, which a database earlier runs have migrated
 * no longer has, so this test makes a new database of its own instead of
 * using TODOU_TEST_POSTGRES_URL itself. Skipped unless that variable points
 * at a server; the role needs CREATEDB.
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;
const OPENERS = 4;
const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));

function journalEntries(tier: DbTier): number {
  const path = new URL(
    `../drizzle/${tier}/meta/_journal.json`,
    import.meta.url,
  );
  return (JSON.parse(readFileSync(path, "utf8")) as { entries: unknown[] })
    .entries.length;
}

async function journalRows(router: DbRouter, tier: DbTier): Promise<number> {
  const result = await router
    .system()
    .execute(
      sql.raw(
        `select count(*)::int as n from drizzle.__drizzle_migrations_${tier}`,
      ),
    );
  return Number(rowsFrom(result)[0]?.n);
}

describe.skipIf(!PG_URL)("concurrent migrations of a new database", () => {
  it("let every open return a fully migrated database", async ({
    onTestFinished,
  }) => {
    if (!PG_URL) throw new Error("TODOU_TEST_POSTGRES_URL is unset");
    const database = await createTestDatabase(PG_URL, "migrate_race");
    const routers: DbRouter[] = [];
    // Not a finally: a timeout never reaches one, and the database would
    // outlive the run.
    onTestFinished(async () => {
      await Promise.all(routers.map((router) => router.close()));
      await database.drop();
    });
    const results = await Promise.allSettled(
      Array.from({ length: OPENERS }, async () => {
        // A pool of its own per router, as separate processes would have.
        // Idle connections are never reaped, so a lock left behind on one
        // keeps every later open waiting until the test times out, instead
        // of only until the pool happens to close that connection.
        const { router } = await makeRouter("shared", {
          systemUrl: database.url,
          extraToml: "[database.pool]\nidle_timeout_ms = 0",
        });
        routers.push(router);
        // Read as soon as this open returns, not once all have: an open
        // that returned before the migration finished would only show it
        // here.
        return {
          system: await journalRows(router, "system"),
          project: await journalRows(router, "project"),
        };
      }),
    );
    const counts = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const expected = {
      system: journalEntries("system"),
      project: journalEntries("project"),
    };
    expect(counts).toEqual(counts.map(() => expected));
  });

  // A process frozen (or cut off) while it waits must not end up holding the
  // lock: PostgreSQL would grant it to a waiter blocked in pg_advisory_lock
  // whether or not anyone is left to use it, and every later migration of the
  // database would wait on a lock nobody releases.
  it("let a migration past a queued process that froze", async ({
    onTestFinished,
  }) => {
    if (!PG_URL) throw new Error("TODOU_TEST_POSTGRES_URL is unset");
    const database = await createTestDatabase(PG_URL, "migrate_frozen");
    const holder = new pg.Client({ connectionString: database.url });
    const routers: DbRouter[] = [];
    let waiter: ChildProcessByStdio<null, Readable, null> | undefined;
    // Not a finally: a timeout never reaches one, and a stopped child and
    // the database would outlive the run. The child dies first so that the
    // drop does not wait out its session.
    onTestFinished(async () => {
      waiter?.kill("SIGKILL");
      await holder.end();
      await Promise.all(routers.map((router) => router.close()));
      await database.drop();
    });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1::bigint)", [
      MIGRATION_LOCK_KEY,
    ]);
    const dir = testTmpDir("todou-migrate-");
    const configPath = join(dir, "config.toml");
    writeFileSync(
      configPath,
      `[database]\nsystem = "${database.url}"\n[storage]\npath = '${dir}'\n`,
    );
    const child = spawn(
      process.execPath,
      ["src/index.ts", "migrate", "--config", configPath],
      { cwd: SERVER_DIR, stdio: ["ignore", "pipe", "inherit"] },
    );
    waiter = child;
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("waiting for another migration")) resolve();
      });
      child.on("exit", () =>
        reject(new Error(`migrate exited before queueing:\n${output}`)),
      );
    });
    child.kill("SIGSTOP");
    await holder.end();

    const { router } = await makeRouter("shared", {
      systemUrl: database.url,
    });
    routers.push(router);
    expect(await journalRows(router, "system")).toBe(journalEntries("system"));

    child.kill("SIGCONT");
    expect(await exited).toBe(0);
  });
});

/**
 * A migration upgrading a database that an older server is still writing to,
 * as in a rolling deploy. Each case runs one synthetic migration shaped like
 * case_insensitive_names, from a folder of its own, rather than a real one: a
 * real migration can be put back to "not yet run" only while it is the
 * newest. Skipped unless TODOU_TEST_POSTGRES_URL points at a server.
 */
describe.skipIf(!PG_URL)("a migration beside a session still writing", () => {
  /** A migrations folder holding one migration made of `statements`. */
  function migrationFolder(statements: string[]): MigrationSet {
    const dir = testTmpDir("todou-migration-");
    mkdirSync(join(dir, "meta"));
    writeFileSync(
      join(dir, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when: 1,
            tag: "0000_test",
            breakpoints: true,
          },
        ],
      }),
    );
    writeFileSync(
      join(dir, "0000_test.sql"),
      statements.join("\n--> statement-breakpoint\n"),
    );
    return {
      migrationsFolder: dir,
      migrationsTable: "__drizzle_migrations_test",
    };
  }

  /**
   * A new database with a session that writes as an older server would and
   * one that watches; the migration gets a pool of its own.
   */
  async function sessions(onTestFinished: (fn: OnTestFinishedHandler) => void) {
    if (!PG_URL) throw new Error("TODOU_TEST_POSTGRES_URL is unset");
    const database = await createTestDatabase(PG_URL, "migrate_writer");
    const writer = new pg.Client({ connectionString: database.url });
    const watcher = new pg.Client({ connectionString: database.url });
    // Made on first use, so that a setting the test puts on the database
    // first applies to its connections.
    let pool: pg.Pool | undefined;
    // Not a finally: a timeout never reaches one, and the database would
    // outlive the run.
    onTestFinished(async () => {
      await writer.end();
      await watcher.end();
      await pool?.end();
      await database.drop();
    });
    await writer.connect();
    await watcher.connect();
    return {
      writer,
      watcher,
      /**
       * Starts the migration and resolves once it waits on a lock in the
       * statement that holds `statement`, or has ended; `done`
       * settles to its error, or null. Wrapped, since an async function
       * returning a promise would wait for it.
       */
      async migrate(migrations: MigrationSet, statement: string) {
        pool = new pg.Pool({ connectionString: database.url });
        const done = migrateNodePgQueued(
          pool,
          "test",
          migrations,
          undefined,
        ).then(
          () => null,
          (err: unknown) => err,
        );
        await untilWaiting(
          watcher,
          "datname = current_database() AND position($1 in query) > 0",
          statement,
          done,
        );
        return { done };
      },
    };
  }

  // The migration locks one table and then another; a writer that took the
  // second first and then reads the first closes the cycle. The migration
  // waited first, so PostgreSQL ends it rather than the writer.
  it("tries a migration again after it loses a deadlock", async ({
    onTestFinished,
  }) => {
    const s = await sessions(onTestFinished);
    await s.writer.query("CREATE TABLE a (id int)");
    await s.writer.query("CREATE TABLE b (id int)");
    const migrations = migrationFolder([
      "LOCK TABLE a IN ACCESS EXCLUSIVE MODE",
      "LOCK TABLE b IN ACCESS EXCLUSIVE MODE",
    ]);

    await s.writer.query("BEGIN");
    await s.writer.query("INSERT INTO b VALUES (1)");
    const { done } = await s.migrate(migrations, "LOCK TABLE b");
    await s.writer.query("SELECT count(*) FROM a");
    await s.writer.query("COMMIT");
    const failure = await done;
    if (failure) throw failure;

    const { rows } = await s.watcher.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations_test",
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  // Under repeatable read DROP INDEX takes the transaction's snapshot before
  // it waits for the table, so the rename after it would not see a name the
  // writer commits meanwhile, and the new index would fail on it.
  it("runs at read committed whatever the database's default", async ({
    onTestFinished,
  }) => {
    const s = await sessions(onTestFinished);
    const { rows: named } = await s.writer.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    await s.writer.query(
      `ALTER DATABASE "${named[0]?.name}" ` +
        "SET default_transaction_isolation = 'repeatable read'",
    );
    await s.writer.query(
      "CREATE TABLE s (id serial PRIMARY KEY, name text NOT NULL)",
    );
    await s.writer.query("CREATE UNIQUE INDEX s_name ON s (name)");
    await s.writer.query("INSERT INTO s (name) VALUES ('Done')");
    const migrations = migrationFolder([
      "DROP INDEX s_name",
      "UPDATE s o SET name = o.name || ' (' || o.id || ')' " +
        "WHERE EXISTS (SELECT 1 FROM s p " +
        "WHERE lower(p.name) = lower(o.name) AND p.id < o.id)",
      "CREATE UNIQUE INDEX s_name ON s (lower(name))",
    ]);

    await s.writer.query("BEGIN");
    const { rows: inserted } = await s.writer.query<{ id: number }>(
      "INSERT INTO s (name) VALUES ('done') RETURNING id",
    );
    const { done } = await s.migrate(migrations, "DROP INDEX");
    await s.writer.query("COMMIT");
    const failure = await done;
    if (failure) throw failure;

    const id = inserted[0]?.id;
    const { rows } = await s.watcher.query<{ name: string }>(
      "SELECT name FROM s ORDER BY id",
    );
    expect(rows).toEqual([{ name: "Done" }, { name: `done (${id})` }]);
  });
});
