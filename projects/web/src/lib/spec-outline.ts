import type { Nodes } from "mdast";
import type { DisplayedAnnotation } from "@/components/spec/annotated-markdown.tsx";
import { parseMarkdown } from "./markdown-processor.ts";
import type { DiffLines } from "./spec-version-stats.ts";

/** One row of a spec file's outline (T-234). */
export type OutlineHeading = {
  /** 1–6. */
  level: number;
  /** What the heading reads as, its markup left out. */
  text: string;
  /** The heading's first source line: its `data-loc` once rendered. */
  line: number;
};

/** A section's added and removed lines, as the file rail counts a file's. */
export type SectionStat = { plus: number; minus: number };

/** A section's open published comments and the reader's own drafts. */
export type SectionNotes = { comments: number; drafts: number };

/** The text a reader sees: code's code, a link's words, an image's alt. */
function plainText(node: Nodes): string {
  if (node.type === "image") return node.alt ?? "";
  if ("value" in node && node.type !== "html") return node.value;
  if ("children" in node) return node.children.map(plainText).join("");
  return "";
}

/**
 * Every heading of the document's top level, at every level, in source order.
 * The document's own h1 is the first row, so that what stands between it and
 * the next heading has a row to be counted on. A heading inside a blockquote
 * or a list is part of that block, not of the outline; one inside a
 * `<details>` that blank lines set apart is a top-level node all the same,
 * since the HTML around it is a node of its own.
 */
export function outlineOf(body: string): OutlineHeading[] {
  const root = parseMarkdown(body);
  if (root.type !== "root") return [];
  return root.children.flatMap((node) =>
    node.type === "heading" && node.position !== undefined
      ? [
          {
            level: node.depth,
            text: plainText(node).trim(),
            line: node.position.start.line,
          },
        ]
      : [],
  );
}

/**
 * The section holding a source line: from its heading's line to the line
 * before the next heading. What comes before the first heading belongs to the
 * first section, so every line of the file belongs to exactly one row. -1 when
 * there is no heading at all.
 */
export function sectionOf(headings: OutlineHeading[], line: number): number {
  if (headings.length === 0) return -1;
  let at = 0;
  for (let i = 0; i < headings.length; i++) {
    if ((headings[i]?.line ?? Number.POSITIVE_INFINITY) <= line) at = i;
    else break;
  }
  return at;
}

/**
 * Each section's added and removed lines between `before` and `after`, by the
 * same line diff the file rail counts with, so the rows add up to the file's
 * row. An added line counts where it stands. A run of removed lines counts
 * with what replaces it when something does, so a reworded heading counts in
 * its own section; otherwise with the last line kept above it, which is the
 * section it stood in before, or with the first section at the top of the
 * file.
 *
 * `oldToNew` takes a baseline line to the line of `after` it was counted
 * with: where a kept line went, and where a removed one was counted.
 */
export function sectionDiffstat(
  headings: OutlineHeading[],
  before: string,
  after: string,
  diffLines: DiffLines,
): { stats: SectionStat[]; oldToNew: (oldLine: number) => number } {
  const stats = headings.map(() => ({ plus: 0, minus: 0 }));
  const map: number[] = [];
  const parts = diffLines(before, after);
  let oldLine = 1;
  let newLine = 1;
  /** The last line both versions kept, 0 before the first. */
  let kept = 0;
  const count = (line: number, key: keyof SectionStat, n: number) => {
    const stat = stats[Math.max(0, sectionOf(headings, line))];
    if (stat !== undefined) stat[key] += n;
  };
  parts.forEach((part, i) => {
    const n = part.count ?? 0;
    if (part.added) {
      for (let k = 0; k < n; k++) count(newLine + k, "plus", 1);
      newLine += n;
    } else if (part.removed) {
      const replaced = parts[i + 1]?.added === true;
      const at = replaced ? newLine : kept;
      count(at, "minus", n);
      for (let k = 0; k < n; k++) map[oldLine + k] = Math.max(at, 1);
      oldLine += n;
    } else {
      for (let k = 0; k < n; k++) map[oldLine + k] = newLine + k;
      oldLine += n;
      newLine += n;
      kept = newLine - 1;
    }
  });
  const last = Math.max(kept, newLine - 1, 1);
  return {
    stats,
    oldToNew: (line) => map[line] ?? last,
  };
}

/**
 * Each section's open comments and drafts: published comments nobody has
 * resolved, and the reader's drafts, each by its first line. `baseline` hangs
 * on the compare baseline's lines, which `oldToNew` takes to the viewed
 * version's. An annotation with no line is not in the document, and counts
 * nowhere.
 */
export function sectionAnnotations(
  headings: OutlineHeading[],
  current: DisplayedAnnotation[],
  baseline: DisplayedAnnotation[],
  oldToNew: (oldLine: number) => number,
): SectionNotes[] {
  const notes = headings.map(() => ({ comments: 0, drafts: 0 }));
  const add = (annotation: DisplayedAnnotation, line: number) => {
    if (annotation.start < 1) return;
    const key =
      annotation.kind === "draft"
        ? "drafts"
        : annotation.item.resolved === null
          ? "comments"
          : null;
    if (key === null) return;
    const section = notes[sectionOf(headings, line)];
    if (section !== undefined) section[key] += 1;
  };
  for (const annotation of current) add(annotation, annotation.start);
  for (const annotation of baseline) {
    add(annotation, oldToNew(annotation.start));
  }
  return notes;
}

/**
 * The section the reader is in: the last heading whose top has passed the
 * reading line, or the first section while none has. A page that can scroll
 * no further takes the last heading whose top is on screen, above
 * `screenBottom`, or the last few short sections could never be reached.
 * `tops` holds each heading's top, null for one with nothing to measure, in
 * the coordinates of the two lines.
 */
export function activeHeading(
  tops: Array<number | null>,
  readingLine: number,
  screenBottom: number | null,
): number {
  let at = 0;
  tops.forEach((top, i) => {
    if (top === null) return;
    if (top <= readingLine) at = i;
    else if (screenBottom !== null && top < screenBottom) at = i;
  });
  return at;
}
