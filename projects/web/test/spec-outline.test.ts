import type { SpecCommentItem } from "@todou/shared";
import { diffLines } from "diff";
import { describe, expect, it } from "vitest";
import type { DisplayedAnnotation } from "../src/components/spec/annotated-markdown.tsx";
import {
  activeHeading,
  outlineOf,
  sectionAnnotations,
  sectionDiffstat,
  sectionOf,
} from "../src/lib/spec-outline.ts";
import { computeVersionStats } from "../src/lib/spec-version-stats.ts";

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

describe("a spec file's outline (T-234)", () => {
  it("lists the document's own h1 first, and every level down to h6", () => {
    const body = lines("# Title", "intro", "## A", "##### Five", "###### Six");
    expect(outlineOf(body)).toEqual([
      { level: 1, text: "Title", line: 1 },
      { level: 2, text: "A", line: 3 },
      { level: 5, text: "Five", line: 4 },
      { level: 6, text: "Six", line: 5 },
    ]);
  });

  it("does not take a # inside a fence for a heading", () => {
    const body = lines(
      "# T",
      "",
      "```sh",
      "# not a heading",
      "```",
      "",
      "## B",
    );
    expect(outlineOf(body).map((h) => h.text)).toEqual(["T", "B"]);
  });

  it("lists setext headings", () => {
    const body = lines("Title", "=====", "", "Sub", "---");
    expect(outlineOf(body)).toEqual([
      { level: 1, text: "Title", line: 1 },
      { level: 2, text: "Sub", line: 4 },
    ]);
  });

  it("reads code, links and images as what they show", () => {
    const body = lines(
      "## Use `foo()` with [the docs](https://example.com) and ![a logo](x.png)",
    );
    expect(outlineOf(body)[0]?.text).toBe("Use foo() with the docs and a logo");
  });

  it("counts lines from the top of the file, frontmatter included", () => {
    const body = lines("---", "title: x", "---", "", "# Doc", "", "## Part");
    expect(outlineOf(body).map((h) => h.line)).toEqual([5, 7]);
  });

  it("leaves out a heading in a quote, and keeps one a <details> sets apart", () => {
    const body = lines(
      "# Doc",
      "",
      "> ## Quoted",
      "",
      "<details>",
      "<summary>More</summary>",
      "",
      "## Inside",
      "",
      "</details>",
    );
    expect(outlineOf(body)).toEqual([
      { level: 1, text: "Doc", line: 1 },
      { level: 2, text: "Inside", line: 8 },
    ]);
  });

  it("has no rows for a file with no heading", () => {
    expect(outlineOf(lines("just prose", "", "- and a list"))).toEqual([]);
  });

  it("puts what comes before the first heading in the first section", () => {
    const headings = outlineOf(lines("intro", "", "# T", "", "## A", "a"));
    expect([1, 3, 4, 5, 6].map((line) => sectionOf(headings, line))).toEqual([
      0, 0, 0, 1, 1,
    ]);
    expect(sectionOf([], 1)).toBe(-1);
  });
});

/** The stat rows of `after`'s outline against `before`. */
function statsOf(before: string, after: string) {
  return sectionDiffstat(outlineOf(after), before, after, diffLines);
}

describe("each section's added and removed lines (T-234)", () => {
  it("counts an added line in the section it stands in", () => {
    const before = lines("# T", "", "## A", "a1", "", "## B", "b1");
    const after = lines("# T", "", "## A", "a1", "a2", "", "## B", "b1", "b2");
    expect(statsOf(before, after).stats).toEqual([
      { plus: 0, minus: 0 },
      { plus: 1, minus: 0 },
      { plus: 1, minus: 0 },
    ]);
  });

  it("counts lines removed just above a heading with the section above it", () => {
    const before = lines("# T", "", "## A", "a1", "a2", "## B", "b1");
    const after = lines("# T", "", "## A", "a1", "## B", "b1");
    expect(statsOf(before, after).stats).toEqual([
      { plus: 0, minus: 0 },
      { plus: 0, minus: 1 },
      { plus: 0, minus: 0 },
    ]);
  });

  it("counts a reworded heading in its own section, both ways", () => {
    const before = lines("# T", "", "intro", "", "## A", "a1");
    const after = lines("# T", "", "intro", "", "## A2", "a1");
    expect(statsOf(before, after).stats).toEqual([
      { plus: 0, minus: 0 },
      { plus: 1, minus: 1 },
    ]);
  });

  it("counts lines removed at the very top with the first section", () => {
    const before = lines("old first line", "# T", "", "## A", "a");
    const after = lines("# T", "", "## A", "a");
    expect(statsOf(before, after).stats).toEqual([
      { plus: 0, minus: 1 },
      { plus: 0, minus: 0 },
    ]);
  });

  it("counts a change before the first heading with the first section", () => {
    const before = lines("intro", "", "# T", "body");
    const after = lines("intro changed", "", "# T", "body");
    expect(statsOf(before, after).stats).toEqual([{ plus: 1, minus: 1 }]);
  });

  it("counts every line of a new file as added", () => {
    const after = lines("# T", "x", "", "## A", "y", "z");
    expect(statsOf("", after).stats).toEqual([
      { plus: 3, minus: 0 },
      { plus: 3, minus: 0 },
    ]);
  });

  it("takes a kept line to where it went, and a removed one to where it was counted", () => {
    const before = lines("# T", "", "## A", "a1", "a2", "## B", "b1");
    const after = lines("# T", "", "## A", "a1", "## B", "b1");
    const { oldToNew } = statsOf(before, after);
    // a2 (line 5) was removed and counted with a1 above it; "## B" moved up.
    expect([1, 2, 3, 4, 5, 6, 7].map(oldToNew)).toEqual([1, 2, 3, 4, 4, 5, 6]);
  });

  it("adds up to the file rail's own count", () => {
    const before = lines(
      "# Release notes",
      "",
      "Shipped on Tuesday.",
      "",
      "## Fixes",
      "",
      "- the board scrolls again",
      "- titles wrap",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "## Known issues",
      "",
      "| area | state |",
      "| --- | --- |",
      "| sync | slow |",
      "| search | ok |",
      "",
      "## Thanks",
      "",
      "Everyone.",
    );
    const after = lines(
      "Draft — not final.",
      "",
      "# Release notes",
      "",
      "Shipped on Wednesday.",
      "",
      "## Fixes and polish",
      "",
      "- the board scrolls again",
      "- titles wrap",
      "- avatars load",
      "",
      "```ts",
      "const a = 2;",
      "const b = 3;",
      "```",
      "",
      "## Known issues",
      "",
      "| area | state |",
      "| --- | --- |",
      "| search | ok |",
      "",
      "## Thanks",
      "",
      "Everyone.",
      "",
      "## Next",
      "",
      "More.",
    );
    const { stats } = statsOf(before, after);
    const [file] = computeVersionStats(
      { added: [], changed: ["design.md"], removed: [] },
      new Map([["design.md", before]]),
      new Map([["design.md", after]]),
      diffLines,
    );
    expect(file).toBeDefined();
    expect(stats.reduce((sum, s) => sum + s.plus, 0)).toBe(file?.plus);
    expect(stats.reduce((sum, s) => sum + s.minus, 0)).toBe(file?.minus);
    // And each in its place: the draft line and the new date under the
    // title, the reworded heading and its list and code under Fixes, the
    // dropped row under Known issues, the blank line that now closes Thanks
    // there, and the new section's three on its own row.
    expect(stats).toEqual([
      { plus: 3, minus: 1 },
      { plus: 4, minus: 2 },
      { plus: 0, minus: 1 },
      { plus: 1, minus: 0 },
      { plus: 3, minus: 0 },
    ]);
  });
});

