import { describe, expect, it } from "vitest";
import { patchLineOfRow } from "../src/lib/patch-lines.ts";

/**
 * One of the patch viewer's rows, shaped as pierre draws it: a `[data-line]`
 * row inside the `pre` of the item it belongs to — `data-diff` for a file's
 * diff, `data-file` for a commit message, and `data-file` with line numbers
 * disabled for the text as written.
 */
function row(
  drawing: "diff" | "message" | "raw",
  line: number,
  text: string,
  type?: string,
): Element {
  const pre = document.createElement("pre");
  if (drawing === "diff") pre.setAttribute("data-diff", "");
  else pre.setAttribute("data-file", "");
  if (drawing === "raw") pre.setAttribute("data-disable-line-numbers", "");
  const el = document.createElement("div");
  el.setAttribute("data-line", String(line));
  if (type !== undefined) el.setAttribute("data-line-type", type);
  const span = document.createElement("span");
  span.textContent = text;
  el.append(span);
  pre.append(el);
  return el;
}

const TWO_FILES = [
  "From 1234567890abcdef1234567890abcdef12345678 Mon Sep 17 00:00:00 2001",
  "From: alice <noreply@example.com>",
  "Date: Mon, 5 Jan 2026 00:00:00 +0000",
  "Subject: [PATCH] change two files",
  "",
  "Explain the change.",
  "",
  "---",
  " a.txt | 2 +-",
  " b.txt | 3 ++-",
  "",
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,3 +1,3 @@",
  " shared",
  "-old a",
  "+new a",
  " tail a",
  "diff --git a/b.txt b/b.txt",
  "index 3333333..4444444 100644",
  "--- a/b.txt",
  "+++ b/b.txt",
  "@@ -10,3 +10,4 @@",
  " shared",
  "-old b",
  "+new b",
  "+more b",
  " tail b",
  "-- ",
  "2.43.0",
].join("\n");

