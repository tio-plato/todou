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
  OLD_LINE_ATTR,
  parseSourceLoc,
  SOURCE_LINE_ATTR,
  SOURCE_SPAN_ATTR,
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
 * A block a selection endpoint can map to columns in, with the attribute its
 * source lines are stamped in: `SOURCE_LINE_ATTR` for a block of the
 * document being shown, `OLD_LINE_ATTR` for one a comparison put back from
 * its baseline, whose lines are the baseline's.
 */
export type ColumnBlock = {
  el: Element;
  loc: { start: number; end: number };
  stamp: string;
};

/**
 * The prose block a selection endpoint sits in, when the segment mapping can
 * carry it to columns. Code blocks are not among them: their text reaches the
 * DOM through pierre's own renderer (T-31/T-52), one row per line in a shadow
 * root, and `codeRowSource` maps those rows instead. What is left of a code
 * block outside its rows — the plain text shown before highlighting, a
 * mermaid picture — maps to nothing and keeps the line anchor.
 */
function columnBlockOf(node: Node): ColumnBlock | null {
  const stamped = elementNear(node)?.closest(`[${SOURCE_LINE_ATTR}]`) ?? null;
  if (stamped === null) return null;
  if (stamped.hasAttribute(CODE_CONTENT_START_ATTR)) return null;
  const loc = parseSourceLoc(stamped.getAttribute(SOURCE_LINE_ATTR));
  return loc === null ? null : { el: stamped, loc, stamp: SOURCE_LINE_ATTR };
}

/** Old text and old structure a compared version puts back. */
const OLD_TEXT = ".spec-del, .spec-del-block, .spec-del-structure";

/** The rows, cells and images a compared table puts back (T-221, T-229). */
const OLD_TABLE_PARTS = ".spec-del-row, .spec-del-cell, .spec-del-img";

/**
 * Everything a compared version puts back of its baseline: what a selection
 * in a comparison can anchor to the baseline from.
 */
export const DELETED_CONTENT = `${OLD_TEXT}, ${OLD_TABLE_PARTS}`;

/**
 * The link `mdast-util-to-hast` ends a footnote definition with, back to
 * where the footnote is referenced: its `↩` stands for nothing in the source.
 */
const FOOTNOTE_BACKREF = "a[data-footnote-backref]";

/**
 * What the spec view injects into the rendered document: the annotation UI,
 * and the old text, structure and list numbers of a compared version; and
 * what the renderer adds, a footnote definition's link back. None of it is
 * part of the source.
 */
const INJECTED = `[data-annotation-ui], ${OLD_TEXT}, .spec-list-number, ${FOOTNOTE_BACKREF}`;

/** A link or a document card a selection takes whole (`alignBlock`). */
type Atom = { el: Element; start: number; end: number };

/** A block's text nodes lined up against the segments it renders. */
type BlockAlignment = {
  /** The block's own segments, in source order, an atom standing in one. */
  segments: SourceSegment[];
  /** Where each text node starts in those segments' joined text. */
  offsets: Map<Node, number>;
  /** Text nodes the renderer inserted, which take no room there. */
  inserted: Set<Node>;
  atoms: Atom[];
};

/** What an atom stands for in the joined text: one character. */
const ATOM_TEXT = "\uFFFC";

/**
 * Segments with atoms in, and which of them are the atoms' placeholders: a
 * placeholder is told by identity, never by its text, which a source can
 * hold too.
 */
type WithAtoms = {
  segments: SourceSegment[];
  placeholders: Set<SourceSegment>;
};

/** The text of `el`'s subtree, injected nodes left out. */
function textUnder(el: Element): string {
  let text = "";
  const walk = (parent: Node) => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue ?? "";
      else if (child instanceof Element && !child.matches(INJECTED)) {
        walk(child);
      }
    }
  };
  walk(el);
  return text;
}

/**
 * The text `segments` hold within the source span `[start, end)`, exact ones
 * cut at its edges; null when an indivisible one crosses an edge.
 */
function textInSpan(
  segments: SourceSegment[],
  start: number,
  end: number,
): string | null {
  let text = "";
  for (const segment of segments) {
    if (segment.end <= start || segment.start >= end) continue;
    if (segment.start >= start && segment.end <= end) {
      text += segment.text;
      continue;
    }
    if (!segment.exact) return null;
    text += segment.text.slice(
      Math.max(start, segment.start) - segment.start,
      Math.min(end, segment.end) - segment.start,
    );
  }
  return text;
}