const AUTHOR = {
  id: 2,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

function comment(
  start: number,
  resolved: boolean,
  key = `c${start}${resolved}`,
): DisplayedAnnotation {
  const item = {
    comment_id: start,
    author: AUTHOR,
    created_at: "2026-01-01T00:00:00Z",
    body: "note",
    anchor: {
      path: "a.md",
      version: 2,
      line_start: start,
      line_end: start,
      col_start: null,
      col_end: null,
      quote: "",
    },
    resolved: resolved ? { by: AUTHOR, at: "2026-01-02T00:00:00Z" } : null,
    outdated: false,
    current_line_start: start,
    current_line_end: start,
  } as unknown as SpecCommentItem;
  return { key, kind: "comment", item, start, end: start };
}

function draft(start: number): DisplayedAnnotation {
  return {
    key: `d${start}`,
    kind: "draft",
    draft: {
      id: `d${start}`,
      anchor: {
        path: "a.md",
        version: 2,
        line_start: start,
        line_end: start,
        col_start: null,
        col_end: null,
      },
      quote: "",
      body: "draft",
    },
    start,
    end: start,
  };
}

describe("each section's open comments and drafts (T-234)", () => {
  const before = lines("# T", "", "## A", "a1", "a2", "## B", "b1");
  const after = lines("# T", "", "## A", "a1", "## B", "b1");
  const headings = outlineOf(after);
  const { oldToNew } = statsOf(before, after);

  it("counts open comments and drafts apart, and no resolved comment", () => {
    const notes = sectionAnnotations(
      headings,
      [comment(4, false), comment(4, true), draft(6)],
      [],
      oldToNew,
    );
    expect(notes).toEqual([
      { comments: 0, drafts: 0 },
      { comments: 1, drafts: 0 },
      { comments: 0, drafts: 1 },
    ]);
  });

  it("counts one on the baseline in the section its line was counted with", () => {
    // Line 5 of the baseline, a2, is gone; it was counted with A.
    const notes = sectionAnnotations(
      headings,
      [],
      [comment(5, false), draft(6)],
      oldToNew,
    );
    expect(notes).toEqual([
      { comments: 0, drafts: 0 },
      { comments: 1, drafts: 0 },
      { comments: 0, drafts: 1 },
    ]);
  });

  it("counts nowhere one with no line, as a file comment has", () => {
    const fileLevel = { ...comment(1, false), start: 0, end: 0 };
    expect(sectionAnnotations(headings, [fileLevel], [], oldToNew)).toEqual([
      { comments: 0, drafts: 0 },
      { comments: 0, drafts: 0 },
      { comments: 0, drafts: 0 },
    ]);
  });
});

describe("the section the reader is in (T-234)", () => {
  it("counts a heading whose top is right on the reading line", () => {
    expect(activeHeading([100, 300, 500], 300, null)).toBe(1);
    expect(activeHeading([100, 300, 500], 299, null)).toBe(0);
  });

  it("stays on the first section while no heading has passed the line", () => {
    expect(activeHeading([400, 600], 300, null)).toBe(0);
  });

  it("takes the last heading on screen once the page can scroll no further", () => {
    const tops = [-500, 200, 600, 700, 900];
    expect(activeHeading(tops, 300, null)).toBe(1);
    expect(activeHeading(tops, 300, 800)).toBe(3);
  });

  it("takes the last of the folded headings that share a placeholder's top", () => {
    expect(activeHeading([100, 250, 250, 250, 900], 300, null)).toBe(3);
  });

  it("passes over a heading with nothing to measure", () => {
    expect(activeHeading([100, null, 200], 300, null)).toBe(2);
  });
});
