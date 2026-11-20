/**
 * The case_insensitive_names migration exercised against a real project
 * schema, shared by the PGlite and the real-postgres suite for the reason
 * canonical-names-migration-cases.ts gives.
 *
 * By the time a test app is up the migration has already run, so the names
 * an older server could store side by side no longer fit its indexes. The
 * scenario first puts the indexes back as they were, then seeds those names
 * and runs the migration again: the upgrade a deployment holding them goes
 * through.
 */

import { sql } from "drizzle-orm";
import { expect } from "vitest";
import { uniqueViolation } from "../src/auth/provision.ts";
import type { Db } from "../src/db/driver.ts";
import {
  LABEL_NAME_INDEX,
  STATUS_NAME_INDEX,
} from "../src/db/project-schema.ts";
import { migrationStatements, rolledBack, TABLES } from "./name-migration.ts";

const INDEX: Record<string, string> = {
  statuses: STATUS_NAME_INDEX,
  labels: LABEL_NAME_INDEX,
};

export type ProjectIds = { projectA: number; projectB: number };

/**
 * Seed names that differ only in case or in Unicode composition, run the
 * migration, and check which keep their name and which are renamed by id.
 * Both test databases fold non-ASCII letters in lower() (ctype C.UTF-8).
 */
export async function checkCaseInsensitiveNamesMigration(
  db: Db,
  ids: ProjectIds,
): Promise<void> {
  await rolledBack(db, (tx) => scenario(tx, ids));
}

async function scenario(db: Db, ids: ProjectIds): Promise<void> {
  const { projectA: a, projectB: b } = ids;
  for (const table of TABLES) {
    await db.execute(sql.raw(`DROP INDEX "${INDEX[table.label]}"`));
    await db.execute(
      sql.raw(
        `CREATE UNIQUE INDEX "${INDEX[table.label]}" ` +
          `ON "${table.label}" ("project_id", "name")`,
      ),
    );
  }

  const seeded = [];
  for (const table of TABLES) {
    const add = (projectId: number, name: string) =>
      table.insert(db, projectId, name);

    // C1: names that differ only in case; the first one keeps its name.
    // (New projects already hold Done, so the word is one they do not.)
    const p1 = await add(a, "Parked");
    const p2 = await add(a, "parked");
    const p3 = await add(a, "PARKED");
    const e1 = await add(a, "État");
    const e2 = await add(a, "état");
    const cased = new Map([
      [p1, "Parked"],
      [p2, `parked (${p2})`],
      [p3, `PARKED (${p3})`],
      [e1, "État"],
      [e2, `état (${e2})`],
    ]);

    // C2: a suffix another row already holds, whatever its case, is passed
    // over for the next one.
    await add(a, "Ok");
    const o2 = await add(a, "ok");
    const o3 = await add(a, `OK (${o2})`);
    const taken = new Map([
      [o2, `ok (${o2}-2)`],
      [o3, `OK (${o2})`],
    ]);

    // C3: names that differ only in composition: the NFC one keeps its
    // name even though it came later.
    const c1 = await add(a, "Café");
    const c2 = await add(a, "Café");
    const composed = new Map([
      [c1, `Café (${c1})`],
      [c2, "Café"],
    ]);

    // C4: a name that clashes with nothing is still stored as NFC.
    const t1 = await add(a, "Thé");
    const alone = new Map([[t1, "Thé"]]);

    // C5: only a name in the same project is a clash.
    await add(a, "Shared");
    const s2 = await add(b, "shared");
    const elsewhere = new Map([[s2, "shared"]]);

    seeded.push({ table, cased, taken, composed, alone, elsewhere });
  }

  for (const statement of await migrationStatements("case_insensitive_names")) {
    await db.execute(sql.raw(statement));
  }

  for (const { table, ...groups } of seeded) {
    for (const [group, expected] of Object.entries(groups)) {
      const actual = await table.names(db, [...expected.keys()]);
      expect(actual, `${table.label}: ${group}`).toEqual(expected);
    }

    // C6: from now on the index refuses a name differing only in case.
    let refused: unknown = null;
    try {
      await db.transaction(async (savepoint) => {
        await table.insert(savepoint, a, "pArKeD");
      });
    } catch (err) {
      refused = err;
    }
    expect(uniqueViolation(refused), table.label).toBe(INDEX[table.label]);
  }
}