/**
 * `segments` with each atom's span cut out and one `ATOM_TEXT` character in
 * its place; null when an indivisible segment crosses an atom's edge.
 */
function withAtoms(
  index: SegmentIndex,
  segments: SourceSegment[],
  atoms: Atom[],
): WithAtoms | null {
  const placeholders = new Set<SourceSegment>();
  let out = segments;
  for (const atom of atoms) {
    const next: SourceSegment[] = [];
    for (const segment of out) {
      if (segment.end <= atom.start || segment.start >= atom.end) {
        next.push(segment);
        continue;
      }
      if (segment.start >= atom.start && segment.end <= atom.end) continue;
      if (!segment.exact) return null;
      if (segment.start < atom.start) {
        const length = atom.start - segment.start;
        next.push({
          ...segment,
          text: segment.text.slice(0, length),
          end: atom.start,
        });
      }
      if (segment.end > atom.end) {
        const skip = atom.end - segment.start;
        next.push({
          ...segment,
          text: segment.text.slice(skip),
          at: segment.at + skip,
          start: atom.end,
        });
      }
    }
    // Not in the flattened text, so no `at` and no group of its own.
    const placeholder: SourceSegment = {
      text: ATOM_TEXT,
      at: -1,
      start: atom.start,
      end: atom.end,
      line: lineColAt(index, atom.start).line,
      endLine: lineColAt(index, atom.end - 1).line,
      exact: false,
      group: -1,
    };
    placeholders.add(placeholder);
    next.push(placeholder);
    out = next;
  }
  return { segments: out.sort((a, b) => a.start - b.start), placeholders };
}

/**
 * Line a block's text nodes up against its own segments, or null when they
 * do not read alike — text the source does not hold — since a wrong column
 * is worse than none.
 *
 * Two things in a block are not its own text. A block nested in it — a
 * sublist in a list item, a code block in a compact one — is stamped and
 * mapped by itself: its subtree is skipped, and so are the segments lying
 * wholly on its lines. Nested blocks are told by the block's own stamp, so
 * that a block restored from the baseline finds its nested ones as well.
 * Two sibling blocks never share a source line, and a container whose first
 * line opens its first child (`- ## Title`) has no text of its own there, so
 * taking out whole lines is exact. And
 * `mdast-util-to-hast` puts whitespace-only text nodes the source does not
 * have between the blocks of a list item and after a `<br>`: one is matched
 * as text first, since a blank between two emphases is the source's, and
 * only when that fails is it taken as inserted. Inserted ones sit on block
 * edges, where the segments never start with a blank — mdast keeps none at
 * the start of a paragraph or after a hard break.
 *
 * A link or a document card carries its source span (`SOURCE_SPAN_ATTR`).
 * One whose text reads like the source in its span — a plain link, an
 * attachment link's file name, an autolink cut out of a longer text — is
 * walked like any other element. One that does not — a chip showing a title
 * where the source says `#12`, a document card, a footnote reference — is an
 * atom: it stands in the segments as one character in place of its span,
 * and a selection reaching into it takes its whole span.
 *
 * Inline HTML is shown as its own source text (`SegmentIndex.literals`), so
 * it lines up like any other exact segment.
 *
 * The injected nodes `INJECTED` names are skipped as they always were: they
 * would shift every offset after them.
 */
