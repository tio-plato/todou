// The snapshot refresh of the fork's deploy branch (scripts/refresh-deploy-
// snapshots.ts), run on a copy of the real migrations against the real
// schema. Like the script, this file lives only on deploy and never goes into
// a patch sent upstream.
import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testTmpDir } from "./setup.ts";

const script = fileURLToPath(
  new URL("../../../scripts/refresh-deploy-snapshots.ts", import.meta.url),
);
const drizzle = fileURLToPath(new URL("../drizzle", import.meta.url));

// Each run starts drizzle-kit once per tier.
const timeout = 60_000;

function copyMigrations() {
  const dir = join(testTmpDir("todou-refresh-snapshots-"), "drizzle");
  cpSync(drizzle, dir, { recursive: true });
  return dir;
}

/** The project tier's snapshots, newest last, in journal order. */
function projectSnapshots(dir: string) {
  const journal = JSON.parse(
    readFileSync(join(dir, "project/meta/_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  return journal.entries.map((e) =>
    join(dir, "project/meta", `${e.tag.split("_")[0]}_snapshot.json`),
  );
}

// biome-ignore lint/suspicious/noExplicitAny: a drizzle-kit snapshot is untyped JSON
type Snapshot = any;
const read = (file: string): Snapshot => JSON.parse(readFileSync(file, "utf8"));
const edit = (file: string, change: (s: Snapshot) => void) => {
  const snapshot = read(file);
  change(snapshot);
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
};

/** Every file under `dir` with its content, to tell whether a run wrote any. */
const contents = (dir: string) =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const path = join(e.parentPath, e.name);
        return [path, readFileSync(path, "utf8")];
      }),
  );

const refresh = (dir: string) => {
  const r = spawnSync(process.execPath, [script, "--drizzle-dir", dir], {
    encoding: "utf8",
  });
  return { status: r.status, output: r.stdout + r.stderr };
};

describe("refresh-deploy-snapshots", () => {
  it(
    "rewrites a stale newest snapshot from the schema and keeps its id and prevId",
    () => {
      const dir = copyMigrations();
      const newest = projectSnapshots(dir).at(-1) as string;
      const before = read(newest);
      edit(newest, (s) => {
        const attachments = s.tables["public.attachments"];
        attachments.columns.issue_id.notNull = true;
        delete attachments.checkConstraints.attachments_card_or_draft;
      });

      const first = refresh(dir);
      expect(first.status, first.output).toBe(0);
      const after = read(newest);
      const attachments = after.tables["public.attachments"];
      expect(attachments.columns.issue_id.notNull).toBe(false);
      expect(attachments.checkConstraints).toHaveProperty(
        "attachments_card_or_draft",
      );
      expect([after.id, after.prevId]).toEqual([before.id, before.prevId]);

      const written = readFileSync(newest, "utf8");
      const second = refresh(dir);
      expect(second.status, second.output).toBe(0);
      expect(second.output).toMatch(/system: up to date/);
      expect(second.output).toMatch(/project: up to date/);
      expect(readFileSync(newest, "utf8")).toBe(written);
    },
    timeout,
  );

  it(
    "refuses when the schema has a change no migration makes",
    () => {
      const dir = copyMigrations();
      edit(projectSnapshots(dir).at(-1) as string, (s) => {
        s.tables["public.attachments"].columns.ghost = {
          name: "ghost",
          type: "integer",
          primaryKey: false,
          notNull: false,
        };
      });
      const before = contents(dir);

      const run = refresh(dir);
      expect(run.status, run.output).not.toBe(0);
      expect(run.output).toContain("ghost");
      expect(contents(dir)).toEqual(before);
    },
    timeout,
  );

  it(
    "does not count drizzle-kit giving up on the snapshots as up to date",
    () => {
      const dir = copyMigrations();
      const [previous, newest] = projectSnapshots(dir).slice(-2) as [
        string,
        string,
      ];
      const sharedParent = read(previous).prevId;
      edit(newest, (s) => {
        s.prevId = sharedParent;
      });
      const before = contents(dir);

      const run = refresh(dir);
      expect(run.status, run.output).not.toBe(0);
      expect(contents(dir)).toEqual(before);
    },
    timeout,
  );
});