describe("patchLineOfRow", () => {
  const lines = TWO_FILES.split("\n");
  const secondFile = lines.indexOf("diff --git a/b.txt b/b.txt");

  it("finds a second file's context, deletion and addition rows", () => {
    const context = patchLineOfRow(
      TWO_FILES,
      row("diff", 10, "shared", "context"),
    );
    // " shared" opens both hunks; the number is what puts this one in b.txt.
    expect(context).not.toBeNull();
    expect(lines[context as number]).toBe(" shared");
    expect(context as number).toBeGreaterThan(secondFile);

    const deletion = patchLineOfRow(
      TWO_FILES,
      row("diff", 11, "old b", "change-deletion"),
    );
    expect(lines[deletion as number]).toBe("-old b");

    const addition = patchLineOfRow(
      TWO_FILES,
      row("diff", 12, "more b", "change-addition"),
    );
    expect(lines[addition as number]).toBe("+more b");
  });

  it("counts past a no-newline marker and stops before the signature", () => {
    const patch = [
      "diff --git a/c.txt b/c.txt",
      "--- a/c.txt",
      "+++ b/c.txt",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-last",
      "\\ No newline at end of file",
      "+last",
      "+extra",
      "\\ No newline at end of file",
      "-- ",
      "2.43.0",
    ].join("\n");
    const own = patch.split("\n");
    const extra = patchLineOfRow(
      patch,
      row("diff", 3, "extra", "change-addition"),
    );
    expect(own[extra as number]).toBe("+extra");
    // Read as a deletion, `-- ` would be old line 3 with the text "- ".
    expect(
      patchLineOfRow(patch, row("diff", 3, "- ", "change-deletion")),
    ).toBeNull();
  });

  it("names no line when two files show the same text on the same number", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " same",
      "-a",
      "+A",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,2 +1,2 @@",
      " same",
      "-b",
      "+B",
    ].join("\n");
    expect(patchLineOfRow(patch, row("diff", 1, "same", "context"))).toBeNull();
  });

  it("names no line for a row the patch does not carry", () => {
    expect(
      patchLineOfRow(
        TWO_FILES,
        row("diff", 40, "unmodified", "context-expanded"),
      ),
    ).toBeNull();
  });

  it("finds commit message rows with and without git show's indent", () => {
    const body = patchLineOfRow(
      TWO_FILES,
      row("message", 1, "Explain the change."),
    );
    expect(lines[body as number]).toBe("Explain the change.");

    const shown = [
      "commit 1234567890abcdef1234567890abcdef12345678",
      "Author: alice <noreply@example.com>",
      "Date:   Mon Jan 5 00:00:00 2026 +0000",
      "",
      "    Subject line",
      "",
      "    Body line one.",
      "",
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    const own = shown.split("\n");
    const line = patchLineOfRow(shown, row("message", 1, "Body line one."));
    expect(own[line as number]).toBe("    Body line one.");
  });

  it("names no line for a message line two commits share", () => {
    const commit = (n: number, extra: string) => [
      `From ${String(n).repeat(40)} Mon Sep 17 00:00:00 2001`,
      "From: alice <noreply@example.com>",
      `Subject: [PATCH ${n}/2] commit ${n}`,
      "",
      extra,
      "",
      "Signed-off-by: alice <noreply@example.com>",
      "---",
      `diff --git a/f${n}.txt b/f${n}.txt`,
      `--- a/f${n}.txt`,
      `+++ b/f${n}.txt`,
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "-- ",
      "2.43.0",
      "",
    ];
    const patch = [
      ...commit(1, "Only in the first."),
      ...commit(2, "Only in the second."),
    ].join("\n");
    const own = patch.split("\n");
    expect(
      patchLineOfRow(
        patch,
        row("message", 3, "Signed-off-by: alice <noreply@example.com>"),
      ),
    ).toBeNull();
    const second = patchLineOfRow(
      patch,
      row("message", 1, "Only in the second."),
    );
    expect(own[second as number]).toBe("Only in the second.");
    expect(second as number).toBeGreaterThan(
      own.indexOf("Subject: [PATCH 2/2] commit 2"),
    );
  });

  it("closes a file section that has no hunk at its headers", () => {
    const commit = (n: number, files: string[]) => [
      `From ${String(n).repeat(40)} Mon Sep 17 00:00:00 2001`,
      "From: alice <noreply@example.com>",
      `Subject: [PATCH ${n}/2] commit ${n}`,
      "",
      `Message of commit ${n}.`,
      "---",
      ...files,
      "-- ",
      "2.43.0",
      "",
    ];
    const patch = [
      ...commit(1, [
        "diff --git a/old.txt b/new.txt",
        "similarity index 100%",
        "rename from old.txt",
        "rename to new.txt",
        "diff --git a/run.sh b/run.sh",
        "old mode 100644",
        "new mode 100755",
        "diff --git a/logo.png b/logo.png",
        "index 1111111..2222222 100644",
        "Binary files a/logo.png and b/logo.png differ",
      ]),
      ...commit(2, [
        "diff --git a/c.txt b/c.txt",
        "--- a/c.txt",
        "+++ b/c.txt",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ]),
    ].join("\n");
    const own = patch.split("\n");
    // A section held open until a hunk would take commit 2's message and
    // its file header with it.
    const message = patchLineOfRow(
      patch,
      row("message", 1, "Message of commit 2."),
    );
    expect(own[message as number]).toBe("Message of commit 2.");
    const addition = patchLineOfRow(
      patch,
      row("diff", 1, "y", "change-addition"),
    );
    expect(own[addition as number]).toBe("+y");
  });

  it("reads the raw view by its own line numbers, blank lines included", () => {
    const stat = patchLineOfRow(TWO_FILES, row("raw", 9, " a.txt | 2 +-"));
    expect(stat).toBe(8);
    expect(lines[8]).toBe(" a.txt | 2 +-");
    // An empty row in CodeView reads "\n". Matched as a message line it
    // would be one of several blanks and name nothing.
    const blank = patchLineOfRow(TWO_FILES, row("raw", 5, "\n"));
    expect(blank).toBe(4);
    expect(lines[4]).toBe("");
  });
});
