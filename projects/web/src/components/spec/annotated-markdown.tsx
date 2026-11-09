import { formatAnchorRange, type SpecCommentItem } from "@todou/shared";
import { CheckIcon, MessageSquareTextIcon } from "lucide-react";
import type { ComponentProps } from "react";
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type Markdown from "react-markdown";
import {
  COMMENT_HEADER_ACTION,
  COMMENT_HEADER_ROW,
  CommentHeaderIdentity,
  CommentHeaderLine,
  CommentHeaderMeta,
} from "@/components/shared/comment-header-meta.tsx";
import {
  MarkdownViewWithPlugins,
  useMarkdownRemarkPlugins,
} from "@/components/shared/markdown-view.tsx";
import { displayNameOf, UserChip } from "@/components/shared/user-chip.tsx";
import {
  type AnchorRange,
  SelectionEntry,
  useSelectionEntry,
} from "@/components/spec/selection-entry.tsx";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  type CodeHighlightRanges,
  supportsCodeHighlights,
  useCodeHighlights,
} from "@/lib/code-highlights.ts";
import { codeBodyLines, codeRowSource } from "@/lib/code-rows.ts";
import {
  DELETION_LINE_TYPE,
  LINE_TYPE_ATTR,
  offsetInRow,
  rangeInRow,
  rowAt,
  rowText,
} from "@/lib/pierre-rows.ts";
import {
  INS_BLOCK_CLASS,
  MARK_KEY_ATTR,
  NO_DECORATIONS,
  rehypeDecorations,
} from "@/lib/rehype-decorations.ts";
import {
  MARKER as DETAILS_MARKER,
  rehypeExpandDetails,
} from "@/lib/rehype-details.ts";
import {
  FOLD_CLASS,
  FOLD_KEY_ATTR,
  rehypeFoldUnchanged,
} from "@/lib/rehype-fold-unchanged.ts";
import {
  CODE_CONTENT_START_ATTR,
  parseSourceLoc,
  rehypeSourceLines,
  SOURCE_LINE_ATTR,
} from "@/lib/rehype-source-lines.ts";
import { holdRevealed, revealBlock, useOwnHold } from "@/lib/scroll-insets.ts";
import {
  composedContains,
  elementNear,
  type SelectionEndpoints,
} from "@/lib/selection-endpoints.ts";
import { buildBaselineTree } from "@/lib/spec-baseline-tree.ts";
import { type LineRange, rangesIntersect } from "@/lib/spec-changes.ts";
import {
  annotationDecorations,
  changeDecorations,
  mergeDecorations,
  pairedFences,
} from "@/lib/spec-decorations.ts";
import type { SpecReviewDraft } from "@/lib/spec-drafts.ts";
import {
  buildSegmentIndex,
  columnsOfOffsets,
  lineColAt,
  offsetAt,
  type SegmentIndex,
  segmentsInLines,
  sourceOffsetOfRendered,
} from "@/lib/spec-source-index.ts";
import { cn } from "@/lib/utils";

type RehypePlugins = ComponentProps<typeof Markdown>["rehypePlugins"];

// Stable array — MarkdownView passes it straight to react-markdown.
const REHYPE_PLUGINS: RehypePlugins = [rehypeSourceLines];

// Stable empty defaults, for the same reason as the array above: a fresh `[]`
// on every render invalidates the memo the plugin array hangs on.
const NO_RANGES: LineRange[] = [];
const NO_FOLDS: ReadonlySet<string> = new Set();

export type DisplayedAnnotation = {
  key: string;
  /** 1-based inclusive lines in the *viewed* version. */
  start: number;
  end: number;
  /** 1-based inclusive columns within those lines; null = whole lines. */
  colStart?: number | null;
  colEnd?: number | null;
} & (
  | { kind: "comment"; item: SpecCommentItem }
  | { kind: "draft"; draft: SpecReviewDraft }
);

type Chip = {
  blockKey: string;
  top: number;
  items: DisplayedAnnotation[];
};

/** Where an annotation sits, as displayed on the version being viewed. */
function labelOf(item: DisplayedAnnotation): string {
  return formatAnchorRange({
    line_start: item.start,
    line_end: item.end,
    col_start: item.colStart,
    col_end: item.colEnd,
  });
}

export type { AnchorRange };

/**
 * Worn by a code block whose annotated characters are painted inside it, so
 * that its whole-block wash can step aside for them (styles.css).
 */
