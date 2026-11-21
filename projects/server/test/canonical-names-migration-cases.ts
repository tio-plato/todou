/**
 * The canonical_names migration exercised against a real project schema.
 *
 * By the time a test app is up the migration has already run, on tables that
 * held no such names; seeding them and running it again is the upgrade a
 * deployment with older rows goes through. Shared by the PGlite and the
 * real-postgres suite because the migration is SQL, not TypeScript: passing
 * on one driver says nothing about the other.
 */

import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { Db } from "../src/db/driver.ts";
import { migrationStatements, rolledBack, TABLES } from "./name-migration.ts";

async function migrate(db: Db): Promise<void> {
  for (const statement of await migrationStatements("canonical_names")) {
    await db.execute(sql.raw(statement));
  }
}

/**
 * The code points of the Basic Multilingual Plane past NUL, split by whether
 * JavaScript's `\s` (and so `trim()`) counts them as space.
 */
function codePoints(): { space: string[]; other: string[] } {
  const space: string[] = [];
  const other: string[] = [];
  for (let code = 1; code <= 0xffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const c = String.fromCharCode(code);
    (/\s/.test(c) ? space : other).push(c);
  }
  return { space, other };
}

/** Short enough that a name of them fits in a unique index entry. */
const CHUNK = 800;

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
  await rolledBack(db, (tx) => scenario(tx, ids));
}

async function scenario(db: Db, ids: ProjectIds): Promise<void> {
  const { projectA: a, projectB: b } = ids;
  const seeded = [];
  for (const table of TABLES) {
    const add = (projectId: number, name: string) =>
      table.insert(db, projectId, name);

    // M1: every whitespace JS knows is trimmed and collapsed, and every
    // other code point (U+200B, U+0085, U+180E among them) stays as it is.
    const { space, other: plain } = codePoints();
    const spaced = new Map<number, string>();
    for (const c of space) {
      const h = hex(c);
      spaced.set(await add(a, `${c}w${h}${c}${c}end${c}`), `w${h} end`);
    }
    for (let at = 0; at < plain.length; at += CHUNK) {
      const name = plain.slice(at, at + CHUNK).join("");
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
