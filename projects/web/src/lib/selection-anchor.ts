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
  orderedEndpoints,
  type SelectionEndpoints,
} from "./selection-endpoints.ts";
import {
  columnsOfOffsets,
  lineColAt,
  type SegmentIndex,
  type SourceSegment,
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
 * What the spec view injects into the rendered document: the annotation UI,
 * and the old text, structure and list numbers of a compared version. None
 * of it is part of the source.
 */
const INJECTED =
  "[data-annotation-ui], .spec-del, .spec-del-block, .spec-del-structure, .spec-list-number";

/** A block's text nodes lined up against the segments it renders. */
type BlockAlignment = {
  /** The block's own segments, in source order. */
  segments: SourceSegment[];
  /** Where each text node starts in those segments' joined text. */
  offsets: Map<Node, number>;
  /** Text nodes the renderer inserted, which take no room there. */
  inserted: Set<Node>;
};

/**
 * Line a block's text nodes up against its own segments, or null when they
 * do not read alike — an attachment card or any other text the source does
 * not hold — since a wrong column is worse than none.
 *
 * Two things in a block are not its own text. A block nested in it — a
 * sublist in a list item, a code block in a compact one — is stamped and
 * mapped by itself: its subtree is skipped, and so are the segments lying
 * wholly on its lines. Two sibling blocks never share a source line, and a
 * container whose first line opens its first child (`- ## Title`) has no
 * text of its own there, so taking out whole lines is exact. And
 * `mdast-util-to-hast` puts whitespace-only text nodes the source does not
 * have between the blocks of a list item and after a `<br>`: one is matched
 * as text first, since a blank between two emphases is the source's, and
 * only when that fails is it taken as inserted. Inserted ones sit on block
 * edges, where the segments never start with a blank — mdast keeps none at
 * the start of a paragraph or after a hard break.
 *
 * The injected nodes `INJECTED` names are skipped as they always were: they
 * would shift every offset after them.
 */
function alignBlock(
  index: SegmentIndex,
  block: { el: Element; loc: { start: number; end: number } },
): BlockAlignment | null {
  const nested = mergedLines(
    [...block.el.querySelectorAll(`[${SOURCE_LINE_ATTR}]`)]
      .filter((el) => el.closest(INJECTED) === null)
      .flatMap((el) => parseSourceLoc(el.getAttribute(SOURCE_LINE_ATTR)) ?? []),
  );
  const segments = segmentsInLines(index, block.loc).filter(
    (segment) =>
      !nested.some(
        (loc) => segment.line >= loc.start && segment.endLine <= loc.end,
      ),
  );
  if (segments.length === 0) return null;
  const texts: Node[] = [];
  const walk = (parent: Node) => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        texts.push(child);
        continue;
      }
      if (
        !(child instanceof Element) ||
        child.matches(INJECTED) ||
        child.hasAttribute(SOURCE_LINE_ATTR)
      ) {
        continue;
      }
      walk(child);
    }
  };
  walk(block.el);
  const joined = segments.map((segment) => segment.text).join("");
  const offsets = new Map<Node, number>();
  const inserted = new Set<Node>();
  let at = 0;
  for (const text of texts) {
    const data = text.nodeValue ?? "";
    offsets.set(text, at);
    if (joined.startsWith(data, at)) at += data.length;
    else if (/\S/.test(data)) return null;
    else inserted.add(text);
  }
  return at === joined.length ? { segments, offsets, inserted } : null;
}

/**
 * Line ranges with the touching and overlapping ones merged: a long sublist
 * is one range rather than one per item, for the filter that runs on every
 * segment of the block.
 */
function mergedLines(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
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
  const aligned = alignBlock(index, block);
  const at = aligned?.offsets.get(node);
  if (aligned === null || at === undefined) return null;
  const rendered = aligned.inserted.has(node) ? at : at + offset;
  const source = sourceOffsetOfRendered(aligned.segments, rendered, edge);
  return edge === "start"
    ? pastPrefix(index, aligned.segments, source)
    : source;
}

/**
 * A start on the newline that ends a line of a quote or a list item begins,
 * on the page, where the next line's text does: the `> ` or the indent in
 * between is the container's, shown nowhere, and no column may name it.
 */
