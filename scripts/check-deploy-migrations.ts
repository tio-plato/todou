// Checks a merge into the fork's deploy branch for migrations the live
// databases would run twice or skip. This script lives only on deploy and
// never goes into a patch sent upstream.
//
// drizzle-orm's migrator reads the newest row of a tier's
// __drizzle_migrations table and runs, in journal order, every journal entry
// whose `when` is strictly above that row's created_at. It compares neither
// tags nor hashes. So a migration the live databases already ran comes back
// under a later `when` and runs again, and a new migration whose `when` is
// not above the newest one they ran is skipped without a word.
//
// Usage, from anywhere in the repository, with the merge in the working tree:
//
//   node scripts/check-deploy-migrations.ts --ran <rev>
//
// <rev> (a commit or a tree) holds every migration the live databases may
// have run: origin/deploy when landing. Each tier's journal and SQL there
// (RAN) are compared with the working tree's (NEXT). Prints one line per
// finding and exits 1 when there is any, 0 when there is none.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export type Migration = { tag: string; when: number; sql: string };

export type Finding = {
  kind: "rerun" | "skip" | "duplicate" | "missing";
  tag: string;
  message: string;
  /** The `when` the entry should get instead: rerun and skip only. */
  fixedWhen?: number;
};

const TIERS = ["system", "project"] as const;

/** A tag without its leading number: `0024_loose_drafts` → `loose_drafts`. */
const nameOf = (tag: string) => tag.replace(/^\d+_/, "");

/**
 * Compares one tier's migrations that ran (RAN) with the merge's (NEXT).
 * SQL is compared as whole files, the text drizzle hashes.
 */
export function checkTier(ran: Migration[], next: Migration[]): Finding[] {
  // The newest `when` any database may have run: the journal is not sorted
  // by `when`, so this is the largest one, not the last entry's.
  const lmax = Math.max(...ran.map((m) => m.when));

  // Pair each NEXT entry with an unpaired RAN entry carrying the same SQL.
  const pairOf = new Map<Migration, Migration>();
  const paired = new Set<Migration>();
  for (const n of next) {
    const r = ran.find((m) => !paired.has(m) && m.sql === n.sql);
    if (r) {
      pairOf.set(n, r);
      paired.add(r);
    }
  }
  const missing = ran.filter((m) => !paired.has(m));
  const standIns = new Map<Migration, string[]>(missing.map((m) => [m, []]));

  const findings: Finding[] = [];
  let nextFree = lmax + 1;
  for (const n of next) {
    const r = pairOf.get(n);
    if (r) {
      if (n.when !== r.when) {
        findings.push({
          kind: "rerun",
          tag: n.tag,
          message:
            `same SQL as ${r.tag}, which ran under when ${r.when}; under when ${n.when} ` +
            (n.when > lmax
              ? "the live databases run it again"
              : n.when > r.when
                ? "a database that ran it but stopped short of this when runs it again"
                : "a database that has not run it yet but is past this when skips it"),
          fixedWhen: r.when,
        });
      }
      continue;
    }
    const twin = ran.find((m) => m.sql === n.sql);
    if (twin) {
      const carrier = next.find((m) => pairOf.get(m) === twin);
      findings.push({
        kind: "duplicate",
        tag: n.tag,
        message: `same SQL as ${twin.tag}, which ${carrier?.tag ?? "another entry"} already carries; databases would run it twice`,
      });
      continue;
    }
    const replaced = missing.filter(
      (m) =>
        m.tag === n.tag || nameOf(m.tag) === nameOf(n.tag) || m.when === n.when,
    );
    if (replaced.length > 0) {
      for (const m of replaced) standIns.get(m)?.push(n.tag);
      continue;
    }
    if (n.when <= lmax) {
      findings.push({
        kind: "skip",
        tag: n.tag,
        message: `new migration under when ${n.when}, not above ${lmax}, the newest when that ran; the live databases skip it`,
        fixedWhen: nextFree++,
      });
    }
  }
  for (const m of missing) {
    const copies = standIns.get(m) ?? [];
    findings.push({
      kind: "missing",
      tag: m.tag,
      message:
        `the SQL that ran under when ${m.when} is gone from the merge` +
        (copies.length > 0
          ? `; ${copies.join(", ")} looks like a changed copy of it`
          : ", deleted or changed"),
    });
  }
  return findings;
}

type Journal = { entries: { tag: string; when: number }[] };

function readTier(read: (path: string) => string): Migration[] {
  const journal = JSON.parse(read("meta/_journal.json")) as Journal;
  return journal.entries.map(({ tag, when }) => ({
    tag,
    when,
    sql: read(`${tag}.sql`),
  }));
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { ran: { type: "string" } },
  });
  if (!values.ran) {
    process.stderr.write(
      "usage: node scripts/check-deploy-migrations.ts --ran <rev>\n",
    );
    process.exit(2);
  }
  const rev = values.ran;
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 });
  const root = git("rev-parse", "--show-toplevel").trim();

  const lines: string[] = [];
  const counts = new Map<string, number>();
  for (const tier of TIERS) {
    const dir = `projects/server/drizzle/${tier}`;
    const ran = readTier((path) => git("show", `${rev}:${dir}/${path}`));
    const next = readTier((path) =>
      readFileSync(join(root, dir, path), "utf8"),
    );
    for (const f of checkTier(ran, next)) {
      const fix =
        f.fixedWhen === undefined ? "" : ` (set when to ${f.fixedWhen})`;
      lines.push(`${tier} ${f.tag} ${f.kind}: ${f.message}${fix}`);
      counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    }
  }
  for (const line of lines) console.log(line);
  if (lines.length === 0) {
    console.log(`no findings against ${rev}`);
    return;
  }
  const summary = [...counts].map(([kind, n]) => `${n} ${kind}`).join(", ");
  console.log(`${lines.length} finding(s) against ${rev}: ${summary}`);
  process.exitCode = 1;
}

if (import.meta.main) main(process.argv.slice(2));