const CODE_PAINTED_CLASS = "spec-code-painted";

/** Worn by a block that annotations on whole lines cover (styles.css). */
const ANNOTATED_CLASS = "spec-annotated";
/** Worn with it while every one of those annotations is a draft. */
const ANNOTATED_DRAFT_CLASS = "spec-annotated-draft";

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

/**
 * Innermost block whose source range contains `line`. Stamped blocks nest
 * — a table and its rows, a blockquote and its paragraphs — and document
 * order puts the ancestor first, so the last match is the deepest one
 * (T-142). Lines that fall in a gap keep the old behaviour of attaching to
 * the block above.
 */
export function blockForLine(
  blocks: Array<{ start: number; end: number }>,
  line: number,
): number {
  let found = -1;
  let fallback = -1;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block === undefined) continue;
    if (line >= block.start && line <= block.end) found = i;
    else if (block.start <= line) fallback = i;
  }
  return found >= 0 ? found : fallback;
}

/** A stamped block with the source lines it renders. */
type StampedBlock = { el: HTMLElement; start: number; end: number };

/** The nearest stamped block around `el`, which a stamped block nests in. */
function stampedParent(el: Element): Element | null {
  return el.parentElement?.closest(`[${SOURCE_LINE_ATTR}]`) ?? null;
}

/**
 * The blocks that one of `ranges` reaches and that hold no other such block.
 * Stamped blocks nest, a table and its rows, a list item and the items under
 * it, and the deepest of them say where in their ancestors the lines lie.
 * `linesOf` gives the lines a block counts as its own, null for none. Found
 * by walking up from each block reached to the nearest one around it, rather
 * than asking every pair, since a range can reach every block of a document.
 */
function innermostIntersecting<B extends { el: Element }>(
  blocks: B[],
  ranges: LineRange[],
  linesOf: (block: B) => LineRange | null,
): B[] {
  const hit = blocks.filter((block) => {
    const lines = linesOf(block);
    return (
      lines !== null && ranges.some((range) => rangesIntersect(range, lines))
    );
  });
  const reached = new Set(hit.map((block) => block.el));
  const holders = new Set<Element>();
  for (const block of hit) {
    for (
      let up = stampedParent(block.el);
      up !== null;
      up = stampedParent(up)
    ) {
      // The one reached around it holds the ones around itself already.
      if (reached.has(up)) {
        holders.add(up);
        break;
      }
    }
  }
  return hit.filter((block) => !holders.has(block.el));
}

/**
 * The innermost stamped block holding each source line by its `data-loc`:
 * the block the line's text belongs to once rendered. Blocks come in
 * document order, an ancestor before the blocks it holds, so the deepest
 * one is the last written.
 */
function lineOwners<B extends StampedBlock>(blocks: B[]): Map<number, B> {
  const owners = new Map<number, B>();
  for (const block of blocks) {
    for (let line = block.start; line <= block.end; line++) {
      owners.set(line, block);
    }
  }
  return owners;
}

/** A table's delimiter row: pipes, dashes, colons and nothing else. */
const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/**
 * Which source lines show something once rendered, worked out on first ask
 * and kept for the pass. A blank line, a table's delimiter row and a line of
 * `<details>` and `<summary>` markers alone show nothing; quote markers and
 * indentation in front of a line are not text. Those markers are the only
 * HTML drawn as HTML (`rehypeDetails`); any other reaches the reader as its
 * source, so it shows. A marker that pairs with nothing is drawn as its
 * source too, and is still read as showing nothing here.
 */
function lineVisibility(index: SegmentIndex): (line: number) => boolean {
  const markers = new RegExp(DETAILS_MARKER.source, DETAILS_MARKER.flags);
  const shown = new Map<number, boolean>();
  return (line) => {
    const known = shown.get(line);
    if (known !== undefined) return known;
    const start = index.lineStarts[line - 1];
    const next = index.lineStarts[line];
    const text =
      start === undefined
        ? ""
        : index.source
            .slice(start, next === undefined ? index.source.length : next - 1)
            .replace(/^[\s>]*/, "")
            .trim();
    const shows =
      text !== "" &&
      !(text.includes("|") && DELIMITER_ROW.test(text)) &&
      text.replace(markers, "").trim() !== "";
    shown.set(line, shows);
    return shows;
  };
}

