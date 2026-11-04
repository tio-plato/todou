import type { AnchorRange } from "@/components/spec/selection-entry.tsx";
import { codeRowSource } from "./code-rows.ts";
import {
  DELETION_LINE_TYPE,
  LINE_TYPE_ATTR,
  offsetInRow,
  rowAt,
} from "./pierre-rows.ts";
import {
  CODE_CONTENT_START_ATTR,
  parseSourceLoc,
  SOURCE_LINE_ATTR,
} from "./rehype-source-lines.ts";
import {
  composedContains,
  elementNear,
  type SelectionEndpoints,
} from "./selection-endpoints.ts";
import {
  columnsOfOffsets,
  lineColAt,
  type SegmentIndex,
  segmentsInLines,
  sourceOffsetOfRendered,
} from "./spec-source-index.ts";

/*
 * A reader's selection in rendered markdown, mapped back to the source lines
 * and columns it covers. Kept apart from the spec view's components so that a
 * page outside it can anchor a selection without pulling them in.
 */

/** Restored old structure and explicit old list numbers have no current source. */
function isOldEndpoint(node: Node): boolean {
  let el = elementNear(node);
  while (el !== null) {
    if (el.closest(".spec-del-structure, .spec-list-number") !== null) {
      return true;
    }
    const root = el.getRootNode();
    el = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

/**
 * The prose block a selection endpoint sits in, when the segment mapping can
 * carry it to columns. Code blocks are not among them: their text reaches the
 * DOM through pierre's own renderer (T-31/T-52), one row per line in a shadow
 * root, and `codeRowSource` maps those rows instead. What is left of a code
 * block outside its rows — the plain text shown before highlighting, a
 * mermaid picture — maps to nothing and keeps the line anchor.
 */
function columnBlockOf(
  node: Node,
): { el: Element; loc: { start: number; end: number } } | null {
  const stamped = elementNear(node)?.closest(`[${SOURCE_LINE_ATTR}]`) ?? null;
  if (stamped === null) return null;
  if (stamped.hasAttribute(CODE_CONTENT_START_ATTR)) return null;
  const loc = parseSourceLoc(stamped.getAttribute(SOURCE_LINE_ATTR));
  return loc === null ? null : { el: stamped, loc };
}

/**
 * Text nodes of a block as the *document* has them — the annotation UI and
 * the `<del>` runs this component injects are not part of the source and
 * would shift every offset after them.
 */
function sourceTextWalker(block: Element): TreeWalker {
  return document.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        if (node.nodeType !== Node.ELEMENT_NODE)
          return NodeFilter.FILTER_ACCEPT;
        const el = node as Element;
        return el.hasAttribute("data-annotation-ui") ||
          el.classList.contains("spec-del") ||
          el.classList.contains("spec-del-block") ||
          el.classList.contains("spec-del-structure") ||
          el.classList.contains("spec-list-number")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );
}

function renderedTextOf(block: Element): string {
  const walker = sourceTextWalker(block);
  let text = "";
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    text += n.nodeValue ?? "";
  }
  return text;
}

/** Offset of a text-node position within the block's rendered text. */
function renderedOffsetIn(
  block: Element,
  node: Node,
  offset: number,
): number | null {
  const walker = sourceTextWalker(block);
  let seen = 0;
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (n === node) return seen + offset;
    seen += n.nodeValue?.length ?? 0;
  }
  return null;
}

/** Source offset one selection endpoint maps to, or null to give up. */
function sourceOffsetOfEndpoint(
  index: SegmentIndex,
  node: Node,
  offset: number,
  edge: "start" | "end",
): number | null {
  if (isOldEndpoint(node) || node.nodeType !== Node.TEXT_NODE) return null;
  const block = columnBlockOf(node);
  if (block === null) return null;
  const segments = segmentsInLines(index, block.loc);
  if (segments.length === 0) return null;
  // The mapping assumes the block renders its source prose and nothing
  // else. An attachment card or any other injected text breaks that, and
  // a wrong column is worse than none — bail out to the line anchor.
  if (renderedTextOf(block.el) !== segments.map((s) => s.text).join("")) {
    return null;
  }
  const rendered = renderedOffsetIn(block.el, node, offset);
  if (rendered === null) return null;
  return sourceOffsetOfRendered(segments, rendered, edge);
}

