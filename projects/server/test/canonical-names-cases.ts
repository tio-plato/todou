/**
 * The canonical name pass (src/db/canonical-names.ts) exercised against a
 * real project schema.
 *
 * By the time a test app is up its tables hold no names an older server
 * could have stored; seeding them and running the pass is what the next
 * migration of a deployment holding them does. Shared by the PGlite and the
 * real-postgres suite because the pass is SQL: passing on one driver says
 * nothing about the other.
 */

import { expect } from "vitest";
import { canonicalizeNames } from "../src/db/canonical-names.ts";
import type { Db } from "../src/db/driver.ts";
import { rolledBack, TABLES } from "./name-migration.ts";

/**
 * The code points of the Basic Multilingual Plane past NUL, split by whether
 * JavaScript's `\s` (and so `trim()`) counts them as space. Left out of
 * `other` are those NFC may change wherever they stand, the combining marks
 * and the code points with a decomposition: a run of them would be reordered
 * or recomposed, which is M6's business.
 */
function codePoints(): { space: string[]; other: string[] } {
  const space: string[] = [];
  const other: string[] = [];
  for (let code = 1; code <= 0xffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const c = String.fromCharCode(code);
    if (/\s/.test(c)) space.push(c);
    else if (!/\p{M}/u.test(c) && c.normalize("NFD") === c) other.push(c);
  }
  return { space, other };
}

/** Short enough that a name of them fits in a unique index entry. */
const CHUNK = 800;

const hex = (c: string) =>
  (c.codePointAt(0) as number).toString(16).padStart(4, "0");

export type ProjectIds = { projectA: number; projectB: number };

/**
 * Seed names stored before the rule, run the pass, and check each table
 * comes out canonical, with clashes and blank names renamed by id.
 */
export async function checkCanonicalNames(
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

    // M5: a name equal to another under lower() is a clash, as the unique
    // index has it; the canonical one keeps its spelling.
    const p1 = await add(a, "Parked");
    const p2 = await add(a, "parked ");
    const cased = new Map([
      [p1, "Parked"],
      [p2, `parked (${p2})`],
    ]);

    // M6: a name is composed as well as trimmed.
    const c1 = await add(a, "Cafe\u0301  ");
    const composed = new Map([[c1, "Caf\u00e9"]]);

    seeded.push({
      table,
      spaced,
      clashes,
      blanks,
      elsewhere,
      cased,
      composed,
    });
  }

  await canonicalizeNames(db);

  for (const { table, ...groups } of seeded) {
    for (const [group, expected] of Object.entries(groups)) {
      const actual = await table.names(db, [...expected.keys()]);
      expect(actual, `${table.label}: ${group}`).toEqual(expected);
    }
  }
}
