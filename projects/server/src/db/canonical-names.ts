/**
 * Puts every status and label name into the form the API stores
 * (`canonicalizeLabelName` in @todou/shared): composed to Unicode NFC,
 * trimmed, runs of whitespace collapsed to one space. The API writes nothing
 * else, so this only ever finds names an older server wrote: before the
 * upgrade, while it ran, or afterwards from a replica not yet replaced or
 * after a rollback. It runs after every migration of the project tier, so
 * such a name is put right by the next one.
 *
 * Whitespace is the set JavaScript's \s and trim() match, not PostgreSQL's
 * \s, which follows the database locale. Outside UTF8 only its ASCII part is
 * used: there an escape such as \u00a0 matches a byte, and byte 0xA0 is part
 * of a multi-byte character in SQL_ASCII (the "a" with a grave accent among
 * them) or another letter in an encoding such as KOI8-R, so the wider class
 * would garble the name. The class goes in as a bound parameter, so the
 * regular expression engine reads its escapes whatever
 * standard_conforming_strings says. normalize() exists from PostgreSQL 13
 * and only in a UTF8 database, so elsewhere names are not composed.
 *
 * The names themselves never leave the database: JavaScript sees ids and
 * counts only, and each new name is worked out from the stored one inside
 * the UPDATE. A SQL_ASCII database may hold bytes that are not valid UTF-8,
 * which node-postgres reads as U+FFFD; written back, the name would be
 * garbled for good.
 *
 * A canonical name always stays as it is. A row whose canonical form another
 * row of the same project already holds, compared by lower() as the unique
 * index compares them, becomes "<name> (<id>)", then "<name> (<id>-2)" and
 * so on; of two rows that both need renaming, the one with the lower id is
 * renamed first and so keeps the plain name. A name that is all whitespace
 * becomes "Status <id>" or "Label <id>". The suffix is not cut back to fit
 * the 60-character limit, as 0013 does not cut its own.
 *
 * Each row is renamed by a statement of its own, committed on its own, so
 * this holds one row's lock at a time and never waits for one row while
 * holding another, which with an older server still writing would be a
 * deadlock. Its guard is that the row is still not canonical: under READ
 * COMMITTED a row another session changed meanwhile is read again as it now
 * stands, so a canonical name written there is left alone and another
 * non-canonical one is put right in turn. A rename that trips the unique
 * index on a name committed after its snapshot, or loses a deadlock to a
 * writer that holds that name and then writes the row being renamed, is run
 * again; after three tries the row is left for the next migration.
 *
 * Renames publish no event: a page open on the project shows the new names
 * when it next fetches them.
 */

import { type SQL, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { rowsFrom } from "../services/calendar.ts";
import { sqlStateOf } from "./sql-state.ts";

const TABLES = [
  { table: "statuses", blank: "Status" },
  { table: "labels", blank: "Label" },
];

const UNICODE_SPACE =
  "[\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
const ASCII_SPACE = "[\\u0009-\\u000d\\u0020]";

const RENAME_TRIES = 3;
/** A unique violation (23505) or a lost deadlock (40P01). */
const RETRYABLE = new Set(["23505", "40P01"]);

type Rule = { space: string; compose: boolean };

/** The canonical form of `name`, worked out in SQL. */
function canonical(name: SQL, rule: Rule): SQL {
  const composed = rule.compose ? sql`normalize(${name}, NFC)` : name;
  const edges = `^${rule.space}+|${rule.space}+$`;
  const runs = `${rule.space}+`;
  return sql`regexp_replace(regexp_replace(${composed}, ${edges}::text, '', 'g'), ${runs}::text, ' ', 'g')`;
}

/** Returns how many names it changed. */
export async function canonicalizeNames(
  db: PgDatabase<PgQueryResultHKT>,
): Promise<number> {
  const [settings] = rowsFrom(
    await db.execute(
      sql`SELECT current_setting('server_encoding') = 'UTF8' AS utf8, current_setting('server_version_num')::int >= 130000 AS normalizes`,
    ),
  );
  const utf8 = settings?.utf8 === true;
  const rule: Rule = {
    space: utf8 ? UNICODE_SPACE : ASCII_SPACE,
    compose: utf8 && settings?.normalizes === true,
  };

  let changed = 0;
  for (const { table, blank } of TABLES) {
    const t = sql.identifier(table);
    const stale = rowsFrom(
      await db.execute(
        sql`SELECT id FROM ${t} WHERE ${canonical(sql`name`, rule)} <> name ORDER BY id`,
      ),
    );
    for (const { id } of stale) {
      const base = sql`coalesce(nullif(${canonical(sql`s.name`, rule)}, ''), ${`${blank} `}::text || s.id)`;
      const rename = sql`
        UPDATE ${t} AS s SET name = (
          SELECT c.name
            FROM (SELECT ${base} AS base) b,
                 generate_series(0, (SELECT count(*) FROM ${t} o
                                      WHERE o.project_id = s.project_id)) AS g(n),
                 LATERAL (SELECT b.base || CASE WHEN g.n = 0 THEN ''
                   ELSE ' (' || s.id || CASE WHEN g.n > 1 THEN '-' || g.n ELSE '' END || ')'
                   END AS name) c
           WHERE NOT EXISTS (SELECT 1 FROM ${t} o
                              WHERE o.project_id = s.project_id AND o.id <> s.id
                                AND lower(o.name) = lower(c.name))
           ORDER BY g.n LIMIT 1)
         WHERE s.id = ${id} AND ${canonical(sql`s.name`, rule)} <> s.name
        RETURNING s.id`;
      for (let tries = 1; ; tries++) {
        try {
          changed += rowsFrom(await db.execute(rename)).length;
          break;
        } catch (err) {
          const code = sqlStateOf(err);
          if (code === undefined || !RETRYABLE.has(code)) throw err;
          if (tries >= RENAME_TRIES) {
            console.warn(
              `migrate: left ${table} row ${id} as it was after ` +
                `${RENAME_TRIES} tries (SQLSTATE ${code}); the next migration tries again`,
            );
            break;
          }
        }
      }
    }
  }
  if (changed > 0) {
    console.log(
      `migrate: put ${changed} status and label name(s) in canonical form`,
    );
  }
  return changed;
}
