import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Logger } from "drizzle-orm/logger";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import { PGLITE_EXTENSIONS } from "./pglite-extensions.ts";
import { WorkerPgliteClient } from "./worker-client.ts";

/** Driver-agnostic database type both pglite and node-postgres satisfy. */
export type Db = PgDatabase<PgQueryResultHKT>;

export type DbKind = "pglite" | "postgres";
export type DbTier = "system" | "project";

export type DbHandle = {
  db: Db;
  kind: DbKind;
  url: string;
  migrate: (tier: DbTier) => Promise<void>;
  close: () => Promise<void>;
  /**
   * A statement or transaction issued through this handle has not finished,
   * or a caller is queued for a connection: closing it now would cut that
   * work off or leave it waiting forever.
   */
  busy: () => boolean;
};

// Each tier keeps its own journal table: in shared placement both tiers
// live in one database, and a common journal would let one tier's newer
// timestamps mask the other tier's pending migrations.
const MIGRATIONS: Record<
  DbTier,
  { migrationsFolder: string; migrationsTable: string }
> = {
  system: {
    migrationsFolder: fileURLToPath(
      new URL("../../drizzle/system", import.meta.url),
    ),
    migrationsTable: "__drizzle_migrations_system",
  },
  project: {
    migrationsFolder: fileURLToPath(
      new URL("../../drizzle/project", import.meta.url),
    ),
    migrationsTable: "__drizzle_migrations_project",
  },
};

export function dbKindOf(url: string): DbKind {
  if (url.startsWith("pglite://")) return "pglite";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return "postgres";
  }
  throw new Error(`unsupported database URL: ${url}`);
}

export type PoolOptions = {
  max: number;
  idle_timeout_ms: number;
  connection_timeout_ms: number;
};

export type OpenDbOptions = {
  workerHost?: boolean;
  pool?: PoolOptions;
  logger?: Logger;
  /**
   * The tiers the caller is about to migrate this database to. Read only for
   * in-memory PGlite, where it selects a pre-migrated template instead of a
   * fresh initdb; the caller's own `migrate` calls then cost ~8ms and stay
   * the authority on what ran. Leave it out when the caller will not migrate
   * at all, which is what `auto_migrate = false` asks for.
   */
  tiers?: DbTier[];
};

export async function openDb(
  url: string,
  opts?: OpenDbOptions,
): Promise<DbHandle> {
  const kind = dbKindOf(url);
  if (kind === "pglite") {
    // "pglite://memory" (with optional suffix for distinct instances) is
    // in-memory; anything else is a data directory path.
    const target = url.slice("pglite://".length);
    const isMemory = target.startsWith("memory");
    // PGlite fails obscurely on first query when the data directory's
    // parents don't exist yet.
    if (!isMemory) await mkdir(target, { recursive: true });
    // Worker host: PGlite lives in a worker thread and the proxy
    // satisfies drizzle's query surface, so per-project databases
    // execute on separate cores.
    const client = opts?.workerHost
      ? (new WorkerPgliteClient(
          isMemory ? undefined : target,
        ) as unknown as PGlite)
      : isMemory
        ? await memoryClient(opts?.tiers ?? [])
        : new PGlite(target, { extensions: PGLITE_EXTENSIONS });
    const counted = countCalls(client);
    const db = drizzlePglite(counted.client, { logger: opts?.logger });
    return {
      db: db as unknown as Db,
      kind,
      url,
      migrate: (tier) => migratePglite(db, MIGRATIONS[tier]),
      close: counted.close,
      busy: counted.busy,
    };
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: opts?.pool?.max,
    idleTimeoutMillis: opts?.pool?.idle_timeout_ms,
    connectionTimeoutMillis: opts?.pool?.connection_timeout_ms,
  });
  const db = drizzleNodePg(pool, { logger: opts?.logger });
  return {
    db: db as unknown as Db,
    kind,
    url,
    migrate: (tier) => migrateNodePg(db, MIGRATIONS[tier]),
    close: () => pool.end(),
    busy: () => pool.waitingCount > 0 || pool.totalCount > pool.idleCount,
  };
}