/**
 * The blocks a whole-line annotation over `range` washes: the innermost
 * blocks it reaches, and any block a line of whose own text is in the range,
 * text no stamped block inside it holds, such as a tight list item's
 * continuation line above the items nested in it, or a `<details>`'s
 * summary. A line that shows nothing (`lineVisibility`) washes nothing of its
 * own. A code block reaches only as far as its body (`lines`): its fence
 * markers are no line of its code.
 */
function annotatedBlocks(
  blocks: Array<StampedBlock & { lines: LineRange | null }>,
  range: LineRange,
  owners: Map<number, StampedBlock & { lines: LineRange | null }>,
  shows: (line: number) => boolean,
): HTMLElement[] {
  const washed = new Set<Element>(
    innermostIntersecting(blocks, [range], (block) => block.lines).map(
      (block) => block.el,
    ),
  );
  for (let line = range.start; line <= range.end; line++) {
    const owner = owners.get(line);
    const own = owner?.lines;
    if (owner === undefined || own == null) continue;
    if (line < own.start || line > own.end || washed.has(owner.el)) continue;
    if (shows(line)) washed.add(owner.el);
  }
  return blocks.flatMap((block) => (washed.has(block.el) ? [block.el] : []));
}

/**
 * A block's top within the annotation container. `offsetTop` agrees for a
 * paragraph but lies for a `<tr>`: HTML cuts the offsetParent chain at
 * table/td/th, so a row reports its offset inside its own table — 36px for
 * a row sitting 581px down the page. Rects have no such blind spot, and the
 * two of them move together under scroll.
 */
export function chipTop(containerRect: { top: number }, el: Element): number {
  return el.getBoundingClientRect().top - containerRect.top;
}

/**
 * The outermost fold standing between `el` and the reader, or `el` itself.
 *
 * A closed `<details>` renders its contents `display: none`, and every rect
 * inside one is zero, so measuring the block directly stacks its chip at the
 * top of the container. The fold pass never has this problem because it
 * refuses to fold an annotated block at all — but a `<details>` is the
 * reader's to close, so the chip follows it up to the fold's own header
 * instead. Asking which fold is shut says the reason, and needs no layout.
 *
 * One pass up the ancestor chain, keeping the last match, rather than a
 * `closest` that restarts from what it found: the walk then terminates
 * because the DOM is finite, and a future edit cannot turn it into the
 * synchronous spin that a test runner has no way to interrupt or name.
 */
export function visibleAnchor(el: HTMLElement): HTMLElement {
  let anchor = el;
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (node.matches("details:not([open])")) anchor = node;
  }
  return anchor;
}

/**
 * Rendered markdown with the annotation layer of the spec review view:
 * selecting text floats a "comment" button (the anchor is derived from the
 * blocks' stamped source lines), staged drafts and submitted comments hang
 * as chips on their blocks, and each chip opens the thread in a popover.
 *
 * Memoised, and so is each chip: every chip is a whole Radix popover even
 * while closed, and the page around them re-renders for reasons that never
 * reach the document (T-601). The callbacks have to arrive stable for that.
 */
