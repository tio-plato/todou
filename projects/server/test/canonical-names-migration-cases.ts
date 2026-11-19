/**
 * The canonical_names migration exercised against a real project schema.
 *
 * By the time a test app is up the migration has already run, on tables that
 * held no such names; seeding them and running it again is the upgrade a
 * deployment with older rows goes through. Shared by the PGlite and the
 * real-postgres suite because the migration is SQL, not TypeScript: passing
 * on one driver says nothing about the other.
 */

import { readFile } from "node:fs/promises";
import { inArray, sql } from "drizzle-orm";
import { expect } from "vitest";
import type { Db } from "../src/db/driver.ts";
import { labels, statuses } from "../src/db/project-schema.ts";

const MIGRATION = new URL(
  "../drizzle/project/0025_canonical_names.sql",
  import.meta.url,
);

export async function migrationStatements(): Promise<string[]> {
  const text = await readFile(MIGRATION, "utf8");
  return text
    .split("--> statement-breakpoint")
    .map((one) => one.trim())
    .filter((one) => one !== "");
}

async function migrate(db: Db): Promise<void> {
  for (const statement of await migrationStatements()) {
    await db.execute(sql.raw(statement));
  }
}

type Table = {
  label: string;
  /** What a name that is all whitespace becomes, before its id. */
  blank: string;
  insert: (db: Db, projectId: number, name: string) => Promise<number>;
  names: (db: Db, ids: number[]) => Promise<Map<number, string>>;
};

const TABLES: Table[] = [
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

/** Every code point JavaScript's `\s` (and so `trim()`) counts as space. */
function jsWhitespace(): string[] {
  const found: string[] = [];
  for (let code = 1; code <= 0xffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const c = String.fromCharCode(code);
    if (/\s/.test(c)) found.push(c);
  }
  return found;
}

const hex = (c: string) =>
  (c.codePointAt(0) as number).toString(16).padStart(4, "0");

export type ProjectIds = { projectA: number; projectB: number };

/**
 * Seed names stored before the rule, run the migration, and check each table
 * comes out canonical, with clashes and blank names renamed by id.
 */
export async function checkCanonicalNamesMigration(
  db: Db,
  ids: ProjectIds,
): Promise<void> {
  // One transaction, always rolled back, so nothing the fixture seeds
  // outlives the run on a shared test database.
  const ROLLBACK = Symbol("rollback");
  try {
    await db.transaction(async (tx) => {
      await scenario(tx, ids);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

async function scenario(db: Db, ids: ProjectIds): Promise<void> {
  const { projectA: a, projectB: b } = ids;
  const seeded = [];
  for (const table of TABLES) {
    const add = (projectId: number, name: string) =>
      table.insert(db, projectId, name);

    // M1: every whitespace JS knows is trimmed and collapsed, nothing else.
    const spaced = new Map<number, string>();
    for (const c of jsWhitespace()) {
      const h = hex(c);
      spaced.set(await add(a, `${c}w${h}${c}${c}end${c}`), `w${h} end`);
    }
    for (const name of ["a\u200bb", "a\u0085b", "a\u180eb", "plain name"]) {
      spaced.set(await add(a, name), name);
    }

    // M2: a canonical row keeps its name; the one that would clash with it
    // takes its own id, and the next free suffix after that.
    const k1 = await add(a, "Kept");
    const k2 = await add(a, "Kept ");
    const w1 = await add(a, "Twin\t");
    const w2 = await add(a, "Twin  ");
    await add(a, "Ok");
    const o2 = await add(a, "Ok ");
    const o3 = await add(a, `Ok (${o2})`);
    const clashes = new Map([
      [k1, "Kept"],
      [k2, `Kept (${k2})`],
      [w1, "Twin"],
      [w2, `Twin (${w2})`],
      [o2, `Ok (${o2}-2)`],
      [o3, `Ok (${o2})`],
    ]);

    // M3: a name that is nothing but whitespace is named after its id.
    const b1 = await add(a, "   ");
    const b2 = await add(a, "\u3000");
    const blanks = new Map([
      [b1, `${table.blank} ${b1}`],
      [b2, `${table.blank} ${b2}`],
    ]);

    // M4: only a name in the same project is a clash.
    await add(a, "Shared");
    const other = await add(b, "Shared ");
    const elsewhere = new Map([[other, "Shared"]]);

    seeded.push({ table, spaced, clashes, blanks, elsewhere });
  }

  await migrate(db);

  for (const { table, ...groups } of seeded) {
    for (const [group, expected] of Object.entries(groups)) {
      const actual = await table.names(db, [...expected.keys()]);
      expect(actual, `${table.label}: ${group}`).toEqual(expected);
    }
  }
}