function alignBlock(
  index: SegmentIndex,
  block: ColumnBlock,
): BlockAlignment | null {
  const nested = mergedLines(
    [...block.el.querySelectorAll(`[${block.stamp}]`)]
      // Injected content inside the block is not its own; a restored block
      // is itself inside the old structure it was put back as.
      .filter((el) => el.closest(INJECTED)?.contains(block.el) ?? true)
      .flatMap((el) => parseSourceLoc(el.getAttribute(block.stamp)) ?? []),
  );
  // Inline HTML shows as its own source text, so it is the block's text
  // here, though never part of the flattened prose.
  const literals = index.literals.filter(
    (literal) =>
      literal.line <= block.loc.end && literal.endLine >= block.loc.start,
  );
  const own = [...segmentsInLines(index, block.loc), ...literals]
    .filter(
      (segment) =>
        !nested.some(
          (loc) => segment.line >= loc.start && segment.endLine <= loc.end,
        ),
    )
    .sort((a, b) => a.start - b.start);
  // A block whose text nodes all line up with every element walked into is
  // mapped character by character, which no atom can improve on, so atoms
  // are only looked for when that fails. Trying them first would also trust
  // a span that is not its element's own: `remarkIssueRefs` cuts a project
  // autolink out of a text node, and when that node's pieces cannot be found
  // every piece gets the whole node's position.
  return (
    lineUp(index, own, itemsOf(block, own, false)) ??
    lineUp(index, own, itemsOf(block, own, true))
  );
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

/**
 * A block's text nodes and atoms, in document order. With `takeAtoms` off,
 * every element is walked into, whatever its text.
 */
function itemsOf(
  { el, stamp }: ColumnBlock,
  own: SourceSegment[],
  takeAtoms: boolean,
): { items: Node[]; atoms: Atom[] } {
  const items: Node[] = [];
  const atoms: Atom[] = [];
  const walk = (parent: Node) => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        items.push(child);
        continue;
      }
      if (
        !(child instanceof Element) ||
        child.matches(INJECTED) ||
        child.hasAttribute(stamp)
      ) {
        continue;
      }
      // Same `start-end` shape as a line range, but absolute offsets.
      const span = parseSourceLoc(child.getAttribute(SOURCE_SPAN_ATTR));
      // An image shows no text and holds none in its span, and yet a
      // selection can end beside it: it is an atom in either pass.
      if (
        span !== null &&
        (child.tagName === "IMG" ||
          (takeAtoms &&
            textUnder(child) !== textInSpan(own, span.start, span.end)))
      ) {
        atoms.push({ el: child, ...span });
        items.push(child);
        continue;
      }
      walk(child);
    }
  };
  walk(el);
  return { items, atoms };
}

/** Line `items` up against `own`, each atom standing in for its span. */
function lineUp(
  index: SegmentIndex,
  own: SourceSegment[],
  { items, atoms }: { items: Node[]; atoms: Atom[] },
): BlockAlignment | null {
  const cut =
    atoms.length === 0
      ? { segments: own, placeholders: new Set<SourceSegment>() }
      : withAtoms(index, own, atoms);
  // A block holding no text but a document card still lines up, as the card.
  if (cut === null || cut.segments.length === 0) return null;
  const { segments, placeholders } = cut;
  let joined = "";
  const atomAt: number[] = [];
  for (const segment of segments) {
    if (placeholders.has(segment)) atomAt.push(joined.length);
    joined += segment.text;
  }
  const offsets = new Map<Node, number>();
  const inserted = new Set<Node>();
  let at = 0;
  for (const item of items) {
    if (item.nodeType !== Node.TEXT_NODE) {
      if (!atomAt.includes(at)) return null;
      at += 1;
      continue;
    }
    const data = item.nodeValue ?? "";
    offsets.set(item, at);
    const fits =
      joined.startsWith(data, at) &&
      !atomAt.some((p) => p >= at && p < at + data.length);
    if (fits) at += data.length;
    else if (/\S/.test(data)) return null;
    else inserted.add(item);
  }
  return at === joined.length ? { segments, offsets, inserted, atoms } : null;
}

/**
 * Source offset one selection endpoint maps to, or null to give up.
 */
function sourceOffsetOfEndpoint(
  index: SegmentIndex,
  node: Node,
  offset: number,
  edge: "start" | "end",
): number | null {
  if (isOldEndpoint(node)) return null;
  const block = columnBlockOf(node);
  if (block === null) return null;
  return sourceOffsetInBlock(index, block, node, offset, edge);
}

/**
 * Source offset in `index` an endpoint in `block` maps to, or null to give
 * up. One in an atom takes the atom's edge: its start for a start, its end
 * for an end.
 *
 * An endpoint on an element maps only beside an atom: a start takes the edge
 * of the atom right after it, an end of the one right before it. Those are
 * the element endpoints `endsOnContent` leaves — beside an image or a
 * shadow host, or inside an atom such as a document card — and any other
 * keeps the line anchor.
 */
