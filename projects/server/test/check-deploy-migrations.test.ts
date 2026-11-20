// The migration check of the fork's deploy branch (scripts/check-deploy-
// migrations.ts). Like the script, this file lives only on deploy and never
// goes into a patch sent upstream.
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkTier,
  type Migration,
} from "../../../scripts/check-deploy-migrations.ts";
import { testTmpDir } from "./setup.ts";

const script = fileURLToPath(
  new URL("../../../scripts/check-deploy-migrations.ts", import.meta.url),
);

const a: Migration = { tag: "0023_a", when: 100, sql: "CREATE TABLE a ();" };
const b: Migration = { tag: "0024_b", when: 200, sql: "CREATE TABLE b ();" };

describe("checkTier", () => {
  it("sends a migration upstream brought back to the when it ran under", () => {
    const findings = checkTier(
      [a, b],
      [{ tag: "0023_a2", when: 300, sql: a.sql }, b],
    );
    expect(findings).toEqual([
      expect.objectContaining({ kind: "rerun", fixedWhen: 100 }),
    ]);
  });

  it("moves a new migration with an early when past the newest one that ran, in order", () => {
    const ran = [
      { tag: "0001_x", when: 100, sql: "CREATE TABLE x ();" },
      { tag: "0002_y", when: 200, sql: "CREATE TABLE y ();" },
      { tag: "0003_z", when: 150, sql: "CREATE TABLE z ();" },
    ];
    const findings = checkTier(ran, [
      ...ran,
      { tag: "0004_p", when: 180, sql: "CREATE TABLE p ();" },
      { tag: "0005_q", when: 120, sql: "CREATE TABLE q ();" },
    ]);
    expect(findings.map((f) => [f.kind, f.tag])).toEqual([
      ["skip", "0004_p"],
      ["skip", "0005_q"],
    ]);
    const [p, q] = findings.map((f) => f.fixedWhen ?? Number.NaN);
    expect(p).toBeGreaterThan(200);
    expect(q).toBeGreaterThan(p);
  });

  it("finds nothing in a merge that renumbers what ran and adds a later migration", () => {
    const findings = checkTier(
      [a, b],
      [
        { ...a, tag: "0030_a" },
        { ...b, tag: "0031_b" },
        { tag: "0032_c", when: 300, sql: "CREATE TABLE c ();" },
      ],
    );
    expect(findings).toEqual([]);
  });

  it("reports SQL that ran and is gone, naming the copy that took its place", () => {
    const findings = checkTier(
      [a, b],
      [a, { tag: "0025_b", when: 150, sql: "CREATE TABLE b (id int);" }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "missing", tag: "0024_b" });
    expect(findings[0]?.message).toContain("0025_b");
    expect(findings[0]?.fixedWhen).toBeUndefined();
  });

  it("reports SQL that ran and was changed in place", () => {
    const findings = checkTier(
      [a, b],
      [a, { ...b, sql: `-- a note\n${b.sql}` }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "missing", tag: "0024_b" });
    expect(findings[0]?.fixedWhen).toBeUndefined();
  });

  it("reports SQL that ran, carried twice", () => {
    const findings = checkTier(
      [a, b],
      [a, b, { tag: "0025_a2", when: 300, sql: a.sql }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "duplicate" });
    expect(findings[0]?.fixedWhen).toBeUndefined();
  });
});

describe("the command", () => {
  // A hook or a git alias can set these; the scratch repository must not
  // inherit them.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  const run = (cwd: string, command: string, args: string[]) =>
    spawnSync(command, args, { cwd, env, encoding: "utf8" });

  const writeTier = (
    root: string,
    tier: string,
    migrations: { tag: string; when: number; sql: string }[],
  ) => {
    const dir = join(root, "projects/server/drizzle", tier);
    mkdirSync(join(dir, "meta"), { recursive: true });
    const entries = migrations.map((m, idx) => ({
      idx,
      version: "7",
      when: m.when,
      tag: m.tag,
      breakpoints: true,
    }));
    writeFileSync(
      join(dir, "meta/_journal.json"),
      JSON.stringify({ version: "7", dialect: "postgresql", entries }),
    );
    for (const m of migrations) writeFileSync(join(dir, `${m.tag}.sql`), m.sql);
  };

  it("runs when started through a symlinked path", () => {
    const link = join(testTmpDir("todou-check-migrations-link-"), "scripts");
    symlinkSync(dirname(script), link);
    const r = run(link, process.execPath, [join(link, basename(script))]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("usage");
  });

  it("reads what ran from --ran and the merge from the working tree", () => {
    const repo = testTmpDir("todou-check-migrations-");
    expect(run(repo, "git", ["init", "-q"]).status).toBe(0);
    const system = [a, b];
    writeTier(repo, "system", system);
    writeTier(repo, "project", [
      { tag: "0000_p", when: 50, sql: "CREATE TABLE p ();" },
    ]);
    expect(run(repo, "git", ["add", "-A"]).status).toBe(0);
    const tree = run(repo, "git", ["write-tree"]).stdout.trim();

    const clean = run(repo, process.execPath, [script, "--ran", tree]);
    expect(clean.status, clean.stderr).toBe(0);

    writeTier(repo, "system", [
      ...system,
      { tag: "0025_early", when: 150, sql: "CREATE TABLE early ();" },
    ]);
    const blocked = run(repo, process.execPath, [script, "--ran", tree]);
    expect(blocked.status, blocked.stderr).toBe(1);
    expect(blocked.stdout).toMatch(/0025_early.*skip.*\b201\b/);
  });
});