function pastPrefix(
  index: SegmentIndex,
  segments: SourceSegment[],
  at: number | null,
): number | null {
  if (at === null || index.source[at] !== "\n") return at;
  const next = segments.find((segment) => segment.end > at + 1);
  return next !== undefined && next.start > at + 1 ? next.start : at;
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

export function sideOf(
  container: Element,
  node: Node,
  offset: number,
): Side | null {
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

type Point = { node: Node; offset: number };

const CODE_BLOCK = `[${CODE_CONTENT_START_ATTR}]`;

/**
 * Old content no selection can anchor to: what `alignBlock` skips, and
 * the rows, cells and images a compared table puts back (T-221, T-229). Their
 * prose already sits in `.spec-del` runs; an old image put back into a
 * current cell sits in nothing else.
 */
const OLD_OR_INJECTED = `${INJECTED}, .spec-del-row, .spec-del-cell, .spec-del-img`;

/**
 * What a selection takes whole rather than character by character: a code
 * block's wrapper, with whatever pierre or mermaid drew in it, an image, and
 * any other element with a shadow root of its own.
 */
function isBox(el: Element): boolean {
  return (
    el.hasAttribute(CODE_CONTENT_START_ATTR) ||
    el.tagName === "IMG" ||
    el.shadowRoot !== null
  );
}

/** The part of a text node inside `range`, and where in the node it starts. */
function partIn(text: Text, range: Range): { from: number; text: string } {
  const from = text === range.startContainer ? range.startOffset : 0;
  const to = text === range.endContainer ? range.endOffset : text.length;
  return { from, text: text.data.slice(from, to) };
}

/**
 * Whether `range` selects any of a box rather than only touching its edge:
 * an image or a shadow host lies wholly in the range, and a code block
 * shares text or a pierre host with it.
 */
function coversBox(range: Range, box: Element): boolean {
  if (!box.hasAttribute(CODE_CONTENT_START_ATTR)) {
    const parent = box.parentNode;
    if (parent === null) return false;
    const at = Array.prototype.indexOf.call(parent.childNodes, box);
    return (
      range.comparePoint(parent, at) === 0 &&
      range.comparePoint(parent, at + 1) === 0
    );
  }
  const inBox = document.createRange();
  inBox.selectNodeContents(box);
  const from = inBox.comparePoint(range.startContainer, range.startOffset);
  const to = inBox.comparePoint(range.endContainer, range.endOffset);
  if (from > 0 || to < 0) return false;
  if (from === 0) inBox.setStart(range.startContainer, range.startOffset);
  if (to === 0) inBox.setEnd(range.endContainer, range.endOffset);
  return (
    /\S/.test(inBox.toString()) ||
    [...box.querySelectorAll("diffs-container")].some((host) =>
      range.intersectsNode(host),
    )
  );
}

type Content =
  | { kind: "text"; node: Text; from: number; text: string }
  | { kind: "box"; el: Element };

/**
 * `node` as something the selection selects in one of the container's
 * blocks: text other than whitespace, or a box it covers. Null for anything
 * else — markup, old or injected nodes, what a box holds, and what the renderer
 * adds outside the blocks, such as the heading of a footnote list.
 */
function contentAt(
  container: Element,
  range: Range,
  node: Node,
): Content | null {
  const el = elementNear(node);
  if (el === null || el.closest(OLD_OR_INJECTED) !== null) return null;
  const inside = node === el ? el.parentElement : el;
  const box = inside?.closest(CODE_BLOCK) ?? null;
  if (box !== null && container.contains(box)) return null;
  const block = el.closest(`[${SOURCE_LINE_ATTR}]`);
  if (block === null || !container.contains(block)) return null;
  if (node instanceof Text) {
    const part = partIn(node, range);
    return /\S/.test(part.text) ? { kind: "text", node, ...part } : null;
  }
  return node === el && isBox(el) && coversBox(range, el)
    ? { kind: "box", el }
    : null;
}

/**
 * Whether an endpoint selects nothing itself, and may move: it sits in the
 * container's light DOM, outside any code block the selection covers, on an
 * element or on text whose part in the selection is blank. pierre's rows
 * map their own edges, and so does the text of a code block.
 */
function selectsNothing(container: Element, range: Range, at: Point): boolean {
  if (!container.contains(at.node)) return false;
  const box = elementNear(at.node)?.closest(CODE_BLOCK) ?? null;
  if (box !== null && container.contains(box) && coversBox(range, box)) {
    return false;
  }
  return !(at.node instanceof Text) || !/\S/.test(partIn(at.node, range).text);
}

/** Whether a walk looks at what `node` holds. */
function walksInto(node: Node): boolean {
  return (
    !(node instanceof Element) ||
    !(node.matches(OLD_OR_INJECTED) || isBox(node))
  );
}

function lastWithin(node: Node): Node {
  let last = node;
  while (walksInto(last) && last.lastChild !== null) last = last.lastChild;
  return last;
}

/** The node before `node` in document order, within the container. */
function nodeBefore(container: Element, node: Node): Node | null {
  if (node === container) return null;
  if (node.previousSibling !== null) return lastWithin(node.previousSibling);
  const parent = node.parentNode;
  return parent === container ? null : parent;
}

/** The node after `node` in document order, within the container. */
function nodeAfter(container: Element, node: Node, into: boolean): Node | null {
  if (into && walksInto(node) && node.firstChild !== null) {
    return node.firstChild;
  }
  for (let n: Node | null = node; n !== null && n !== container; ) {
    if (n.nextSibling !== null) return n.nextSibling;
    n = n.parentNode;
  }
  return null;
}

/** The last content the selection selects before `at`, its end. */
function contentBefore(
  container: Element,
  range: Range,
  at: Point,
): Content | null {
  let node: Node | null;
  if (at.node instanceof Text) node = nodeBefore(container, at.node);
  else {
    const child = at.node.childNodes[at.offset - 1];
    node = child === undefined ? at.node : lastWithin(child);
  }
  for (; node !== null; node = nodeBefore(container, node)) {
    // Past the start: nothing before it is selected.
    if (!range.intersectsNode(node)) return null;
    const content = contentAt(container, range, node);
    if (content !== null) return content;
  }
  return null;
}

/** The first content the selection selects after `at`, its start. */
function contentAfter(
  container: Element,
  range: Range,
  at: Point,
): Content | null {
  let node: Node | null =
    (at.node instanceof Text ? undefined : at.node.childNodes[at.offset]) ??
    nodeAfter(container, at.node, false);
  for (; node !== null; node = nodeAfter(container, node, true)) {
    if (!range.intersectsNode(node)) return null;
    const content = contentAt(container, range, node);
    if (content !== null) return content;
  }
  return null;
}

/** The point on one side of an element, in its parent. */
function beside(el: Element, side: "before" | "after"): Point {
  const parent = el.parentNode as Node;
  const at = Array.prototype.indexOf.call(parent.childNodes, el);
  return { node: parent, offset: side === "before" ? at : at + 1 };
}

/**
 * Endpoints that select nothing themselves, moved onto the nearest content
 * the selection does select. A triple-click leaves an end on an element
 * boundary rather than in text — Chromium and WebKit at the start of the
 * next block, Firefox around the block's own element — and an element
 * endpoint maps to no column, which would widen the anchor to the whole
 * lines of every block the two ends touch. An endpoint that selects any
 * character itself is never moved, so a drag anchors exactly as it reads.
 *
 * Text takes the endpoint onto its first or last character that is not
 * whitespace; an image or a shadow host, beside it. A code block keeps a
 * text endpoint where it is, at the edge of the prose next to the block,
 * which already maps to columns; an element endpoint goes just inside the
 * block's wrapper, whose own stamp then bounds the anchor.
 */
function endsOnContent(
  container: Element,
  ends: SelectionEndpoints,
): SelectionEndpoints {
  const ordered = orderedEndpoints(ends);
  if (ordered === null) return ends;
  const { range } = ordered;
  const { start, end } = ordered.ends;
  const moveStart = selectsNothing(container, range, start);
  const moveEnd = selectsNothing(container, range, end);
  if (!moveStart && !moveEnd) return ends;
  const first = moveStart ? contentAfter(container, range, start) : null;
  const last = moveEnd ? contentBefore(container, range, end) : null;
  // Nothing but whitespace between the two ends.
  if ((moveStart && first === null) || (moveEnd && last === null)) return ends;
  return {
    start: first === null ? start : startOn(first, start),
    end: last === null ? end : endOn(last, end),
    collapsed: ends.collapsed,
  };
}

function startOn(content: Content, start: Point): Point {
  if (content.kind === "text") {
    return {
      node: content.node,
      offset: content.from + content.text.search(/\S/),
    };
  }
  if (!content.el.hasAttribute(CODE_CONTENT_START_ATTR)) {
    return beside(content.el, "before");
  }
  return start.node instanceof Text ? start : { node: content.el, offset: 0 };
}

function endOn(content: Content, end: Point): Point {
  if (content.kind === "text") {
    return {
      node: content.node,
      offset: content.from + content.text.trimEnd().length,
    };
  }
  if (!content.el.hasAttribute(CODE_CONTENT_START_ATTR)) {
    return beside(content.el, "after");
  }
  return end.node instanceof Text
    ? end
    : { node: content.el, offset: content.el.childNodes.length };
}

/**
 * The anchor a selection points at, or null when it points at nothing in
 * this file. Endpoints outside the container are clamped to its first or
 * last block instead of forfeiting the anchor: a drag that overshoots the
 * end of the prose, or ⌘/Ctrl-A, still means "this file, from here to
 * there". Only a selection lying wholly on one side of the container has
 * nothing to say about it. Endpoints inside it that select nothing are first
 * moved onto what the selection does select (`endsOnContent`).
 *
 * Fed endpoints rather than a Selection so that the decision is a value
 * computation: no DOM events, no React, and tests can hand it a pair of
 * nodes.
 */
export function anchorForSelection(
  container: Element,
  index: SegmentIndex,
  selected: SelectionEndpoints,
): AnchorRange | null {
  // Old semantic blocks and explicit old list numbers have no line in the
  // current source; a line fallback would silently attach to nearby prose.
  if (isOldEndpoint(selected.start.node) || isOldEndpoint(selected.end.node))
    return null;
  const ends = endsOnContent(container, selected);
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
