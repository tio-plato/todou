import type { AnchorRange } from "@/components/spec/selection-entry.tsx";
import { oldCodeRowSource } from "./code-rows.ts";
import {
  DELETION_LINE_TYPE,
  LINE_TYPE_ATTR,
  offsetInRow,
  rowAt,
} from "./pierre-rows.ts";
import {
  OLD_FLAT_ATTR,
  OLD_LINE_ATTR,
  OLD_SOURCE_ATTR,
  parseSourceLoc,
} from "./rehype-source-lines.ts";
import {
  anchorForSelection,
  beside,
  DELETED_CONTENT,
  endsOnContent,
  sourceOffsetInBlock,
} from "./selection-anchor.ts";
import {
  composedContains,
  elementNear,
  orderedEndpoints,
  type SelectionEndpoints,
} from "./selection-endpoints.ts";
import {
  columnsOfOffsets,
  lineColAt,
  type SegmentIndex,
  type SourceFence,
  sourceOffsetOfText,
} from "./spec-source-index.ts";

/*
 * A selection in a rendered comparison, which shows the version being viewed
 * with what its baseline had and it no longer does put back in place. A
 * selection inside that removed content anchors to the baseline, where it
 * still is; anything else anchors to the version shown.
 */

/**
 * An anchor in a comparison: on its baseline where `baseline` says so, and
 * on the version shown otherwise, exactly as `anchorForSelection` gives one.
 */
export type CompareAnchor = AnchorRange & { baseline?: true };

type Point = { node: Node; offset: number };

/** Lines in the baseline an end lands on, and its offset where it has one. */
type OldEnd = {
  offset: number | null;
  lines: { start: number; end: number } | null;
};

const NOWHERE: OldEnd = { offset: null, lines: null };

/** `node`'s element and each one around it, hopping out of shadow roots. */
function* around(node: Node): Generator<Element> {
  for (let el = elementNear(node); el !== null; ) {
    yield el;
    if (el.parentElement !== null) {
      el = el.parentElement;
      continue;
    }
    const root = el.getRootNode();
    el = root instanceof ShadowRoot ? root.host : null;
  }
}

/**
 * The removed content an end sits in, at its outermost: what the comparison
 * put back of the baseline (`DELETED_CONTENT`), or a deletion row of a code
 * block edited in place, which pierre draws among the block's current rows.
 * Null for an end in the version shown, or outside the container.
 */
function deletedAround(
  container: Element,
  baseline: SegmentIndex,
  fences: ReadonlyMap<number, SourceFence>,
  point: Point,
): Element | null {
  if (!composedContains(container, point.node)) return null;
  let outermost: Element | null = null;
  for (const el of around(point.node)) {
    if (el.matches(DELETED_CONTENT)) outermost = el;
  }
  if (outermost !== null) return outermost;
  const row = rowAt(point.node);
  return row !== null && oldCodeRowSource(baseline, fences, row) !== null
    ? row
    : null;
}

/**
 * An end moved out of the removed content it sits in, onto the side the
 * rest of the selection lies on: a start to just after it, an end to just
 * before it. A deletion row lives in pierre's shadow root among the rows of
 * the version shown, and the end moves onto the nearest of those on that
 * side, or out past the block when there is none.
 */
function outOf(deleted: Element, side: "before" | "after"): Point {
  const root = deleted.getRootNode();
  if (!(root instanceof ShadowRoot)) return beside(deleted, side);
  const rows = [...root.querySelectorAll("[data-line]")];
  const at = rows.indexOf(deleted);
  const kept = (row: Element) =>
    row.getAttribute(LINE_TYPE_ATTR) !== DELETION_LINE_TYPE;
  const next =
    side === "after"
      ? rows.slice(at + 1).find(kept)
      : rows.slice(0, at).findLast(kept);
  if (next !== undefined) {
    return side === "after"
      ? { node: next, offset: 0 }
      : { node: next, offset: next.childNodes.length };
  }
  let host = root.host;
  for (
    let outer = host.getRootNode();
    outer instanceof ShadowRoot;
    outer = host.getRootNode()
  ) {
    host = outer.host;
  }
  return beside(host, side);
}

/** How much of `el`'s text lies before `point`, which is inside it. */
function textBefore(el: Element, point: Point): number {
  const range = (el.ownerDocument ?? document).createRange();
  range.setStart(el, 0);
  range.setEnd(point.node, point.offset);
  return range.toString().length;
}

/** The line `offset` is on, an end's offset naming the character before it. */
function lineOfOffset(
  baseline: SegmentIndex,
  offset: number,
  edge: "start" | "end",
): { start: number; end: number } {
  const { line } = lineColAt(
    baseline,
    edge === "end" ? Math.max(0, offset - 1) : offset,
  );
  return { start: line, end: line };
}