export const AnnotatedMarkdown = memo(function AnnotatedMarkdown({
  slug,
  issueNumber,
  body,
  baselineBody,
  annotations,
  changedRanges = NO_RANGES,
  foldUnchanged = false,
  onStage,
  onEditDraft,
  onRemoveDraft,
  onResolve,
  resolving = false,
}: {
  slug: string;
  issueNumber: number;
  body: string;
  /**
   * The same file in the compare baseline, when "changes since vN" is on.
   * Its presence is what turns the word-level diff on (T-142); leaving it
   * out renders the document with annotations only.
   */
  baselineBody?: string;
  /** The viewed spec version's push time (T-80 time cutoff). */
  annotations: DisplayedAnnotation[];
  /** Lines changed since the compare baseline — green highlight + ↑↓ nav. */
  changedRanges?: LineRange[];
  /**
   * Fold the runs of blocks that carry nothing to review (T-222). Only ever
   * true for a rendered comparison of a file that has changes to fold around;
   * spec-view owns that judgement, and the reader's preference.
   */
  foldUnchanged?: boolean;
  /** Stage a draft for the selected source range of the viewed version. */
  onStage: (range: AnchorRange) => void;
  /** Load a staged draft back into the composer for rewriting (T-159). */
  onEditDraft: (draft: SpecReviewDraft) => void;
  onRemoveDraft: (id: string) => void;
  onResolve: (commentId: number) => void;
  resolving?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(NO_FOLDS);
  const remarkPlugins = useMarkdownRemarkPlugins(slug);

  const index = useMemo(() => buildSegmentIndex(body), [body]);
  const resolveSelection = useCallback(
    (container: Element, ends: SelectionEndpoints) =>
      anchorForSelection(container, index, ends),
    [index],
  );
  const { pending, clear } = useSelectionEntry(containerRef, resolveSelection);
  const baselineIndex = useMemo(
    () => (baselineBody === undefined ? null : buildSegmentIndex(baselineBody)),
    [baselineBody],
  );
  const changes = useMemo(
    () =>
      baselineIndex === null
        ? NO_DECORATIONS
        : changeDecorations(baselineIndex, index),
    [baselineIndex, index],
  );
  const hasStructures = changes.structures.length > 0;
  const baselineTree = useMemo(
    () =>
      baselineBody === undefined || !hasStructures
        ? undefined
        : buildBaselineTree(baselineBody, { remarkPlugins }),
    [baselineBody, hasStructures, remarkPlugins],
  );
  const decorations = useMemo(
    () =>
      mergeDecorations(
        { ...changes, baselineTree },
        annotationDecorations(
          index,
          annotations.map((a) => ({
            key: a.key,
            kind: a.kind,
            start: a.start,
            end: a.end,
            colStart: a.colStart ?? null,
            colEnd: a.colEnd ?? null,
          })),
        ),
      ),
    [index, changes, baselineTree, annotations],
  );
  const fenceBaselines = useMemo(
    () =>
      baselineIndex === null ? undefined : pairedFences(baselineIndex, index),
    [baselineIndex, index],
  );
  const annotationRanges = useMemo(
    () => annotations.map((a) => ({ start: a.start, end: a.end })),
    [annotations],
  );
  // Referential stability is load-bearing, not tidiness: a fresh plugin
  // array re-runs react-markdown and rebuilds the text nodes a live
  // selection lives in (T-60). None of these inputs move while a selection
  // is pending — folding is switched from the toolbar, and opening a
  // placeholder is a click, which no selection outlives anyway.
  const rehypePlugins = useMemo<RehypePlugins>(() => {
    const decorated =
      decorations.spans.length > 0 ||
      decorations.deletions.length > 0 ||
      decorations.blocks.length > 0 ||
      decorations.tables.length > 0 ||
      decorations.images.length > 0 ||
      decorations.structures.length > 0;
    // Annotations alone used to take this exit: they always come with
    // decorations to paint. A `<details>` that has to be opened for them does
    // not, and skipping the array would leave the chip pointing into a fold
    // nothing ever opened.
    if (!decorated && !foldUnchanged && annotationRanges.length === 0) {
      return REHYPE_PLUGINS;
    }
    // This order is the only thing holding the three passes together, and
    // nothing but the array enforces it: rehypeExpandDetails reads the classes
    // rehypeDecorations paints, and rehypeFoldUnchanged counts top-level
    // blocks a fold has already been resolved into.
    const plugins: NonNullable<RehypePlugins> = [rehypeSourceLines];
    if (decorated) plugins.push([rehypeDecorations, decorations]);
    plugins.push([rehypeExpandDetails, { changedRanges, annotationRanges }]);
    if (foldUnchanged) {
      plugins.push([
        rehypeFoldUnchanged,
        { changedRanges, annotationRanges, expanded, keepHeading: true },
      ]);
    }
    return plugins;
  }, [decorations, foldUnchanged, changedRanges, annotationRanges, expanded]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different document, or folding switched, invalidates both which folds are open and where a pending selection sat
  useEffect(() => {
    setExpanded(NO_FOLDS);
    clear();
  }, [body, baselineBody, foldUnchanged]);

  const layout = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const els = [
      ...container.querySelectorAll<HTMLElement>(`[${SOURCE_LINE_ATTR}]`),
    ];
    const blocks = els.map((el) => {
      const loc = parseSourceLoc(el.getAttribute(SOURCE_LINE_ATTR)) ?? {
        start: 0,
        end: 0,
      };
      return {
        el,
        ...loc,
        lines: el.hasAttribute(CODE_CONTENT_START_ATTR)
          ? codeBodyLines(index, el)
          : loc,
      };
    });
    // A column-anchored annotation paints its own words; the block-wide
    // wash would only smear over the precision it just gained. One on whole
    // lines washes every block it covers, in the draft colour while drafts
    // alone wash that block, and hangs its chip by the first of them rather
    // than by the block above a blank line it starts on, which it leaves
    // unwashed.
    const owners = lineOwners(blocks);
    const shows = lineVisibility(index);
    const washedBy = new Map<HTMLElement, Set<DisplayedAnnotation["kind"]>>();
    const grouped = new Map<number, DisplayedAnnotation[]>();
    for (const annotation of annotations) {
      let at = blockForLine(blocks, annotation.start);
      if ((annotation.colStart ?? null) === null) {
        const range = { start: annotation.start, end: annotation.end };
        let targets = annotatedBlocks(blocks, range, owners, shows);
        if (targets.length === 0) {
          const fallback = blocks[at];
          targets = fallback === undefined ? [] : [fallback.el];
        }
        for (const el of targets) {
          washedBy.set(
            el,
            (washedBy.get(el) ?? new Set()).add(annotation.kind),
          );
        }
        const first = targets[0];
        if (first !== undefined) at = els.indexOf(first);
      }
      if (at < 0) continue;
      grouped.set(at, [...(grouped.get(at) ?? []), annotation]);
    }
    // Innermost wins: one edited cell lights its own row, not the table it
    // sits in (T-142). Ancestors that only contain a marked descendant stay
    // plain, so the ↑↓ navigation lands on rows rather than whole tables.
    const changed = innermostIntersecting(
      blocks,
      changedRanges,
      (block) => block,
    );
    for (const block of blocks) {
      block.el.classList.remove(ANNOTATED_CLASS, ANNOTATED_DRAFT_CLASS);
      block.el.classList.toggle(
        "spec-changed",
        changed.includes(block) &&
          // A wholly-new block already says so, louder (T-158). Stacking
          // the "something here changed" wash under it only shifts the
          // padding and muddies the colour.
          block.el.closest(`.${INS_BLOCK_CLASS}`) === null,
      );
    }
    for (const [el, kinds] of washedBy) {
      el.classList.add(ANNOTATED_CLASS);
      if (!kinds.has("comment")) el.classList.add(ANNOTATED_DRAFT_CLASS);
    }
    const next: Chip[] = [];
    for (const [at, items] of grouped) {
      const block = blocks[at];
      if (block === undefined) continue;
      next.push({
        blockKey: `${block.start}-${block.end}`,
        // The key still names the block the annotation belongs to; only what
        // gets measured moves when the reader shuts a fold over it.
        top: chipTop(containerRect, visibleAnchor(block.el)),
        items,
      });
    }
    next.sort((a, b) => a.top - b.top);
    // Chip by chip, so that one chip moving re-renders that chip alone.
    setChips((prev) => {
      const before = new Map(prev.map((chip) => [chip.blockKey, chip]));
      const kept = next.map((chip) => {
        const old = before.get(chip.blockKey);
        return old !== undefined &&
          old.top === chip.top &&
          old.items.length === chip.items.length &&
          old.items.every((item, j) => item === chip.items[j])
          ? old
          : chip;
      });
      return kept.length === prev.length &&
        kept.every((chip, i) => chip === prev[i])
        ? prev
        : kept;
    });
  }, [annotations, changedRanges, index]);

  /**
   * The characters of code that column anchors cover, painted as ranges over
   * pierre's own rows (T-31 keeps marks out of a code block). Each row is
   * placed in the source by `codeRowSource`, the mapping a selection there
   * is anchored by, so what gets painted is what was selected; a row it
   * cannot place keeps its block's wash instead.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new set of decorations rewrites the wrappers' classes, taking the painted class off them
  const paintCode = useCallback(
    (container: HTMLElement): CodeHighlightRanges => {
      const ranges: CodeHighlightRanges = { comment: [], draft: [] };
      const marks = supportsCodeHighlights()
        ? annotations.flatMap((a) => {
            if (a.colStart == null || a.colEnd == null) return [];
            const start = offsetAt(index, a.start, a.colStart);
            const last = offsetAt(index, a.end, a.colEnd);
            if (start === null || last === null) return [];
            return [
              { key: a.key, kind: a.kind, start, end: last + 1, lines: a },
            ];
          })
        : [];
      for (const wrapper of container.querySelectorAll(
        `[${CODE_CONTENT_START_ATTR}]`,
      )) {
        const loc = parseSourceLoc(wrapper.getAttribute(SOURCE_LINE_ATTR));
        const here =
          loc === null
            ? []
            : marks.filter(
                (mark) =>
                  mark.lines.start <= loc.end && mark.lines.end >= loc.start,
              );
        // The wash steps aside only once every annotation reaching into the
        // block has characters of its own painted here: a whole-line one has
        // none, and a column one on rows that could not be placed has none.
        const painted = new Set<string>();
        for (const host of here.length === 0
          ? []
          : wrapper.querySelectorAll("diffs-container")) {
          for (const row of host.shadowRoot?.querySelectorAll("[data-line]") ??
            []) {
            const source = codeRowSource(index, row);
            if (source === null || source.textStart === null) continue;
            const rowEnd = source.textStart + rowText(row).length;
            for (const mark of here) {
              const from = Math.max(mark.start, source.textStart);
              const to = Math.min(mark.end, rowEnd);
              if (to <= from) continue;
              const range = rangeInRow(
                row,
                from - source.textStart,
                to - source.textStart,
              );
              if (range === null) continue;
              (mark.kind === "comment" ? ranges.comment : ranges.draft).push(
                range,
              );
              painted.add(mark.key);
            }
          }
        }
        const touching =
          loc === null
            ? []
            : annotations.filter(
                (a) => a.start <= loc.end && a.end >= loc.start,
              );
        wrapper.classList.toggle(
          CODE_PAINTED_CLASS,
          touching.length > 0 && touching.every((a) => painted.has(a.key)),
        );
      }
      return ranges;
    },
    [annotations, index, decorations],
  );
  useCodeHighlights(containerRef, paintCode);

  useLayoutEffect(() => {
    layout();
    // A resize moves the chips; the entry's own recompute is the selection
    // layer's.
    window.addEventListener("resize", layout);
    return () => window.removeEventListener("resize", layout);
  }, [layout]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: folding moves the blocks the chips are measured against
  useLayoutEffect(() => {
    layout();
  }, [layout, expanded, foldUnchanged]);

  // `toggle` does not bubble, so the capture phase is the only way one
  // listener hears every `<details>` under the container, nested ones
  // included.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    container.addEventListener("toggle", layout, true);
    return () => container.removeEventListener("toggle", layout, true);
  }, [layout]);

  const keepHold = useOwnHold();
  /** Jump to what a popover entry points at — its own mark, or its block. */
  const flashAnnotation = useCallback(
    (annotation: DisplayedAnnotation, blockKey: string) => {
      const container = containerRef.current;
      if (!container) return;
      const target =
        container.querySelector<HTMLElement>(
          `[${MARK_KEY_ATTR}="${annotation.key}"]`,
        ) ??
        container.querySelector<HTMLElement>(
          `[${SOURCE_LINE_ATTR}="${blockKey}"]`,
        );
      if (target === null) return;
      revealBlock(target, { behavior: "smooth" });
      keepHold(holdRevealed(target, document.body, "auto", "smooth"));
    },
    [keepHold],
  );

  /** The fold placeholders are markdown-side nodes, so React never sees them. */
  const onClick = useCallback(
    (event: ReactMouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const key = event.target
        .closest(`.${FOLD_CLASS}`)
        ?.getAttribute(FOLD_KEY_ATTR);
      if (key === null || key === undefined) return;
      setExpanded((prev) => new Set([...prev, key]));
      clear();
    },
    [clear],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click only delegates to the fold placeholders; blocks stay natively selectable
    // biome-ignore lint/a11y/useKeyWithClickEvents: what the click delegates to is a real <button>, which answers Enter and Space by firing this same click
    <div
      ref={containerRef}
      className="relative pr-10"
      onClick={onClick}
      data-testid="annotated-markdown"
    >
      <MarkdownViewWithPlugins
        slug={slug}
        issueNumber={issueNumber}
        rehypePlugins={rehypePlugins}
        fenceBaselines={fenceBaselines}
        remarkPlugins={remarkPlugins}
      >
        {body}
      </MarkdownViewWithPlugins>

      {chips.map((chip) => (
        <AnnotationChip
          key={chip.blockKey}
          slug={slug}
          issueNumber={issueNumber}
          chip={chip}
          onFlash={flashAnnotation}
          onEditDraft={onEditDraft}
          onRemoveDraft={onRemoveDraft}
          onResolve={onResolve}
          resolving={resolving}
        />
      ))}

      <SelectionEntry pending={pending} clear={clear} onStage={onStage} />
    </div>
  );
});