export function sourceOffsetInBlock(
  index: SegmentIndex,
  block: ColumnBlock,
  node: Node,
  offset: number,
  edge: "start" | "end",
): number | null {
  const aligned = alignBlock(index, block);
  if (aligned === null) return null;
  // What an element endpoint has on its side: a start looks ahead.
  const next =
    node.nodeType === Node.TEXT_NODE
      ? null
      : (node.childNodes[edge === "start" ? offset : offset - 1] ?? null);
  const atom = aligned.atoms.find((a) => a.el.contains(node) || a.el === next);
  if (atom !== undefined) return edge === "start" ? atom.start : atom.end;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const at = aligned.offsets.get(node);
  if (at === undefined) return null;
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
const OLD_OR_INJECTED = `${INJECTED}, ${OLD_TABLE_PARTS}`;

/** The wrapper of a code block a comparison put back from its baseline. */
export const OLD_CODE_BLOCK = `.markdown-fence[${OLD_LINE_ATTR}]`;

/**
 * What `endsOnContent` takes for content. `skip` is never content and never
 * walked into, `block` is what content sits in, and `code` is a code block's
 * wrapper. `uiSelectsNothing` moves an endpoint in the annotation UI even
 * when it selects some of its text.
 */
type Walk = {
  skip: string;
  block: string;
  code: string;
  uiSelectsNothing: boolean;
};

/** The document being shown: old content is skipped like the UI. */
const CURRENT_WALK: Walk = {
  skip: OLD_OR_INJECTED,
  block: `[${SOURCE_LINE_ATTR}]`,
  code: CODE_BLOCK,
  uiSelectsNothing: false,
};

/**
 * A compared document, its old content included: removed text and structure
 * are content like any other, in a block restored from the baseline or in a
 * marker, and only the annotation UI — the chips, a list's numbers — is
 * skipped. A number is no text of its item, so an endpoint in one moves.
 */
const OLD_WALK: Walk = {
  skip: `[data-annotation-ui], ${FOOTNOTE_BACKREF}`,
  block: `[${SOURCE_LINE_ATTR}], [${OLD_LINE_ATTR}], .spec-del-block`,
  code: `${CODE_BLOCK}, ${OLD_CODE_BLOCK}`,
  uiSelectsNothing: true,
};

/**
 * What a selection takes whole rather than character by character: a code
 * block's wrapper, with whatever pierre or mermaid drew in it, an image, and
 * any other element with a shadow root of its own.
 */
function isBox(el: Element, walk: Walk): boolean {
  return (
    el.matches(walk.code) || el.tagName === "IMG" || el.shadowRoot !== null
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
function coversBox(range: Range, box: Element, walk: Walk): boolean {
  if (!box.matches(walk.code)) {
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
  walk: Walk,
): Content | null {
  const el = elementNear(node);
  if (el === null || el.closest(walk.skip) !== null) return null;
  const inside = node === el ? el.parentElement : el;
  const box = inside?.closest(walk.code) ?? null;
  if (box !== null && container.contains(box)) return null;
  const block = el.closest(walk.block);
  if (block === null || !container.contains(block)) return null;
  if (node instanceof Text) {
    const part = partIn(node, range);
    return /\S/.test(part.text) ? { kind: "text", node, ...part } : null;
  }
  return node === el && isBox(el, walk) && coversBox(range, el, walk)
    ? { kind: "box", el }
    : null;
}

/**
 * Whether an endpoint selects nothing itself, and may move: it sits in the
 * container's light DOM, outside any code block the selection covers, on an
 * element or on text whose part in the selection is blank. pierre's rows
 * map their own edges, and so does the text of a code block. The `↩` of a
 * footnote definition's link back is no text of the source either: a drag
 * to the end of a definition's line can end in it.
 */
function selectsNothing(
  container: Element,
  range: Range,
  at: Point,
  walk: Walk,
): boolean {
  if (!container.contains(at.node)) return false;
  const near = elementNear(at.node);
  if (
    near?.closest(FOOTNOTE_BACKREF) != null ||
    (walk.uiSelectsNothing && near?.closest("[data-annotation-ui]") != null)
  ) {
    return true;
  }
  const box = elementNear(at.node)?.closest(walk.code) ?? null;
  if (box !== null && container.contains(box) && coversBox(range, box, walk)) {
    return false;
  }
  return !(at.node instanceof Text) || !/\S/.test(partIn(at.node, range).text);
}

/** Whether a walk looks at what `node` holds. */
function walksInto(node: Node, walk: Walk): boolean {
  return (
    !(node instanceof Element) ||
    !(node.matches(walk.skip) || isBox(node, walk))
  );
}

function lastWithin(node: Node, walk: Walk): Node {
  let last = node;
  while (walksInto(last, walk) && last.lastChild !== null) {
    last = last.lastChild;
  }
  return last;
}

/** The node before `node` in document order, within the container. */
function nodeBefore(container: Element, node: Node, walk: Walk): Node | null {
  if (node === container) return null;
  if (node.previousSibling !== null) {
    return lastWithin(node.previousSibling, walk);
  }
  const parent = node.parentNode;
  return parent === container ? null : parent;
}

/** The node after `node` in document order, within the container. */
function nodeAfter(
  container: Element,
  node: Node,
  into: boolean,
  walk: Walk,
): Node | null {
  if (into && walksInto(node, walk) && node.firstChild !== null) {
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
  walk: Walk,
): Content | null {
  let node: Node | null;
  if (at.node instanceof Text) node = nodeBefore(container, at.node, walk);
  else {
    const child = at.node.childNodes[at.offset - 1];
    node = child === undefined ? at.node : lastWithin(child, walk);
  }
  for (; node !== null; node = nodeBefore(container, node, walk)) {
    // Past the start: nothing before it is selected.
    if (!range.intersectsNode(node)) return null;
    const content = contentAt(container, range, node, walk);
    if (content !== null) return content;
  }
  return null;
}

/** The first content the selection selects after `at`, its start. */
function contentAfter(
  container: Element,
  range: Range,
  at: Point,
  walk: Walk,
): Content | null {
  let node: Node | null =
    (at.node instanceof Text ? undefined : at.node.childNodes[at.offset]) ??
    nodeAfter(container, at.node, false, walk);
  for (; node !== null; node = nodeAfter(container, node, true, walk)) {
    if (!range.intersectsNode(node)) return null;
    const content = contentAt(container, range, node, walk);
    if (content !== null) return content;
  }
  return null;
}

/** The point on one side of an element, in its parent. */
export function beside(el: Element, side: "before" | "after"): Point {
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
 *
 * With `old`, a compared document's removed text and structure count as
 * content too (`OLD_WALK`), so that an end can move onto removed text the
 * selection selects; without it they are passed over like the rest of what
 * the spec view injects.
 */
export function endsOnContent(
  container: Element,
  ends: SelectionEndpoints,
  { old = false }: { old?: boolean } = {},
): SelectionEndpoints {
  const walk = old ? OLD_WALK : CURRENT_WALK;
  const ordered = orderedEndpoints(ends);
  if (ordered === null) return ends;
  const { range } = ordered;
  const { start, end } = ordered.ends;
  const moveStart = selectsNothing(container, range, start, walk);
  const moveEnd = selectsNothing(container, range, end, walk);
  if (!moveStart && !moveEnd) return ends;
  const first = moveStart ? contentAfter(container, range, start, walk) : null;
  const last = moveEnd ? contentBefore(container, range, end, walk) : null;
  // Nothing but whitespace between the two ends.
  if ((moveStart && first === null) || (moveEnd && last === null)) return ends;
  return {
    start: first === null ? start : startOn(first, start, walk),
    end: last === null ? end : endOn(last, end, walk),
    collapsed: ends.collapsed,
  };
}

function startOn(content: Content, start: Point, walk: Walk): Point {
  if (content.kind === "text") {
    return {
      node: content.node,
      offset: content.from + content.text.search(/\S/),
    };
  }
  if (!content.el.matches(walk.code)) {
    return beside(content.el, "before");
  }
  return start.node instanceof Text ? start : { node: content.el, offset: 0 };
}

function endOn(content: Content, end: Point, walk: Walk): Point {
  if (content.kind === "text") {
    return {
      node: content.node,
      offset: content.from + content.text.trimEnd().length,
    };
  }
  if (!content.el.matches(walk.code)) {
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