/**
 * Source offset one endpoint maps to, wherever it is: a code row's text maps
 * by where `codeRowSource` puts the row, prose through the segment index.
 * `edge` only matters to prose, for which segment a boundary between two
 * belongs to.
 */
function endpointOffset(
  index: SegmentIndex,
  node: Node,
  offset: number,
  edge: "start" | "end",
): number | null {
  const row = rowAt(node);
  if (row === null) return sourceOffsetOfEndpoint(index, node, offset, edge);
  const source = codeRowSource(index, row);
  if (source === null || source.textStart === null) return null;
  const at = offsetInRow(row, node, offset);
  return at === null ? null : source.textStart + at;
}

/**
 * Source offsets of code the reader cannot have selected. In a block pierre
 * has drawn rows for, that is every line no row shows — the fence markers, a
 * patch's headers — and, on a line a row does show, the part in front of the
 * row's text: a list item's indent, a quote's `> `, a patch line's prefix. A
 * selection that stops at the edge of a row reaches into them only in the
 * source. A block with no rows yet hides nothing: its plain text is what is
 * on screen; nor does a block with a row that could not be placed hide any
 * line whole, since that row shows one of them. Worked out per block on
 * first ask, since only the blocks next to a selection's two ends are ever
 * asked about.
 */
function hiddenInCode(
  container: Element,
  index: SegmentIndex,
): (offset: number) => boolean {
  let blocks: Array<{
    el: Element;
    loc: { start: number; end: number };
  }> | null = null;
  const hidden = new Map<Element, Map<number, [number, number]> | null>();
  const hiddenOf = (el: Element, loc: { start: number; end: number }) => {
    if (hidden.has(el)) return hidden.get(el) ?? null;
    // Each drawn line, with where its row's text starts; null where the
    // row does not read as its line, which hides nothing of it.
    const drawn = new Map<number, number | null>();
    let unplaced = false;
    for (const host of el.querySelectorAll("diffs-container")) {
      for (const row of host.shadowRoot?.querySelectorAll("[data-line]") ??
        []) {
        const source = codeRowSource(index, row);
        if (source?.line != null) drawn.set(source.line, source.textStart);
        // A deletion in a compared fence has no current line to show.
        else if (row.getAttribute(LINE_TYPE_ATTR) !== DELETION_LINE_TYPE) {
          unplaced = true;
        }
      }
    }
    let spans: Map<number, [number, number]> | null = null;
    if (drawn.size > 0) {
      spans = new Map();
      for (let line = loc.start; line <= loc.end; line++) {
        const start = index.lineStarts[line - 1];
        if (start === undefined) continue;
        const next = index.lineStarts[line];
        const end = next === undefined ? index.source.length : next - 1;
        const textStart = drawn.has(line)
          ? drawn.get(line)
          : unplaced
            ? null
            : end;
        if (textStart != null && textStart > start) {
          spans.set(line, [start, textStart]);
        }
      }
    }
    hidden.set(el, spans);
    return spans;
  };
  return (offset) => {
    blocks ??= [
      ...container.querySelectorAll(`[${CODE_CONTENT_START_ATTR}]`),
    ].flatMap((el) => {
      const loc = parseSourceLoc(el.getAttribute(SOURCE_LINE_ATTR));
      return loc === null ? [] : [{ el, loc }];
    });
    const { line } = lineColAt(index, offset);
    return blocks.some(({ el, loc }) => {
      if (line < loc.start || line > loc.end) return false;
      const span = hiddenOf(el, loc)?.get(line);
      return span !== undefined && offset >= span[0] && offset < span[1];
    });
  };
}

/**
 * Narrow a selection to source columns (T-142). Returns null whenever the
 * mapping is not provably right, and the caller keeps the whole-block line
 * anchor that spec review has always produced.
 *
 * Each endpoint maps on its own and the source offsets order them, so the two
 * need not share a tree: a drag from prose into a code line has one end on
 * either side of pierre's shadow root, where no DOM range can span them. A
 * backwards selection is mapped again once its order is known, so that each
 * end is read under its own edge.
 */
function columnsOfEndpoints(
  container: Element,
  index: SegmentIndex,
  ends: SelectionEndpoints,
): AnchorRange | null {
  const { start: a, end: b } = ends;
  let start = endpointOffset(index, a.node, a.offset, "start");
  let end = endpointOffset(index, b.node, b.offset, "end");
  if (start === null || end === null) return null;
  if (start > end) {
    start = endpointOffset(index, b.node, b.offset, "start");
    end = endpointOffset(index, a.node, a.offset, "end");
    if (start === null || end === null) return null;
  }
  return columnsOfOffsets(index, start, end, hiddenInCode(container, index));
}

