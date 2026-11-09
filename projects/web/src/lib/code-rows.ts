import { patchLineOfRow } from "./patch-lines.ts";
import {
  DELETION_LINE_TYPE,
  LINE_TYPE_ATTR,
  rowLineText,
} from "./pierre-rows.ts";
import {
  CODE_CONTENT_START_ATTR,
  FENCE_PATCH_ATTR,
  parseSourceLoc,
  SOURCE_LINE_ATTR,
} from "./rehype-source-lines.ts";
import {
  lineTextOf,
  type SegmentIndex,
  type SourceFence,
} from "./spec-source-index.ts";

/** Where one of pierre's rows in the rendered view sits in the markdown. */
export type CodeRowSource = {
  /** The code block's stamped wrapper (`MarkdownPre`), outside the shadow. */
  wrapper: Element;
  /** The wrapper's `data-loc`: the whole block, fence lines included. */
  loc: { start: number; end: number };
  /** The 1-based source line the row shows; null when none can be named. */
  line: number | null;
  /**
   * Source offset of the row text's first character; null when the row text
   * is not what that source line ends with, which leaves the row a line and
   * no columns.
   */
  textStart: number | null;
};

/**
 * The first stamped element above `el`, hopping out of shadow roots host by
 * host: pierre draws a code block inside one, under the stamped wrapper.
 */
function stampedAbove(el: Element): Element | null {
  for (let at: Element | null = el; at !== null; ) {
    const stamped = at.closest(`[${SOURCE_LINE_ATTR}]`);
    if (stamped !== null) return stamped;
    const root = at.getRootNode();
    at = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

/** A code block's body, and how many lines of it a row can show. */
type Fence = SourceFence & { lines: number };

/** Each index's code blocks by the line they open on; every row asks. */
const FENCES = new WeakMap<SegmentIndex, Map<number, Fence>>();

/** The code block that opens on source line `line`. */
function fenceAt(index: SegmentIndex, line: number): Fence | null {
  let byLine = FENCES.get(index);
  if (byLine === undefined) {
    byLine = new Map();
    for (const fence of index.fences.values()) {
      byLine.set(fence.line, {
        ...fence,
        // An empty body is "" and so is one blank line; `codeRowSource` tells
        // them apart by the lines the block spans.
        lines: fence.value === "" ? 0 : fence.value.split("\n").length,
      });
    }
    FENCES.set(index, byLine);
  }
  return byLine.get(line) ?? null;
}

/**
 * A fence's closing marker, behind any container indent or `>`. The backtick
 * is spelled `\x60` so that no scan of this file reads it as a template.
 */
const CLOSING_FENCE = /^[ \t>]*(\x60{3,}|~{3,})[ \t]*$/;

/** Whether source line `line` is a fence's closing marker. */
function closesFence(index: SegmentIndex, line: number): boolean {
  const start = index.lineStarts[line - 1];
  if (start === undefined) return false;
  const next = index.lineStarts[line];
  const text = index.source.slice(
    start,
    next === undefined ? index.source.length : next - 1,
  );
  return CLOSING_FENCE.test(text);
}

/** The 0-based line of the code block's body a row shows, or null. */
function bodyLineOf(
  index: SegmentIndex | null,
  wrapper: Element,
  loc: { start: number },
  row: Element,
): number | null {
  if (wrapper.hasAttribute(FENCE_PATCH_ATTR)) {
    // The patch viewer numbers rows by the patched files, so only the fence
    // body itself can say which of its lines a row is.
    const fence = index === null ? null : fenceAt(index, loc.start);
    return fence === null ? null : patchLineOfRow(fence.value, row);
  }
  // A deletion row numbers itself on the old side, so the current source
  // has no line for it and the formula below would name an unrelated one —
  // silently, and plausibly (T-343). The other three line types pierre emits,
  // `context-expanded` included, all number the new side.
  if (row.getAttribute(LINE_TYPE_ATTR) === DELETION_LINE_TYPE) return null;
  const number = Number(row.getAttribute("data-line"));
  return Number.isInteger(number) && number >= 1 ? number - 1 : null;
}

/**
 * Where a pierre row of the rendered view lives in the markdown source, or
 * null when it is not in a code block's wrapper. One answer for the three
 * things that ask it — a selection's line, its columns, and a highlight's
 * characters — so that what is selected and what is painted cannot drift.
 *
 * The row's source line is the content start plus its body line. Its text
 * then has to be what that line ends with, and the length left over in front
 * is the prefix the row does not show: a list item's indent, a quote's `> `,
 * the fence's own indent, a patch line's `+`, `-` or space. Any other
 * mismatch — micromark expanding a tab in a container's indent, say — leaves
 * the row its line and no columns. A row past the block's stamped end gives
 * no line at all rather than being clamped onto the last one, which is a
 * different line.
 *
 * Without an index a plain block's rows still have their lines, since only
 * the content start is needed for those; columns, and a patch fence's rows,
 * need the source.
 */
export function codeRowSource(
  index: SegmentIndex | null,
  row: Element,
): CodeRowSource | null {
  const wrapper = stampedAbove(row);
  if (wrapper === null || !wrapper.hasAttribute(CODE_CONTENT_START_ATTR)) {
    return null;
  }
  const loc = parseSourceLoc(wrapper.getAttribute(SOURCE_LINE_ATTR));
  if (loc === null) return null;
  const contentStart = Number(wrapper.getAttribute(CODE_CONTENT_START_ATTR));
  const bodyLine = Number.isInteger(contentStart)
    ? bodyLineOf(index, wrapper, loc, row)
    : null;
  // The body bounds the row too, where the source is at hand: an empty
  // fence's one empty row would otherwise land on its closing marker. A body
  // of one blank line reads "" as well, and is told apart by the lines the
  // block spans between its content start and its closing marker, when it
  // has one: an unclosed fence runs to its container's end without one.
  const fence = index === null ? null : fenceAt(index, loc.start);
  const bodyLines =
    fence === null || index === null
      ? Number.POSITIVE_INFINITY
      : fence.value === ""
        ? Math.max(
            0,
            Math.min(
              1,
              loc.end - contentStart + (closesFence(index, loc.end) ? 0 : 1),
            ),
          )
        : fence.lines;
  const candidate =
    bodyLine === null || bodyLine >= bodyLines ? null : contentStart + bodyLine;
  const line =
    candidate !== null && candidate >= loc.start && candidate <= loc.end
      ? candidate
      : null;
  if (line === null || index === null) {
    return { wrapper, loc, line, textStart: null };
  }
  const start = index.lineStarts[line - 1];
  if (start === undefined) return { wrapper, loc, line, textStart: null };
  const sourceLine = lineTextOf(index.source, index.lineStarts, line);
  const text = rowLineText(row);
  return {
    wrapper,
    loc,
    line,
    textStart: sourceLine.endsWith(text)
      ? start + sourceLine.length - text.length
      : null,
  };
}