/**
 * Where an end in removed content lands in the baseline. A code row is
 * placed by `oldCodeRowSource`; a run of removed text by where it says it
 * starts (`OLD_FLAT_ATTR`, `OLD_SOURCE_ATTR`) and how far into it the end
 * is; a block put back whole by its baseline lines, and within them by the
 * mapping a block of the version shown is read by (`sourceOffsetInBlock`).
 * `edge` reads a boundary between two runs of the baseline's text as the
 * selection mapping always does.
 */
function oldEnd(
  baseline: SegmentIndex,
  fences: ReadonlyMap<number, SourceFence>,
  point: Point,
  edge: "start" | "end",
): OldEnd {
  const row = rowAt(point.node);
  if (row !== null) {
    const source = oldCodeRowSource(baseline, fences, row);
    if (source === null || source.line === null) return NOWHERE;
    const at = offsetInRow(row, point.node, point.offset);
    return {
      offset:
        source.textStart === null || at === null ? null : source.textStart + at,
      lines: { start: source.line, end: source.line },
    };
  }
  const el =
    elementNear(point.node)?.closest(
      `[${OLD_FLAT_ATTR}], [${OLD_SOURCE_ATTR}], [${OLD_LINE_ATTR}]`,
    ) ?? null;
  if (el === null) return NOWHERE;
  if (el.hasAttribute(OLD_LINE_ATTR)) {
    const loc = parseSourceLoc(el.getAttribute(OLD_LINE_ATTR));
    if (loc === null) return NOWHERE;
    const block = { el, loc, stamp: OLD_LINE_ATTR };
    return {
      offset: sourceOffsetInBlock(
        baseline,
        block,
        point.node,
        point.offset,
        edge,
      ),
      lines: loc,
    };
  }
  const before = textBefore(el, point);
  const offset = el.hasAttribute(OLD_FLAT_ATTR)
    ? sourceOffsetOfText(
        baseline,
        Number(el.getAttribute(OLD_FLAT_ATTR)) + before,
        edge,
      )
    : Number(el.getAttribute(OLD_SOURCE_ATTR)) + before;
  return offset === null
    ? NOWHERE
    : { offset, lines: lineOfOffset(baseline, offset, edge) };
}

/**
 * A selection both of whose ends are in removed content, anchored to the
 * baseline: to the columns between the two ends, or to their lines where
 * either end has no offset or the columns name nothing. A backwards pair is
 * read again once its order is known, so that each end is read under its
 * own edge, as `columnsOfEndpoints` does.
 */
function baselineAnchor(
  baseline: SegmentIndex,
  fences: ReadonlyMap<number, SourceFence>,
  ends: SelectionEndpoints,
): CompareAnchor | null {
  let start = oldEnd(baseline, fences, ends.start, "start");
  let end = oldEnd(baseline, fences, ends.end, "end");
  if (
    start.offset !== null &&
    end.offset !== null &&
    start.offset > end.offset
  ) {
    start = oldEnd(baseline, fences, ends.end, "start");
    end = oldEnd(baseline, fences, ends.start, "end");
  }
  const columns =
    start.offset === null || end.offset === null
      ? null
      : columnsOfOffsets(baseline, start.offset, end.offset);
  if (columns !== null) return { ...columns, baseline: true };
  if (start.lines === null || end.lines === null) return null;
  return {
    lineStart: Math.min(start.lines.start, end.lines.start),
    lineEnd: Math.max(start.lines.end, end.lines.end),
    colStart: null,
    colEnd: null,
    baseline: true,
  };
}

/**
 * The anchor a selection in a rendered comparison points at, or null when
 * it points at nothing. `index` is the version shown, `baseline` the one it
 * is compared with, and `fences` `pairedFences`' answer for the two.
 *
 * Ends that select nothing are first moved onto what the selection selects,
 * removed text included (`endsOnContent`). Then:
 *
 * - both ends in removed content: the baseline, between the two;
 * - one end in removed content: that end moves out of it to the nearest
 *   text of the version shown inside the selection, and the selection
 *   anchors to the version shown;
 * - neither: the version shown, as `anchorForSelection` anchors any other
 *   selection.
 */
export function compareAnchorForSelection(
  container: Element,
  index: SegmentIndex,
  baseline: SegmentIndex,
  fences: ReadonlyMap<number, SourceFence>,
  selected: SelectionEndpoints,
): CompareAnchor | null {
  const moved = endsOnContent(container, selected, { old: true });
  const ends = orderedEndpoints(moved)?.ends ?? moved;
  const startIn = deletedAround(container, baseline, fences, ends.start);
  const endIn = deletedAround(container, baseline, fences, ends.end);
  if (startIn !== null && endIn !== null) {
    return baselineAnchor(baseline, fences, ends);
  }
  return anchorForSelection(container, index, {
    start: startIn === null ? ends.start : outOf(startIn, "after"),
    end: endIn === null ? ends.end : outOf(endIn, "before"),
    collapsed: ends.collapsed,
  });
}
