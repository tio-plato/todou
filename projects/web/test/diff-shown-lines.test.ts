import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { hangLine, shownLines } from "../src/lib/diff-shown-lines.ts";

/** A hunk with only the fields the visible-line model reads. */
const hunk = (
  collapsedBefore: number,
  [additionStart, additionCount]: [number, number],
  [deletionStart, deletionCount]: [number, number],
) => ({
  collapsedBefore,
  additionStart,
  additionCount,
  deletionStart,
  deletionCount,
});

/**
 * Three hunks over a 40-line new side and a 39-line old one, the new side
 * holding one more line in the first hunk:
 *
 *   new  1–7  hunk · 8–19 collapsed (12) · 20–26 hunk · 27 drawn (1) ·
 *        28–30 hunk · 31–40 collapsed (10)
 *   old  1–6  hunk · 7–18 collapsed      · 19–25 hunk · 26 drawn     ·
 *        27–29 hunk · 30–39 collapsed
 */
const DIFF = {
  hunks: [
    hunk(0, [1, 7], [1, 6]),
    hunk(12, [20, 7], [19, 7]),
    hunk(1, [28, 3], [27, 3]),
  ],
  isPartial: false,
  additionLines: Array.from({ length: 40 }, () => ""),
  deletionLines: Array.from({ length: 39 }, () => ""),
} as unknown as FileDiffMetadata;

const additions = shownLines(DIFF, "additions", 1);
const deletions = shownLines(DIFF, "deletions", 1);

describe("the line a note hangs under in the source diff", () => {
  it("is the range's end when the end is in a hunk", () => {
    expect(hangLine(3, 5, additions)).toBe(5);
  });

  it("is the last shown line when the end is collapsed", () => {
    expect(hangLine(5, 12, additions)).toBe(7);
    expect(hangLine(29, 35, additions)).toBe(30);
  });

  it("is the end when the whole range is collapsed", () => {
    expect(hangLine(9, 15, additions)).toBe(15);
  });

  it("counts a one-line run between hunks as shown", () => {
    expect(hangLine(25, 27, additions)).toBe(27);
  });

  it("reads the old side's own hunk lines", () => {
    // The new side's first hunk runs to 7, the old side's to 6.
    expect(hangLine(4, 10, deletions)).toBe(6);
    expect(hangLine(24, 26, deletions)).toBe(26);
  });
});

describe("the lines of a side pierre draws", () => {
  // A five-line file with one hunk over lines 2–4: one unchanged line
  // before it and one after.
  const short = (isPartial: boolean) =>
    ({
      hunks: [hunk(1, [2, 3], [2, 3])],
      isPartial,
      additionLines: Array.from({ length: 5 }, () => ""),
      deletionLines: Array.from({ length: 5 }, () => ""),
    }) as unknown as FileDiffMetadata;

  it("draws a run as short as the threshold before the first hunk and after the last", () => {
    expect(shownLines(short(false), "additions", 1)).toEqual([
      { start: 1, end: 1 },
      { start: 2, end: 4 },
      { start: 5, end: 5 },
    ]);
    expect(shownLines(short(false), "additions", 0)).toEqual([
      { start: 2, end: 4 },
    ]);
  });

  it("draws no run of a diff parsed from a patch", () => {
    expect(shownLines(short(true), "additions", 1)).toEqual([
      { start: 2, end: 4 },
    ]);
  });
});