/**
 * The PGlite client as drizzle gets it, counting the calls still running so
 * the handle can say whether it is busy.
 *
 * drizzle reaches the client through `query` and `transaction` alone
 * (drizzle-orm/pglite/session.js), so a transaction counts from the call
 * until its callback and COMMIT are done. PGlite's own `isInTransaction()`
 * would not do: close() does not wait for a lone autocommit statement
 * either. The inline client and the worker one go through this same count.
 *
 * Closed is recorded here, synchronously, before the client's close() runs:
 * PGlite 0.5.4's close() first awaits `_checkReady()` and only then marks
 * itself closing, and a transaction begun in that gap wedges the event loop.
 * From then on both calls reject without reaching the client.
 */
function countCalls(client: PGlite): {
  client: PGlite;
  busy: () => boolean;
  close: () => Promise<void>;
} {
  let running = 0;
  let closed = false;
  // Async so a synchronous throw still settles the count; the body up to
  // the call runs in the caller's tick, which is what the closed check needs.
  const counted = async <T>(call: () => Promise<T>): Promise<T> => {
    if (closed) throw new Error("PGlite handle is closed");
    running += 1;
    try {
      return await call();
    } finally {
      running -= 1;
    }
  };
  const wrapped: Pick<PGlite, "query" | "transaction"> = {
    query: (...args) => counted(() => client.query(...args)),
    transaction: (callback) => counted(() => client.transaction(callback)),
  };
  return {
    client: wrapped as PGlite,
    busy: () => running > 0,
    close: () => {
      closed = true;
      return client.close();
    },
  };
}

type MemoryTemplate = {
  dump: Awaited<ReturnType<PGlite["dumpDataDir"]>>;
  /** The instance the dump was taken from, until somebody claims it. */
  seed: PGlite | null;
};

/**
 * Pre-migrated in-memory databases, keyed by the tiers they carry.
 *
 * `new PGlite()` on a memory URL runs a full initdb inside the WASM build on
 * its first query — measured at ~1.8s, and the second instance in a process
 * costs the same as the first, because only the WASM module compile is
 * cached. Restoring a dump of an already-migrated instance costs ~0.4s and
 * brings the migrations with it. Only tests open memory URLs (a deployment
 * names a data directory, see docs/deploy.md), and there one test file stands
 * up three of these per test case.
 *
 * Whoever builds a template is handed the seed instance itself, so the first
 * database of a tier set pays the ~0.1s dump and nothing else on top of the
 * initdb it already owed; every later one pays ~0.4s instead of ~1.8s.
 *
 * Migrating the seed deliberately bypasses the caller's `logger`: routed
 * through it, the migration DDL would reach the query tap of whichever test
 * happened to run first in a fork and of no other, which would make a
 * statement count depend on test order.
 */
const memoryTemplates = new Map<string, Promise<MemoryTemplate>>();

async function buildMemoryTemplate(tiers: DbTier[]): Promise<MemoryTemplate> {
  const seed = new PGlite({ extensions: PGLITE_EXTENSIONS });
  const db = drizzlePglite(seed);
  for (const tier of tiers) await migratePglite(db, MIGRATIONS[tier]);
  // Uncompressed: gzip trades ~1.5s of dump and ~0.5s of every restore for
  // 36 MiB of resident size per template, and time is the whole point here.
  return { dump: await seed.dumpDataDir("none"), seed };
}

async function memoryClient(tiers: DbTier[]): Promise<PGlite> {
  if (tiers.length === 0) return new PGlite({ extensions: PGLITE_EXTENSIONS });
  const key = tiers.join("+");
  let building = memoryTemplates.get(key);
  if (!building) {
    building = buildMemoryTemplate(tiers);
    // A rejected build must not stay cached: one failing migration would
    // otherwise become every later open in the process failing, with the
    // original stack attached to a call that did nothing wrong.
    building.catch(() => memoryTemplates.delete(key));
    memoryTemplates.set(key, building);
  }
  const template = await building;
  if (template.seed) {
    const seed = template.seed;
    template.seed = null;
    return seed;
  }
  return new PGlite({
    loadDataDir: template.dump,
    extensions: PGLITE_EXTENSIONS,
  });
}
