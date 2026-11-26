/**
 * What the tests of the migrations that rewrite status and label names
 * share: their statements, the two tables they touch, and a way to run a
 * scenario that leaves nothing behind.
 */

import { readFile } from "node:fs/promises";
import { inArray } from "drizzle-orm";
import type pg from "pg";
import type { Db } from "../src/db/driver.ts";
import { labels, statuses } from "../src/db/project-schema.ts";

const PROJECT_MIGRATIONS = new URL("../drizzle/project/", import.meta.url);

/**
 * The statements of the project migration named `name`, found through the
 * journal by its tag rather than by file number, so a migration renumbered
 * to follow others needs no change here.
 */
export async function migrationStatements(name: string): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(new URL("meta/_journal.json", PROJECT_MIGRATIONS), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const entry = journal.entries.find((one) => one.tag.endsWith(`_${name}`));
  if (entry === undefined) throw new Error(`no project migration ${name}`);
  const text = await readFile(
    new URL(`${entry.tag}.sql`, PROJECT_MIGRATIONS),
    "utf8",
  );
  return text
    .split("--> statement-breakpoint")
    .map((one) => one.trim())
    .filter((one) => one !== "");
}

export type Table = {
  label: string;
  /** What a name that is all whitespace becomes, before its id. */
  blank: string;
  insert: (db: Db, projectId: number, name: string) => Promise<number>;
  names: (db: Db, ids: number[]) => Promise<Map<number, string>>;
};

export const TABLES: Table[] = [
  {
    label: "statuses",
    blank: "Status",
    insert: async (db, projectId, name) => {
      const [row] = await db
        .insert(statuses)
        .values({ projectId, name, category: "open", position: 0 })
        .returning({ id: statuses.id });
      return (row as { id: number }).id;
    },
    names: async (db, ids) =>
      new Map(
        (
          await db
            .select({ id: statuses.id, name: statuses.name })
            .from(statuses)
            .where(inArray(statuses.id, ids))
        ).map((row) => [row.id, row.name]),
      ),
  },
  {
    label: "labels",
    blank: "Label",
    insert: async (db, projectId, name) => {
      const [row] = await db
        .insert(labels)
        .values({ projectId, name })
        .returning({ id: labels.id });
      return (row as { id: number }).id;
    },
    names: async (db, ids) =>
      new Map(
        (
          await db
            .select({ id: labels.id, name: labels.name })
            .from(labels)
            .where(inArray(labels.id, ids))
        ).map((row) => [row.id, row.name]),
      ),
  },
];

/**
 * Runs `scenario` in one transaction, always rolled back, so nothing it
 * seeds outlives the run on a shared test database.
 */
export async function rolledBack(
  db: Db,
  scenario: (tx: Db) => Promise<void>,
): Promise<void> {
  const ROLLBACK = Symbol("rollback");
  try {
    await db.transaction(async (tx) => {
      await scenario(tx);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

/** The two tables the migrations touch, with their unique name index. */
export async function createNameTables(client: pg.Client): Promise<void> {
  for (const table of ["statuses", "labels"]) {
    await client.query(
      `CREATE TABLE ${table} (id serial PRIMARY KEY, ` +
        "project_id int NOT NULL, name text NOT NULL)",
    );
    await client.query(
      `CREATE UNIQUE INDEX ${table}_project_name_idx ` +
        `ON ${table} (project_id, name)`,
    );
  }
}