const AnnotationChip = memo(function AnnotationChip({
  slug,
  issueNumber,
  chip,
  onFlash,
  onEditDraft,
  onRemoveDraft,
  onResolve,
  resolving,
}: {
  /**
   * Which issue a published annotation's comment belongs to. Passed down
   * rather than read back off the location: comment ids repeat across
   * projects, so a header that guessed from the page would keep linking
   * somewhere plausible after the wrong guess.
   */
  slug: string;
  issueNumber: number;
  chip: Chip;
  onFlash: (annotation: DisplayedAnnotation, blockKey: string) => void;
  onEditDraft: (draft: SpecReviewDraft) => void;
  onRemoveDraft: (id: string) => void;
  onResolve: (commentId: number) => void;
  resolving: boolean;
}) {
  const draftCount = chip.items.filter((i) => i.kind === "draft").length;
  const locate = (item: DisplayedAnnotation) => (
    <button
      type="button"
      className="cursor-pointer hover:underline"
      title="Scroll to what this points at"
      onClick={() => onFlash(item, chip.blockKey)}
    >
      {labelOf(item)}
    </button>
  );
  return (
    <Popover>
      <PopoverTrigger
        data-annotation-ui=""
        className={`absolute right-0 inline-flex cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs shadow-sm ${
          draftCount > 0
            ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400"
            : "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        }`}
        style={{ top: chip.top }}
        aria-label={`${chip.items.length} comment(s) on this block`}
      >
        <MessageSquareTextIcon className="size-3.5" />
        {chip.items.length}
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        className="max-h-96 w-96 space-y-3 overflow-y-auto"
      >
        {chip.items.map((item) =>
          item.kind === "draft" ? (
            <div
              key={item.key}
              className="rounded-md border border-indigo-500/40 p-2 text-sm"
            >
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-indigo-700 dark:text-indigo-400">
                  draft
                </span>
                {locate(item)}
                <span className="ml-auto" />
                {/* Editing reopens the composer, which the popover would
                    cover — close it on the way out. */}
                <PopoverClose asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => onEditDraft(item.draft)}
                  >
                    Edit
                  </Button>
                </PopoverClose>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => onRemoveDraft(item.draft.id)}
                >
                  Discard
                </Button>
              </div>
              <p className="whitespace-pre-wrap">{item.draft.body}</p>
            </div>
          ) : (
            <div key={item.key} className="rounded-md border p-2 text-sm">
              <div
                className={cn(
                  "mb-1 flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground",
                  COMMENT_HEADER_ROW,
                )}
              >
                <CommentHeaderLine>
                  <CommentHeaderIdentity>
                    <UserChip user={item.item.author} />
                    <span>
                      {locate(item)} · v{item.item.anchor.version}
                    </span>
                  </CommentHeaderIdentity>
                  {/* Stays, against every instinct to sweep it up: it is what
                      pushes the meta right on the desktop row, and replacing
                      it with an `ml-auto` on the meta itself would cost the
                      row one `gap-2` and shift the desktop 8px (T-445). The
                      grid below the breakpoint places its children itself,
                      where an unplaced box of its own would take a cell. */}
                  <span className="ml-auto max-sm:hidden" />
                  <CommentHeaderMeta
                    slug={slug}
                    issueNumber={issueNumber}
                    commentId={item.item.comment_id}
                    createdAt={item.item.created_at}
                  />
                  {/* The mark sits on the header's baseline and the button
                      does not, which is the whole of why the ternary is split
                      across the line's edge (T-487). */}
                  {item.item.resolved !== null && (
                    <span
                      className={cn(
                        "text-green-700 dark:text-green-400",
                        COMMENT_HEADER_ACTION,
                      )}
                      title={`resolved by ${displayNameOf(item.item.resolved.by)}`}
                    >
                      resolved
                    </span>
                  )}
                </CommentHeaderLine>
                {item.item.resolved === null && (
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn(
                      "h-6 self-center px-2 text-xs",
                      COMMENT_HEADER_ACTION,
                    )}
                    disabled={resolving}
                    onClick={() => onResolve(item.item.comment_id)}
                  >
                    <CheckIcon className="size-3" />
                    Resolve
                  </Button>
                )}
              </div>
              <p className="whitespace-pre-wrap">{item.item.body}</p>
            </div>
          ),
        )}
      </PopoverContent>
    </Popover>
  );
});