/**
 * Source-line range for the block a selection endpoint sits in (T-52).
 * pierre renders code blocks inside an open shadow root, so the walk hops
 * shadow boundaries host by host until a stamped ancestor appears. When
 * the endpoint is on one of pierre's line rows, the whole-block range
 * narrows down to the source line `codeRowSource` names for it, and stays
 * the whole block when it names none.
 *
 * `index` is what a patch fence's rows are matched against; without it they
 * keep the whole block, while a plain block's rows still narrow.
 */
export function anchorRangeForNode(
  node: Node,
  index: SegmentIndex | null = null,
): { start: number; end: number } | null {
  if (isOldEndpoint(node)) return null;
  for (let el = elementNear(node); el !== null; ) {
    const row = el.closest("[data-line]");
    const source = row === null ? null : codeRowSource(index, row);
    if (source !== null) {
      return source.line === null
        ? source.loc
        : { start: source.line, end: source.line };
    }
    const stamped = el.closest(`[${SOURCE_LINE_ATTR}]`);
    if (stamped !== null) {
      return parseSourceLoc(stamped.getAttribute(SOURCE_LINE_ATTR));
    }
    const root = el.getRootNode();
    el = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

/** Where an endpoint falls relative to the rendered file. */
type Side = "inside" | "before" | "after";

function sideOf(container: Element, node: Node, offset: number): Side | null {
  // Containment is settled first: a node inside pierre's shadow root has no
  // position relative to the container at all, and comparing it would answer
  // about the host's siblings instead (T-164).
  if (composedContains(container, node)) return "inside";
  const span = document.createRange();
  span.selectNode(container);
  try {
    const where = span.comparePoint(node, offset);
    return where < 0 ? "before" : where > 0 ? "after" : "inside";
  } catch {
    return null;
  }
}

/** The block one endpoint anchors to, clamped to the container's edges. */
function blockOfEndpoint(
  index: SegmentIndex,
  node: Node,
  side: Side,
  blocks: Element[],
): { start: number; end: number } | null {
  if (side === "inside") return anchorRangeForNode(node, index);
  const edge = side === "before" ? blocks[0] : blocks[blocks.length - 1];
  return edge === undefined
    ? null
    : parseSourceLoc(edge.getAttribute(SOURCE_LINE_ATTR));
}

/**
 * The anchor a selection points at, or null when it points at nothing in
 * this file. Endpoints outside the container are clamped to its first or
 * last block instead of forfeiting the anchor: a drag that overshoots the
 * end of the prose, or ⌘/Ctrl-A, still means "this file, from here to
 * there". Only a selection lying wholly on one side of the container has
 * nothing to say about it.
 *
 * Fed endpoints rather than a Selection so that the decision is a value
 * computation: no DOM events, no React, and tests can hand it a pair of
 * nodes.
 */
export function anchorForSelection(
  container: Element,
  index: SegmentIndex,
  ends: SelectionEndpoints,
): AnchorRange | null {
  // Old semantic blocks and explicit old list numbers have no line in the
  // current source; a line fallback would silently attach to nearby prose.
  if (isOldEndpoint(ends.start.node) || isOldEndpoint(ends.end.node))
    return null;
  const startSide = sideOf(container, ends.start.node, ends.start.offset);
  const endSide = sideOf(container, ends.end.node, ends.end.offset);
  if (startSide === null || endSide === null) return null;
  if (startSide === endSide && startSide !== "inside") return null;
  const blocks = [...container.querySelectorAll(`[${SOURCE_LINE_ATTR}]`)];
  const from = blockOfEndpoint(index, ends.start.node, startSide, blocks);
  const to = blockOfEndpoint(index, ends.end.node, endSide, blocks);
  if (from === null || to === null) return null;
  // A clamped endpoint names a block, not a character in it, so columns are
  // only ever narrowed while both ends are in the rendered file.
  const columns =
    startSide === "inside" && endSide === "inside"
      ? columnsOfEndpoints(container, index, ends)
      : null;
  // Direction doesn't matter to the lines; the min/max absorbs it.
  return (
    columns ?? {
      lineStart: Math.min(from.start, to.start),
      lineEnd: Math.max(from.end, to.end),
      colStart: null,
      colEnd: null,
    }
  );
}
