import {
  DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { LineRange } from "./spec-changes.ts";

/**
 * The longest run of unchanged lines pierre draws between hunks instead of
 * collapsing it. The source diff hands pierre this value, so the lines
 * `shownLines` reports and the rows pierre draws come from one number.
 */
export const COLLAPSED_CONTEXT_THRESHOLD = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD;

/**
 * The 1-based lines of one side of a diff that pierre draws before the reader
 * expands anything: every hunk's lines, and each run of unchanged lines
 * around them no longer than `threshold`, which pierre draws rather than
 * collapse. A run is the lines between two hunks, before the first one or
 * after the last one; pierre keeps a trailing run only when both sides have
 * lines, and the run is as long on either side. A diff parsed from a patch
 * rather than two whole files has no run to draw.
 */
export function shownLines(
  fileDiff: FileDiffMetadata,
  side: "additions" | "deletions",
  threshold: number,
): LineRange[] {
  const additions = side === "additions";
  const shown: LineRange[] = [];
  // Lines of this side before the hunk at hand, as pierre's boundaries count
  // them: a hunk with no lines on a side starts after its `start` line.
  let consumed = 0;
  for (const hunk of fileDiff.hunks) {
    const start = additions ? hunk.additionStart : hunk.deletionStart;
    const count = additions ? hunk.additionCount : hunk.deletionCount;
    const boundary = start - (count === 0 ? 0 : 1);
    if (
      !fileDiff.isPartial &&
      hunk.collapsedBefore > 0 &&
      hunk.collapsedBefore <= threshold
    ) {
      shown.push({ start: boundary - hunk.collapsedBefore + 1, end: boundary });
    }
    if (count > 0) shown.push({ start, end: start + count - 1 });
    consumed = boundary + count;
  }
  if (
    fileDiff.hunks.length > 0 &&
    !fileDiff.isPartial &&
    fileDiff.additionLines.length > 0 &&
    fileDiff.deletionLines.length > 0
  ) {
    const total = additions
      ? fileDiff.additionLines.length
      : fileDiff.deletionLines.length;
    const trailing = total - consumed;
    if (trailing > 0 && trailing <= threshold) {
      shown.push({ start: consumed + 1, end: total });
    }
  }
  return shown;
}

/**
 * The line a range's note hangs under: the last of `start`–`end` that is
 * shown, so a note whose end lies in a collapsed run still shows under what
 * the reader can see of its range. With none of it shown, `end`, where
 * expanding the run brings the note out.
 */
export function hangLine(
  start: number,
  end: number,
  shown: readonly LineRange[],
): number {
  let last: number | null = null;
  for (const range of shown) {
    if (range.end < start || range.start > end) continue;
    const here = Math.min(end, range.end);
    if (last === null || here > last) last = here;
  }
  return last ?? end;
}
