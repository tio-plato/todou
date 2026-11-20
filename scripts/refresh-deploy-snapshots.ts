// Rewrites a tier's newest migration snapshot from the schema when it is out
// of date. This script lives only on the fork's deploy branch and never goes
// into a patch sent upstream.
//
// drizzle-kit writes a new migration from the difference between the schema
// and the newest snapshot under projects/server/drizzle/<tier>/meta/, which
// holds the whole schema as of that migration. A snapshot made on another
// branch (upstream's, or a card's) lacks the changes of deploy's own
// migrations, so renumbered after them it becomes a wrong newest snapshot,
// and the next generate on deploy writes those changes again. The runtime
// never reads snapshots.
//
// For each tier, drizzle-kit generate runs on a scratch copy of the
// migrations. When it reports no schema changes, the tier is up to date.
// When it writes a migration, every statement of it must already be in one of
// the tier's migrations, or the schema has a change no migration makes and
// the script refuses; otherwise the new snapshot's content replaces the
// newest snapshot's, keeping its id and prevId. Anything else means drizzle-kit
// gave up (it exits 0 then too): its output is printed. A file is written only
// when every tier succeeds; run `pnpm fmt` after a rewrite.
//
// That check is textual and misses one case: a statement a later migration
// undid still counts as made. Say one migration drops a NOT NULL and a later
// one sets it again; a schema that drops it once more, with no migration of
// its own, passes, and the snapshot hides the change. Neither tier has such a
// pair of migrations so far.
//
// Usage, after laying out a merge's journals:
//
//   node scripts/refresh-deploy-snapshots.ts
//
// --drizzle-dir <dir> (default projects/server/drizzle) is for the tests.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const TIERS = ["system", "project"] as const;
const server = fileURLToPath(new URL("../projects/server/", import.meta.url));

type Journal = { entries: { tag: string }[] };

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const tagsOf = (dir: string) =>
  (readJson(join(dir, "meta/_journal.json")) as Journal).entries.map(
    (e) => e.tag,
  );
const snapshotOf = (dir: string, tag: string) =>
  join(dir, "meta", `${tag.split("_")[0]}_snapshot.json`);

type Outcome =
  | { kind: "current" }
  | { kind: "stale"; file: string; content: string; statements: string[] }
  | { kind: "failed"; report: string };

async function refreshTier(drizzleDir: string, tier: string): Promise<Outcome> {
  const dir = join(drizzleDir, tier);
  const config = (
    await import(pathToFileURL(join(server, `drizzle.${tier}.config.ts`)).href)
  ).default as { dialect: string; schema: string };
  const scratch = mkdtempSync(join(tmpdir(), `todou-snapshots-${tier}-`));
  try {
    const copy = join(scratch, tier);
    cpSync(dir, copy, { recursive: true });
    // drizzle-kit puts "./" in front of --out, so it takes a relative path.
    const run = spawnSync(
      join(server, "node_modules/.bin/drizzle-kit"),
      [
        "generate",
        "--dialect",
        config.dialect,
        "--schema",
        config.schema,
        "--out",
        relative(server, copy),
      ],
      {
        cwd: server,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // A run takes seconds; a stalled one ends here as giving up.
        timeout: 120_000,
      },
    );
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error?.message ?? ""}`;
    const tags = tagsOf(dir);
    const added = tagsOf(copy).slice(tags.length);
    if (
      run.status === 0 &&
      added.length === 0 &&
      output.includes("No schema changes")
    ) {
      return { kind: "current" };
    }
    if (run.status !== 0 || added.length !== 1) {
      return {
        kind: "failed",
        report: `drizzle-kit gave up (exit ${run.status}):\n${output}`,
      };
    }

    const statements = readFileSync(join(copy, `${added[0]}.sql`), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const migrations = tags.map((tag) =>
      readFileSync(join(dir, `${tag}.sql`), "utf8"),
    );
    const unmade = statements.filter(
      (s) => !migrations.some((sql) => sql.includes(s)),
    );
    if (unmade.length > 0) {
      return {
        kind: "failed",
        report: `refused: the schema has a change no migration makes:\n${indent(unmade)}`,
      };
    }

    const file = snapshotOf(dir, tags.at(-1) as string);
    const { id, prevId } = readJson(file);
    const snapshot = readJson(snapshotOf(copy, added[0] as string));
    snapshot.id = id;
    snapshot.prevId = prevId;
    const content = `${JSON.stringify(snapshot, null, 2)}\n`;
    return { kind: "stale", file, content, statements };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const indent = (lines: string[]) => lines.map((l) => `  ${l}`).join("\n");

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "drizzle-dir": { type: "string", default: join(server, "drizzle") },
    },
  });
  const drizzleDir = resolve(values["drizzle-dir"]);
  const outcomes = new Map<string, Outcome>();
  for (const tier of TIERS) {
    outcomes.set(tier, await refreshTier(drizzleDir, tier));
  }
  const failed = [...outcomes.values()].some((o) => o.kind === "failed");
  for (const [tier, o] of outcomes) {
    if (o.kind === "current") {
      console.log(`${tier}: up to date`);
    } else if (o.kind === "failed") {
      console.log(`${tier}: ${o.report}`);
    } else {
      if (!failed) writeFileSync(o.file, o.content);
      const file = relative(process.cwd(), o.file);
      console.log(
        `${tier}: ${failed ? "out of date, left as it is" : "rewrote"} ${file}; ` +
          `drizzle-kit generated, all already in the migrations:\n${indent(o.statements)}`,
      );
    }
  }
  if (failed) {
    console.log("nothing written");
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
