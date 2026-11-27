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
import { flushSync } from "react-dom";
import type Markdown from "react-markdown";
import { CompareViewerProvider } from "@/components/issue/attachment-markdown.tsx";
import {
  COMMENT_HEADER_ACTION,
  COMMENT_HEADER_ROW,
  COMMENT_SURFACE,
  CommentHeaderIdentity,
  CommentHeaderLine,
  CommentHeaderMeta,
} from "@/components/shared/comment-header-meta.tsx";
import {
  MarkdownViewWithPlugins,
  useMarkdownRemarkPlugins,
} from "@/components/shared/markdown-view.tsx";
import {
  CompareLabelsContext,
  DEFAULT_COMPARE_LABELS,
} from "@/components/shared/media-compare.tsx";
import { displayNameOf, UserChip } from "@/components/shared/user-chip.tsx";
import {
  type AnchorRange,
  CommentEntryLabel,
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
  CODE_RENDERED_EVENT,
  type CodeHighlightRanges,
  type LineMark,
  markRows,
  supportsCodeHighlights,
  useCodeHighlights,
} from "@/lib/code-highlights.ts";
import {
  baselineRowSource,
  type CodeRowSource,
  codeBodyLines,
  codeRowSource,
  fenceAt,
} from "@/lib/code-rows.ts";
import {
  type CompareAnchor,
  compareAnchorForSelection,
} from "@/lib/compare-anchor.ts";
import { rangeInRow, rowText } from "@/lib/pierre-rows.ts";
import {
  coverageOf,
  DEL_ROW_CLASS,
  INS_BLOCK_CLASS,
  MARK_KEY_ATTR,
  NO_DECORATIONS,
  rehypeDecorations,
  type SpanDecoration,
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
  FENCE_PATCH_ATTR,
  OLD_FLAT_ATTR,
  OLD_LINE_ATTR,
  OLD_SOURCE_ATTR,
  parseSourceLoc,
  rehypeSourceLines,
  SOURCE_LINE_ATTR,
} from "@/lib/rehype-source-lines.ts";
import {
  glideToRevealed,
  openEnclosingFolds,
  useOwnHold,
} from "@/lib/scroll-insets.ts";
import {
  anchorForSelection,
  OLD_CODE_BLOCK,
  rangeAtSource,
} from "@/lib/selection-anchor.ts";
import type { SelectionEndpoints } from "@/lib/selection-endpoints.ts";
import { buildBaselineTree } from "@/lib/spec-baseline-tree.ts";
import { type LineRange, rangesIntersect } from "@/lib/spec-changes.ts";
import {
  type AnchoredAnnotation,
  annotationDecorations,
  changeDecorations,
  lineDecorations,
  mergeDecorations,
  pairedFences,
} from "@/lib/spec-decorations.ts";
import type { SpecReviewDraft } from "@/lib/spec-drafts.ts";
import {
  buildSegmentIndex,
  offsetAt,
  type SegmentIndex,
  type SourceFence,
  type TextOrigin,
} from "@/lib/spec-source-index.ts";
import { SM_UP, useMediaQuery } from "@/lib/use-media-query.ts";
import { cn } from "@/lib/utils";

type RehypePlugins = ComponentProps<typeof Markdown>["rehypePlugins"];

// Stable array — MarkdownView passes it straight to react-markdown.
const REHYPE_PLUGINS: RehypePlugins = [rehypeSourceLines];

// Stable empty defaults, for the same reason as the array above: a fresh `[]`
// on every render invalidates the memo the plugin array hangs on.
const NO_RANGES: LineRange[] = [];
const NO_ANNOTATIONS: DisplayedAnnotation[] = [];
const NO_SPANS: SpanDecoration[] = [];
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
  /**
   * The chip's identity across layouts, so never a position: a layout that
   * moves the chip keeps it mounted, and its popover open. It is the key of
   * the chip one of its annotations was in the layout before, else one made
   * from the place it hangs at: its block's key (`start-end`, or `old-i` for
   * a block put back of the baseline), followed for a row of code by `:L` or
   * `:old-L` and the source line the row shows, for the foot of a patch
   * fence's box by `:below` or `:old-below`, for a line of text by `:@`
   * and the source offset its first character is drawn from, and for a run
   * of removed text by `:old@` and where the run starts in the baseline;
   * with a `+` for each chip already going on under that key.
   */
  blockKey: string;
  /**
   * Where the chip hangs. One that follows a box as it scrolls (`follow`)
   * hangs where the layout that made it measured, the box scrolled where it
   * was then; its animation moves it from there along `follow`'s path, and
   * the two together are where it is drawn.
   */
  top: number;
  items: DisplayedAnnotation[];
  follow?: Follow;
};

/** An annotation as the decorations see it: its slice of the source. */
function anchoredOf(item: DisplayedAnnotation): AnchoredAnnotation {
  return {
    key: item.key,
    kind: item.kind,
    start: item.start,
    end: item.end,
    colStart: item.colStart ?? null,
    colEnd: item.colEnd ?? null,
  };
}

/**
 * What a comparison puts back of its baseline whole, and so what a baseline
 * annotation on it hangs its chip on: a restored block, a marker, or the row
 * drawn in for a removed table row, which carries no `OLD_LINE_ATTR`.
 */
const OLD_HOLDER = `[${OLD_LINE_ATTR}], .spec-del-block, .${DEL_ROW_CLASS}`;

/** The wrappers of the code blocks pierre draws rows in, old ones included. */
const CODE_WRAPPERS = `[${CODE_CONTENT_START_ATTR}], ${OLD_CODE_BLOCK}`;

/**
 * Whether a shut `<details>` hides `node`: it is inside one, and not in the
 * summary a shut fold still shows. What its box measures there is no place
 * on the page: nothing in one browser, where it would be if open in another.
 */
function shutAway(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  const fold = el?.closest("details:not([open])");
  return fold != null && el?.closest("summary")?.parentElement !== fold;
}

/**
 * The box of the first character or picture `el` draws: the first, in
 * document order, whose box has any height, with whatever a comparison put
 * back of its baseline and without the annotation UI. Null where it draws
 * neither. Shadow roots stay shut: a document card opening a block is the
 * block's first character, which is measured by itself.
 */
function firstDrawn(el: Element): DOMRect | null {
  const walk = document.createTreeWalker(
    el,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node instanceof Element && node.matches("[data-annotation-ui]")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    },
  );
  const range = document.createRange();
  for (let node = walk.nextNode(); node !== null; node = walk.nextNode()) {
    if (node instanceof Element) {
      if (node.tagName !== "IMG") continue;
      range.selectNode(node);
    } else {
      const at = node.nodeValue?.search(/\S/) ?? -1;
      if (at < 0) continue;
      range.setStart(node, at);
      range.setEnd(node, at + 1);
    }
    const box = range.getBoundingClientRect();
    if (box.height > 0) return box;
  }
  return null;
}

/**
 * How a text block's first line is measured. `top` is the box of `opening`,
 * its first character, or of the first thing one of its columns draws,
 * where that is drawn higher. The first character need not be on the first
 * line: a comparison puts back before it what the source no longer holds, a
 * swapped picture's old half or removed words, which a narrow screen can
 * spread over a line or more; and a table row's cells are centred, so a
 * short first cell starts below a long one's first line. Each cell of a row
 * is a column, any other block one. Only higher: on the line they share,
 * the first character keeps its place, a hair above the old picture beside
 * it, and so does a comparison opening a block, which draws inside itself.
 * `line` is the height of the shortest of those boxes, which half a line is
 * half of: a picture is no line of words, and where a row's cell holds
 * words beside a taller picture in another, half the picture would take
 * the words' first lines for the row's first.
 */
function firstLine(
  el: Element,
  opening: Range,
): { top: DOMRect; line: number } {
  let top = opening.getBoundingClientRect();
  let line = top.height;
  const columns = el.tagName === "TR" ? [...el.children] : [el];
  for (const column of columns) {
    const box = firstDrawn(column);
    if (box === null) continue;
    if (box.top < top.top) top = box;
    if (line === 0 || box.height < line) line = box.height;
  }
  return { top, line };
}

/** One of pierre's rows, and where it sits in the source. */
type PlacedRow = { row: HTMLElement; source: CodeRowSource };

/** The rows pierre drew for the code block `wrapper`, in document order. */
function shadowRows(wrapper: Element): HTMLElement[] {
  return [...wrapper.querySelectorAll("diffs-container")].flatMap((host) => [
    ...(host.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? []),
  ]);
}

/**
 * How tall `AnnotationChip` draws a chip, so how close two can sit before
 * they overlap, at a root font size of `rem` pixels: from `sm` up a 1rem
 * line (`text-xs`), 0.125rem padding and a 1px border, top and bottom; below
 * it a 1.5rem count badge (`max-sm:h-6`). The border stays 1px at any font
 * size, so the chip does not scale with it as a whole.
 */
function chipHeight(wide: boolean, rem: number): number {
  return wide ? 1.25 * rem + 2 : 1.5 * rem;
}

/**
 * How much less than a chip's height apart two chips can measure and still
 * only touch. Firefox hands positions back as single-precision floats, which
 * can put two places a chip's height apart up to 0.012px nearer 65,536px
 * from the window's top. Chromium and WebKit lay out in 64ths of a pixel, so
 * it stays under one: two chips that overlap there by a 64th still join.
 * They hand positions back as such floats too, which hold every 64th only
 * within 262,144px of the window's top (in WebKit, of the page's): past it,
 * two chips that only touch can measure a 64th or more nearer and join. A
 * hair that wide would part chips that overlap by a 64th anywhere on the
 * page.
 */
const HAIR = 0.015;

/**
 * The box `row` scrolls in within the code block `wrapper`: the nearest
 * element between them that scrolls on its own, as a patch's files do in
 * pierre's view, else the wrapper, as in the raw view, which does not.
 */
function scrollBox(wrapper: Element, row: Element): Element {
  const root = row.getRootNode();
  for (
    let el: Element | null = root instanceof ShadowRoot ? root.host : row;
    el !== null && el !== wrapper;
    el = el.parentElement
  ) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") return el;
  }
  return wrapper;
}

/**
 * How a chip moves as the box `box` scrolls: points of the box's scroll
 * position and the chip's top there, the top going in a straight line from
 * one point to the next. The last is the box scrolled as far as it goes.
 */
type Follow = { box: Element; path: [number, number][] };

/**
 * What a row of a patch fence hangs its chip by: the row is `h` tall, its
 * block's top is at `head`, the foot of the box it scrolls in at `foot`,
 * and a chip is `tall`.
 */
type PatchRow = { h: number; head: number; foot: number; tall: number };

/**
 * Where the chip of a row of a patch fence hangs with the row's top at `y`:
 * beside the row, but no lower than a chip's height above the box's foot
 * while the row reaches past it, and no higher than the block's top: where
 * the chip stays once pierre drops the row, by `belowRows` or by the block.
 */
function patchRowTop(y: number, { h, head, foot, tall }: PatchRow): number {
  let top = y;
  if (y + h > foot) top = Math.min(top, foot - tall);
  return Math.max(top, head);
}

/**
 * How the chip `patchRowTop` hangs moves as the box scrolls through its
 * `range`: the row's top is at `y0` with the box scrolled to 0, and higher
 * by as much as the box scrolls. The path turns where the row's top meets
 * the block's, where it is a chip's height above the box's foot, and where
 * the row's foot meets the box's. The chip jumps there, from a chip's
 * height above the foot to the row, so that point comes twice, the one
 * before the jump first: an animation takes the later of two keyframes at
 * one offset from that offset on.
 */
function patchRowPath(
  y0: number,
  range: number,
  row: PatchRow,
): [number, number][] {
  const { h, head, foot, tall } = row;
  const meets = y0 - (foot - h);
  const turns: [number, number][] = [
    [y0 - head, patchRowTop(head, row)],
    [y0 - (foot - tall), patchRowTop(foot - tall, row)],
    [meets, Math.max(head, Math.min(foot - h, foot - tall))],
    [meets, patchRowTop(foot - h, row)],
  ];
  const path: [number, number][] = [
    [0, patchRowTop(y0, row)],
    ...turns.filter(([at]) => at > 0 && at <= range),
    [range, patchRowTop(y0 - range, row)],
  ];
  return path.sort(([a], [b]) => a - b);
}

/**
 * Whether the chip `was` hangs as `now` does: at the same top, or both
 * following one box along one path, wherever the box was scrolled to when
 * each was measured, as the browser moves it along that path in between.
 * Points within a hundredth of a pixel are one: each layout measures the
 * row and the box's scroll position afresh, and they round a little apart.
 * A chip that starts or stops following has changed, at any top.
 */
function hangsAlike(was: Chip, now: Chip): boolean {
  if (was.follow === undefined || now.follow === undefined) {
    return was.follow === now.follow && was.top === now.top;
  }
  const path = now.follow.path;
  return (
    was.follow.box === now.follow.box &&
    was.follow.path.length === path.length &&
    was.follow.path.every(([at, top], i) => {
      const [nowAt, nowTop] = path[i] ?? [Number.NaN, Number.NaN];
      return Math.abs(at - nowAt) < 0.01 && Math.abs(top - nowTop) < 0.01;
    })
  );
}

/** Runs of removed text, which say where in the baseline they start. */
const OLD_RUNS = `[${OLD_FLAT_ATTR}], [${OLD_SOURCE_ATTR}]`;

/** A run of removed text, read once per layout: where it starts, how long. */
type OldRun = { el: Element; origin: TextOrigin; length: number };

function oldRunOf(el: Element): OldRun {
  const flat = el.getAttribute(OLD_FLAT_ATTR);
  return {
    el,
    origin:
      flat !== null
        ? { flat: Number(flat) }
        : { source: Number(el.getAttribute(OLD_SOURCE_ATTR)) },
    length: el.textContent?.length ?? 0,
  };
}

/**
 * Where an annotation on the baseline shows, found by its baseline position
 * as `blockForLine` finds a current one's block, and never by how it was
 * painted, which another annotation over the same text, or a block marked
 * whole, leaves without a key of its own: the first run of removed text one
 * of its `spans` covers, else the innermost block put back whole on the
 * first of its lines one reaches, else the wrapper of the first code row
 * showing one of its baseline lines, else the first of the `edited` code
 * blocks whose baseline lines it reaches, for a comparison that drew none of
 * those rows: both versions of a diagram, or the old diagram beside the
 * current source. Null when it reaches none of these. A code block's wrapper
 * is where the chip's group is decided; the row inside it the chip hangs by
 * is `layout`'s to find.
 */
function baselinePlace(
  annotation: DisplayedAnnotation,
  spans: SpanDecoration[],
  baseline: SegmentIndex,
  runs: OldRun[],
  restored: Array<{ el: Element; start: number; end: number }>,
  rows: () => PlacedRow[],
  edited: Array<{ el: Element; start: number; end: number }>,
): Element | null {
  const run = runs.find(({ origin, length }) =>
    spans.some((span) => coverageOf(origin, length, span, baseline).length > 0),
  );
  if (run !== undefined) return run.el;
  const reached = restored.filter((b) => rangesIntersect(b, annotation));
  if (reached.length > 0) {
    const line = Math.min(
      ...reached.map((b) => Math.max(annotation.start, b.start)),
    );
    // Blocks come in document order, an ancestor before what it holds, so
    // the last on a line is the innermost there (`blockForLine`).
    const block = reached.findLast((b) => b.start <= line && b.end >= line);
    if (block !== undefined) return block.el;
  }
  return (
    rows().find(
      ({ source: { line } }) =>
        line !== null && line >= annotation.start && line <= annotation.end,
    )?.source.wrapper ??
    edited.find((block) => rangesIntersect(block, annotation))?.el ??
    null
  );
}

/**
 * Each current code block that replaced one of the baseline, with the lines
 * that one spans there, its fence markers included; `fences` is what
 * `pairedFences` paired. Only code wrappers ask: a list item or a quote that
 * a code block opens starts on the same line, and would take the block's
 * notes away to a chip of its own.
 */
function editedFences(
  blocks: Array<{ el: Element; start: number }>,
  baseline: SegmentIndex,
  fences: ReadonlyMap<number, SourceFence>,
): Array<{ el: Element; start: number; end: number }> {
  return blocks.flatMap(({ el, start }) => {
    const old = el.hasAttribute(CODE_CONTENT_START_ATTR)
      ? fences.get(start)
      : undefined;
    const fence = old === undefined ? null : fenceAt(baseline, old.line);
    return fence === null
      ? []
      : [{ el, start: fence.line, end: fence.endLine }];
  });
}

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

/** Below 0 where `a` comes first in the document, an ancestor before what it holds. */
function documentOrder(a: Node, b: Node): number {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    ? -1
    : 1;
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
  baselineAnnotations = NO_ANNOTATIONS,
  changedRanges = NO_RANGES,
  foldUnchanged = false,
  onStage,
  onEditDraft,
  onRemoveDraft,
  onResolve,
  resolving = false,
  compareLabels,
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
  /**
   * Annotations on the compare baseline, at its lines and columns: they hang
   * on what the comparison shows of it, the removed content it puts back
   * and the context rows of a code block edited in place. Pass a stable
   * reference, as for `annotations`.
   */
  baselineAnnotations?: DisplayedAnnotation[];
  /** Lines changed since the compare baseline — green highlight + ↑↓ nav. */
  changedRanges?: LineRange[];
  /**
   * Fold the runs of blocks that carry nothing to review (T-222). Only ever
   * true for a rendered comparison of a file that has changes to fold around;
   * spec-view owns that judgement, and the reader's preference.
   */
  foldUnchanged?: boolean;
  /**
   * Stage a draft for the selected source range: of the viewed version, or
   * of the compare baseline where `baseline` says the selection was in what
   * the comparison put back of it.
   */
  onStage: (range: CompareAnchor) => void;
  /** Load a staged draft back into the composer for rewriting (T-159). */
  onEditDraft: (draft: SpecReviewDraft) => void;
  onRemoveDraft: (id: string) => void;
  onResolve: (commentId: number) => void;
  resolving?: boolean;
  /**
   * What a swapped image's two sides are called (T-722): the baseline and
   * the viewed version. Pass a stable object; this component is memoized.
   */
  compareLabels?: { before: string; after: string };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  /** The key of the chip whose popover is open, if one is. */
  const openChip = useRef<string | null>(null);
  const trackOpen = useCallback((key: string, open: boolean) => {
    if (open) openChip.current = key;
    else if (openChip.current === key) openChip.current = null;
  }, []);
  /**
   * Where each annotation's locate control scrolls to, by its key: the row
   * of code its first line shows on, where pierre drew one, else its block.
   * Its own, even when its chip joined another's. The hold that follows the
   * jump reads it again each time it puts the target back.
   */
  const placeOf = useRef(
    new Map<string, { block: HTMLElement; row: HTMLElement | null }>(),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(NO_FOLDS);
  const wide = useMediaQuery(SM_UP);
  const remarkPlugins = useMarkdownRemarkPlugins(slug, { document: true });
  const [popoverLayer, setPopoverLayer] = useState<HTMLElement | null>(null);
  // The ride-along layer the chips' popovers open in below `sm`: zero-sized
  // at the document's origin, so it scrolls with the page, and a containing
  // block for their `position: fixed` wrappers through its `translate`. On
  // `<body>`, like the popover layer's own portal, so the container's
  // selection and DOM lookups never see a thread. Made here rather than
  // rendered through a portal: tests that empty `<body>` before unmounting
  // would leave React a node to remove that is gone, while `remove()` does
  // not mind.
  useLayoutEffect(() => {
    const layer = document.createElement("div");
    layer.className = "absolute top-0 left-0 z-50 translate-0";
    document.body.append(layer);
    setPopoverLayer(layer);
    return () => layer.remove();
  }, []);

  const index = useMemo(() => buildSegmentIndex(body), [body]);
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
  // In the baseline's offsets: they paint the removed content only.
  const oldSpans = useMemo(() => {
    if (baselineIndex === null || baselineAnnotations.length === 0) {
      return NO_SPANS;
    }
    const anchored = baselineAnnotations.map(anchoredOf);
    return [
      ...annotationDecorations(baselineIndex, anchored),
      ...lineDecorations(baselineIndex, anchored),
    ];
  }, [baselineIndex, baselineAnnotations]);
  const decorations = useMemo(
    () =>
      mergeDecorations(
        { ...changes, baselineTree },
        annotationDecorations(index, annotations.map(anchoredOf)),
        oldSpans,
      ),
    [index, changes, baselineTree, annotations, oldSpans],
  );
  const fenceBaselines = useMemo(
    () =>
      baselineIndex === null ? undefined : pairedFences(baselineIndex, index),
    [baselineIndex, index],
  );
  const resolveSelection = useCallback(
    (container: Element, ends: SelectionEndpoints): CompareAnchor | null => {
      if (baselineIndex === null || fenceBaselines === undefined) {
        return anchorForSelection(container, index, ends);
      }
      return compareAnchorForSelection(
        container,
        index,
        baselineIndex,
        fenceBaselines,
        ends,
      );
    },
    [index, baselineIndex, fenceBaselines],
  );
  const { pending, clear } = useSelectionEntry(containerRef, resolveSelection);
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

  /** Each code row the comparison drew of its baseline, and where it sits. */
  const baselineCodeRows = useCallback(
    (container: Element): PlacedRow[] => {
      if (baselineIndex === null || fenceBaselines === undefined) return [];
      return [...container.querySelectorAll(CODE_WRAPPERS)].flatMap((wrapper) =>
        shadowRows(wrapper).flatMap((row) => {
          const source = baselineRowSource(baselineIndex, fenceBaselines, row);
          return source === null ? [] : [{ row, source }];
        }),
      );
    },
    [baselineIndex, fenceBaselines],
  );

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
    // Inside its block, a chip hangs by the row of code the annotation's
    // first line shows on, where pierre has drawn one, or by the line of text
    // on the page its first character is drawn on; else by the block's top.
    // A patch fence's files scroll in a box of their own, and a chip there
    // keeps beside that box: no higher than the block's top, and for a row
    // reaching past the box's foot no lower than a chip's height above it,
    // where a line below every row drawn hangs too. Each place is kept under
    // its block's key, and a row's or a line's under that key and where in
    // the source it starts, never where on the page, so that a layout moving
    // it keeps its key.
    type Place = {
      key: string;
      /**
       * The key of the block it is in. Places in a block put back of the
       * baseline join one another only; the current version's places join
       * across blocks.
       */
      block: string;
      /** Whether that block is one put back of the baseline. */
      old: boolean;
      /** That block's element, where the place sits in the document. */
      el: HTMLElement;
      top: number;
      items: DisplayedAnnotation[];
      follow?: Follow;
    };
    const places = new Map<string, Place>();
    const jumps = new Map<
      string,
      { block: HTMLElement; row: HTMLElement | null }
    >();
    /**
     * A place inside a block: a row of code, or a line of text; and how a
     * chip there moves as a box scrolls, where the browser moves it.
     */
    type Line = { key: string; top: number; follow?: Follow };
    const hang = (
      annotation: DisplayedAnnotation,
      block: { key: string; el: HTMLElement; old: boolean },
      line: Line | null,
      row: HTMLElement | null,
    ) => {
      const key = line?.key ?? block.key;
      const place = places.get(key);
      if (place !== undefined) place.items.push(annotation);
      else {
        places.set(key, {
          key,
          block: block.key,
          old: block.old,
          el: block.el,
          // The key still names the block the annotation belongs to; only
          // what gets measured moves when the reader shuts a fold over it.
          top: line?.top ?? chipTop(containerRect, visibleAnchor(block.el)),
          items: [annotation],
          follow: line?.follow,
        });
      }
      jumps.set(annotation.key, { block: block.el, row });
    };
    // A chip is drawn in rem, which the root element's font size sets, not
    // this text's; the reader may have set it to other than 16px.
    const tall = chipHeight(
      wide,
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    // Each patch fence's box, its foot and how far it scrolls, found once a
    // layout, and only where asked.
    const boxes = new Map<
      Element,
      { box: Element; foot: number; range: number }
    >();
    const boxOf = (wrapper: HTMLElement, row: HTMLElement) => {
      let found = boxes.get(wrapper);
      if (found === undefined) {
        const box = scrollBox(wrapper, row);
        found = {
          box,
          foot: box.getBoundingClientRect().bottom - containerRect.top,
          range: box.scrollHeight - box.clientHeight,
        };
        boxes.set(wrapper, found);
      }
      return found;
    };
    /**
     * A row of code as a place, keyed `prefix` and its source line; none
     * under a shut fold, where every row measures 0 and the chip follows the
     * fold up to its header, as its block's would. In a patch fence the chip
     * keeps to the box the row scrolls in, as `patchRowTop` says; and where
     * the browser can move it with the box, as the box scrolls, it does, in
     * the frame the rows move, however busy the page.
     */
    const rowLine = (
      prefix: string,
      wrapper: HTMLElement,
      { row, source }: PlacedRow,
    ): Line | null => {
      if (visibleAnchor(wrapper) !== wrapper) return null;
      const rect = row.getBoundingClientRect();
      const key = `${prefix}${source.line}`;
      const y = rect.top - containerRect.top;
      if (!wrapper.hasAttribute(FENCE_PATCH_ATTR)) return { key, top: y };
      const { box, foot, range } = boxOf(wrapper, row);
      const at = {
        h: rect.height,
        head: chipTop(containerRect, wrapper),
        foot,
        tall,
      };
      const top = patchRowTop(y, at);
      if (typeof ScrollTimeline !== "function" || range <= 0) {
        return { key, top };
      }
      const path = patchRowPath(y + box.scrollTop, range, at);
      return { key, top, follow: { box, path } };
    };
    /**
     * The first row, in document order, that shows one of an annotation's
     * `lines` in the code block `wrapper`, placed by `rows`; in a patch fence
     * too, whose chip `rowLine` keeps beside the box its rows scroll in.
     */
    const rowIn = (
      wrapper: HTMLElement,
      rows: () => PlacedRow[],
      lines: LineRange,
    ): PlacedRow | null =>
      !wrapper.matches(CODE_WRAPPERS)
        ? null
        : (rows().find(
            ({ source: { line } }) =>
              line !== null && line >= lines.start && line <= lines.end,
          ) ?? null);
    /**
     * The foot of the patch fence `wrapper`'s box as a place, keyed `key`,
     * for an annotation starting on line `start` that no row shows, when
     * every row pierre has drawn there, placed by `rows`, comes before it:
     * the box has not scrolled down to it yet. None where it has drawn no
     * row, or one after it: a line scrolled out above, or one no row shows
     * between two that are, hangs by the block.
     */
    const belowRows = (
      key: string,
      wrapper: HTMLElement,
      rows: () => PlacedRow[],
      start: number,
    ): Line | null => {
      if (
        !wrapper.hasAttribute(FENCE_PATCH_ATTR) ||
        visibleAnchor(wrapper) !== wrapper
      ) {
        return null;
      }
      const drawn = rows().filter(({ source }) => source.line !== null);
      const [first] = drawn;
      return first === undefined ||
        drawn.some(({ source: { line } }) => line !== null && line >= start)
        ? null
        : { key, top: boxOf(wrapper, first.row).foot - tall };
    };
    // Each text block lined up once a layout, and only where asked, with
    // what `firstLine` measures its first line by: the box its later lines
    // are measured from, and the height half a line is half of. Null where
    // it does not line up, or nothing has a box.
    const texts = new Map<
      Element,
      {
        at: (source: number) => Range | null;
        first: DOMRect;
        line: number;
      } | null
    >();
    /**
     * The line of the text block `block` that what `drawn` picks sits on, as
     * a place: as far below the block's top as it is below the box
     * `firstLine` measures the block's first line by, so that a chip keeps
     * from its line what the first line's keeps from it. Null on the first
     * line, which the block's own place stands for, and wherever nothing
     * measures, a shut fold's hidden body included. Less than half a line
     * below it, half the `line` `firstLine` gives, is still the first line:
     * inline code, a fallback font or an atom's box start a few pixels off
     * the text's.
     */
    const textLine = (
      block: { el: HTMLElement; start: number },
      key: string,
      drawn: (at: (source: number) => Range | null) => Range | Element | null,
    ): Line | null => {
      if (
        block.el.matches(CODE_WRAPPERS) ||
        visibleAnchor(block.el) !== block.el
      ) {
        return null;
      }
      let text = texts.get(block.el);
      if (text === undefined) {
        const at = rangeAtSource(index, block.el);
        const start = index.lineStarts[block.start - 1];
        const opening = at === null || start === undefined ? null : at(start);
        const measured = opening === null ? null : firstLine(block.el, opening);
        text =
          at === null || measured === null || measured.top.height === 0
            ? null
            : { at, first: measured.top, line: measured.line };
        texts.set(block.el, text);
      }
      const at = text === null ? null : drawn(text.at);
      if (
        text === null ||
        at === null ||
        shutAway(at instanceof Range ? at.startContainer : at)
      ) {
        return null;
      }
      const below = at.getBoundingClientRect().top - text.first.top;
      return below < text.line / 2
        ? null
        : { key, top: chipTop(containerRect, block.el) + below };
    };
    // Each wrapper's rows placed once a layout, and only where asked.
    const currentRows = new Map<Element, PlacedRow[]>();
    const rowsOf = (wrapper: Element) => () => {
      let rows = currentRows.get(wrapper);
      if (rows === undefined) {
        rows = shadowRows(wrapper).flatMap((row) => {
          const source = codeRowSource(index, row);
          return source === null ? [] : [{ row, source }];
        });
        currentRows.set(wrapper, rows);
      }
      return rows;
    };
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
      const block = blocks[at];
      if (block === undefined) continue;
      const key = `${block.start}-${block.end}`;
      const rows = rowsOf(block.el);
      const row = rowIn(block.el, rows, annotation);
      // Its first character; for whole lines, the first line's start, unless
      // that is the block's own first line or above it.
      const from =
        annotation.colStart != null
          ? offsetAt(index, annotation.start, annotation.colStart)
          : annotation.start > block.start
            ? (index.lineStarts[annotation.start - 1] ?? null)
            : null;
      hang(
        annotation,
        { key, el: block.el, old: false },
        row !== null
          ? rowLine(`${key}:L`, block.el, row)
          : (belowRows(`${key}:below`, block.el, rows, annotation.start) ??
              (from === null
                ? null
                : textLine(block, `${key}:@${from}`, (on) => on(from)))),
        row?.row ?? null,
      );
    }
    // An annotation on the baseline hangs where its text shows: on the
    // current block a removed word, a deleted code row or a context row of
    // an edited block sits in, sharing that block's chips, or on a restored
    // block, a marker or a removed table row, with chips of its own. One
    // with none of its text shown hangs nowhere.
    // A code block edited in place holds the notes on its baseline lines
    // that none of its rows shows, as when it draws two diagrams.
    const holders = [...container.querySelectorAll<HTMLElement>(OLD_HOLDER)];
    if (baselineIndex !== null && baselineAnnotations.length > 0) {
      const runs = [...container.querySelectorAll(OLD_RUNS)].map(oldRunOf);
      const restored = holders.flatMap((el) => {
        const loc = parseSourceLoc(el.getAttribute(OLD_LINE_ATTR));
        return loc === null ? [] : [{ el, ...loc }];
      });
      const spansByKey = new Map<string, SpanDecoration[]>();
      for (const span of oldSpans) {
        if (span.key === undefined) continue;
        spansByKey.set(span.key, [...(spansByKey.get(span.key) ?? []), span]);
      }
      let oldRows: PlacedRow[] | null = null;
      const rows = () => {
        oldRows ??= baselineCodeRows(container);
        return oldRows;
      };
      const edited =
        fenceBaselines === undefined
          ? []
          : editedFences(blocks, baselineIndex, fenceBaselines);
      for (const annotation of baselineAnnotations) {
        const put = baselinePlace(
          annotation,
          spansByKey.get(annotation.key) ?? [],
          baselineIndex,
          runs,
          restored,
          rows,
          edited,
        );
        const holder = put?.closest<HTMLElement>(
          `[${SOURCE_LINE_ATTR}], ${OLD_HOLDER}`,
        );
        if (put == null || holder == null) continue;
        const own = holders.indexOf(holder);
        const current = own >= 0 ? undefined : blocks[els.indexOf(holder)];
        if (own < 0 && current === undefined) continue;
        const key =
          current === undefined
            ? `old-${own}`
            : `${current.start}-${current.end}`;
        // Its rows of a code block are the baseline's, which only the wrapper
        // they were drawn in tells apart from another block's.
        const code = put instanceof HTMLElement ? put : null;
        const drawn = () =>
          rows().filter(({ source }) => source.wrapper === put);
        const row = code === null ? null : rowIn(code, drawn, annotation);
        // A run of removed text in a current block is measured where it is
        // drawn; in a block put back whole it would take the baseline's
        // source to line its text up, and it hangs by that block's top.
        const run =
          current !== undefined && put.matches(OLD_RUNS)
            ? put.hasAttribute(OLD_FLAT_ATTR)
              ? `f${put.getAttribute(OLD_FLAT_ATTR)}`
              : `s${put.getAttribute(OLD_SOURCE_ATTR)}`
            : null;
        hang(
          annotation,
          { key, el: holder, old: current === undefined },
          row !== null
            ? rowLine(`${key}:old-L`, holder, row)
            : ((code === null
                ? null
                : belowRows(
                    `${key}:old-below`,
                    code,
                    drawn,
                    annotation.start,
                  )) ??
                (current === undefined || run === null
                  ? null
                  : textLine(current, `${key}:old@${run}`, () => put))),
          row?.row ?? null,
        );
      }
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
    // Places top to bottom: one less than a chip's height below the last
    // kept would draw over it, and joins it instead. The current version's
    // places go in one pass, whatever block they are in, so a place joins
    // the chip of the block above it as readily as its own block's. A block
    // put back of the baseline joins only its own places here; further down,
    // `near` joins it to the nearest chip it would draw over.
    const byBlock = new Map<string, Place[]>();
    for (const place of places.values()) {
      const group = place.old ? place.block : "";
      byBlock.set(group, [...(byBlock.get(group) ?? []), place]);
    }
    // Less than a chip's height apart, two chips overlap; a hair less is
    // Firefox measuring two that only touch.
    const overlaps = (gap: number) => gap < tall - HAIR;
    const next: Chip[] = [];
    const oldChips: Chip[] = [];
    for (const group of byBlock.values()) {
      const kept: Chip[] = [];
      for (const place of group.sort((a, b) => a.top - b.top)) {
        const above = kept.at(-1);
        if (above !== undefined && overlaps(place.top - above.top)) {
          above.items = [...above.items, ...place.items];
          continue;
        }
        kept.push({
          blockKey: place.key,
          top: place.top,
          items: place.items,
          follow: place.follow,
        });
      }
      (group[0]?.old ? oldChips : next).push(...kept);
    }
    // Top to bottom, so that which chip one joins rests on where the chips
    // hang, not on the order their annotations came in; chips at one height
    // still go in that order, which picks whose key the joined chip keeps.
    // A chip it joins, a current one or a restored one above it, joins no
    // other after: every annotation stays less than a chip's height from
    // its own block.
    for (const chip of oldChips.sort((a, b) => a.top - b.top)) {
      // A block put back where other chips hang — first in a current
      // block, inside another restored one, under the same closed fold —
      // would draw its chip over them: it joins the nearest instead, and of
      // two as near the upper one.
      const off = (other: Chip) => Math.abs(other.top - chip.top);
      // Firefox can measure a block halfway between two chips nearer one of
      // them, the more the further down the page: up to 0.04px just past
      // 131,072px from the window's top. No reader can tell a chip 0.05px
      // nearer, so distances less than that apart are as near.
      const nearer = (a: Chip, b: Chip) =>
        Math.abs(off(a) - off(b)) < 0.05 ? a.top - b.top : off(a) - off(b);
      const near = next.filter((other) => overlaps(off(other))).sort(nearer)[0];
      if (near !== undefined) {
        near.items = [...near.items, ...chip.items];
        continue;
      }
      next.push(chip);
    }
    // A chip lists its notes in the order their places come on the page:
    // top to bottom, and at one height, as under a shut fold, in the
    // document's. So a chip lists what the chips it stands for would, one
    // after another, whichever joined which. In a block, a place less than
    // half a line below the top place of a line of text is on that line, at
    // that place's height: inline code is drawn a few pixels below the text
    // beside it, and in WebKit a removed word a hair below. On one line of
    // one block the baseline's notes go first, as the text they are on is
    // drawn before the text that replaced it, and as they were written
    // first: a version takes no notes once a newer one is pushed. Then each
    // version's go by the line of source they start on, and those starting
    // on one go in the order they were written, drafts last, as the lists
    // they came in hold them.
    const onBaseline = new Set(baselineAnnotations);
    const byEl = new Map<HTMLElement, Place[]>();
    for (const place of places.values()) {
      byEl.set(place.el, [...(byEl.get(place.el) ?? []), place]);
    }
    const lineOf = new Map<Place, number>();
    for (const [el, group] of byEl) {
      // Half a line is half the `line` `firstLine` gives, as `textLine`
      // takes it for the first line, but never more than half a chip: a
      // picture opening a block with nothing beside it is that line, and
      // half of it would take lines one chip joins for one. None where
      // nothing lined the block up, so that only places at one height share
      // a line there.
      const half = Math.min(texts.get(el)?.line ?? 0, tall) / 2;
      let line: number | undefined;
      for (const place of group.sort((a, b) => a.top - b.top)) {
        // From the line's top place, not the last one on it, so that places
        // in a row never string two lines into one.
        if (line === undefined || place.top - line >= half) line = place.top;
        lineOf.set(place, line);
      }
    }
    const lineTop = (place: Place) => lineOf.get(place) ?? place.top;
    const written = new Map(
      [...annotations, ...baselineAnnotations].map(
        (item, i) => [item, i] as const,
      ),
    );
    const rank = new Map(
      [...places.values()]
        .flatMap((place) => place.items.map((item) => ({ place, item })))
        .sort(
          (a, b) =>
            lineTop(a.place) - lineTop(b.place) ||
            documentOrder(a.place.el, b.place.el) ||
            Number(onBaseline.has(b.item)) - Number(onBaseline.has(a.item)) ||
            a.item.start - b.item.start ||
            (written.get(a.item) ?? 0) - (written.get(b.item) ?? 0),
        )
        .map(({ item }, i) => [item, i] as const),
    );
    for (const chip of next) {
      chip.items = chip.items.toSorted(
        (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
      );
    }
    placeOf.current = jumps;
    next.sort((a, b) => a.top - b.top);
    // Chip by chip, so that one chip moving re-renders that chip alone.
    setChips((prev) => {
      const before = new Map(prev.map((chip) => [chip.blockKey, chip]));
      // A chip goes on as the chip one of its annotations was in, under its
      // key, so that it stays mounted and its popover open however the place
      // it hangs at changed under it: the annotation that place was kept for
      // discarded, one joining from above, a fold shut over it. Of two that
      // join, it goes on as the one being read. A chip new to the page gets
      // a key of its own, never one a chip on the page goes on under.
      const heldIn = new Map(
        prev.flatMap((chip) =>
          chip.items.map((item) => [item.key, chip.blockKey] as const),
        ),
      );
      const reading = openChip.current;
      const taken = new Set<string>();
      const goesOn = next.map((fresh) => {
        const was = fresh.items.flatMap((item) => heldIn.get(item.key) ?? []);
        const key =
          reading !== null && was.includes(reading) && !taken.has(reading)
            ? reading
            : was.find((key) => !taken.has(key));
        if (key !== undefined) taken.add(key);
        return key;
      });
      const kept = next.map((fresh, i) => {
        let key = goesOn[i];
        if (key === undefined) {
          key = fresh.blockKey;
          while (taken.has(key)) key = `${key}+`;
          taken.add(key);
        }
        const chip =
          key === fresh.blockKey ? fresh : { ...fresh, blockKey: key };
        const old = before.get(chip.blockKey);
        return old !== undefined &&
          hangsAlike(old, chip) &&
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
  }, [
    annotations,
    baselineAnnotations,
    changedRanges,
    index,
    baselineIndex,
    oldSpans,
    baselineCodeRows,
    fenceBaselines,
    wide,
  ]);

  /**
   * The characters of code that column anchors cover, painted as ranges over
   * pierre's own rows (T-31 keeps marks out of a code block), and the rows
   * that anchors on whole lines cover, marked as such. Each row is placed in
   * the source by `codeRowSource`, the mapping a selection there is anchored
   * by, so what gets painted is what was selected; a row it cannot place
   * keeps its block's wash instead.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new set of decorations rewrites the wrappers' classes, taking the painted class off them
  const paintCode = useCallback(
    (container: HTMLElement): CodeHighlightRanges => {
      const ranges: CodeHighlightRanges = { comment: [], draft: [] };
      const marksOf = (on: SegmentIndex, items: DisplayedAnnotation[]) =>
        supportsCodeHighlights()
          ? items.flatMap((a) => {
              if (a.colStart == null || a.colEnd == null) return [];
              const start = offsetAt(on, a.start, a.colStart);
              const last = offsetAt(on, a.end, a.colEnd);
              if (start === null || last === null) return [];
              return [
                { key: a.key, kind: a.kind, start, end: last + 1, lines: a },
              ];
            })
          : [];
      const marks = marksOf(index, annotations);
      // Marked whatever the browser: an attribute needs no highlight API.
      const wholeLines = annotations.filter(
        (a) => (a.colStart ?? null) === null,
      );
      // The rows showing lines of the baseline, which annotations on it
      // paint the same way: every row of a block put back whole, the
      // deleted and the context rows of an edited one, the source of a
      // baseline diagram that does not parse. `baselineRowSource` places
      // them in the baseline.
      const old =
        baselineIndex === null || fenceBaselines === undefined
          ? null
          : { index: baselineIndex, fences: fenceBaselines };
      const oldMarks =
        old === null ? [] : marksOf(old.index, baselineAnnotations);
      const oldWholeLines =
        old === null
          ? []
          : baselineAnnotations.filter((a) => (a.colStart ?? null) === null);
      /** Paint one row placed at `source` with what covers it. */
      const paintRow = (
        row: Element,
        source: CodeRowSource | null,
        rowMarks: typeof marks,
        whole: DisplayedAnnotation[],
        wanted: Map<Element, LineMark>,
        painted: Set<string>,
      ) => {
        const line = source?.line ?? null;
        if (line !== null) {
          for (const a of whole) {
            if (line < a.start || line > a.end) continue;
            if (wanted.get(row) !== "comment") wanted.set(row, a.kind);
            painted.add(a.key);
          }
        }
        if (source === null || source.textStart === null) return;
        const rowEnd = source.textStart + rowText(row).length;
        for (const mark of rowMarks) {
          const from = Math.max(mark.start, source.textStart);
          const to = Math.min(mark.end, rowEnd);
          if (to <= from) continue;
          const range = rangeInRow(
            row,
            from - source.textStart,
            to - source.textStart,
          );
          if (range === null) continue;
          (mark.kind === "comment" ? ranges.comment : ranges.draft).push(range);
          painted.add(mark.key);
        }
      };
      for (const wrapper of container.querySelectorAll(CODE_WRAPPERS)) {
        const loc = parseSourceLoc(wrapper.getAttribute(SOURCE_LINE_ATTR));
        const oldLoc = parseSourceLoc(wrapper.getAttribute(OLD_LINE_ATTR));
        const body = codeBodyLines(index, wrapper);
        const here =
          loc === null
            ? []
            : marks.filter(
                (mark) =>
                  mark.lines.start <= loc.end && mark.lines.end >= loc.start,
              );
        const wholeHere =
          body === null
            ? []
            : wholeLines.filter((a) => rangesIntersect(a, body));
        const holdsOld =
          oldLoc !== null ||
          (loc !== null && fenceBaselines?.has(loc.start) === true);
        const oldHere = holdsOld ? oldMarks : [];
        const oldWholeHere = holdsOld ? oldWholeLines : [];
        const any =
          here.length +
            wholeHere.length +
            oldHere.length +
            oldWholeHere.length >
          0;
        // The wash steps aside only once every annotation reaching into the
        // block has something of its own painted here: characters for one on
        // columns, a row for one on whole lines. Rows that could not be
        // placed leave theirs with nothing.
        const painted = new Set<string>();
        for (const host of wrapper.querySelectorAll("diffs-container")) {
          const shadow = host.shadowRoot;
          if (shadow === null) continue;
          // One map for both versions' rows: `markRows` takes the mark off
          // every row it is not handed.
          const wanted = new Map<Element, LineMark>();
          for (const row of any ? shadow.querySelectorAll("[data-line]") : []) {
            paintRow(
              row,
              codeRowSource(index, row),
              here,
              wholeHere,
              wanted,
              painted,
            );
            if (old !== null && oldHere.length + oldWholeHere.length > 0) {
              paintRow(
                row,
                baselineRowSource(old.index, old.fences, row),
                oldHere,
                oldWholeHere,
                wanted,
                painted,
              );
            }
          }
          markRows(shadow, wanted);
        }
        const touching =
          oldLoc !== null
            ? baselineAnnotations.filter((a) => rangesIntersect(a, oldLoc))
            : body === null
              ? []
              : annotations.filter((a) => rangesIntersect(a, body));
        wrapper.classList.toggle(
          CODE_PAINTED_CLASS,
          touching.length > 0 && touching.every((a) => painted.has(a.key)),
        );
      }
      return ranges;
    },
    [
      annotations,
      baselineAnnotations,
      index,
      baselineIndex,
      fenceBaselines,
      decorations,
    ],
  );
  useCodeHighlights(containerRef, paintCode);

  useLayoutEffect(() => {
    layout();
    // A resize moves the chips; the entry's own recompute is the selection
    // layer's.
    window.addEventListener("resize", layout);
    // So does whatever changes the document's height with no resize: a
    // mermaid diagram taking its source's place, pierre drawing a block, an
    // image or a font arriving; and pierre drawing its rows again, which
    // need not change any height, while chips hang by those rows. Folded
    // into one layout per frame. The wash a layout toggles changes the
    // height once more, or has pierre draw again, and the next layout
    // toggles nothing, so it settles there.
    const container = containerRef.current;
    let frame: number | null = null;
    const schedule = () => {
      frame ??= requestAnimationFrame(() => {
        frame = null;
        layout();
      });
    };
    let observer: ResizeObserver | null = null;
    if (container !== null && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(container);
    }
    container?.addEventListener(CODE_RENDERED_EVENT, schedule);
    // A patch's files scrolling in their own box move the rows chips hang
    // by there, and nothing else: laid out and committed in the scroll
    // event's own task, so the chips move in the frame the rows do. State set
    // in a frame callback renders in a task after it, once that frame is
    // painted. `scroll` does not bubble, so the capture phase hears it; and
    // only a patch's, as a table or a block of code scrolling sideways moves
    // no chip.
    const scrolled = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest(`[${FENCE_PATCH_ATTR}]`) !== null
      ) {
        flushSync(layout);
      }
    };
    container?.addEventListener("scroll", scrolled, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("resize", layout);
      observer?.disconnect();
      container?.removeEventListener(CODE_RENDERED_EVENT, schedule);
      container?.removeEventListener("scroll", scrolled, { capture: true });
      if (frame !== null) cancelAnimationFrame(frame);
    };
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

  // The latest layout, for a jump that finds its row drawn again since the
  // last one ran; a ref, so that the jump stays one stable callback.
  const layoutRef = useRef(layout);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const keepHold = useOwnHold();
  /**
   * Jump to what a popover entry points at — its own mark, else its row of
   * code or its block — and hold it there. The hold looks it up again for
   * each placing, by the same rule: pierre replaces every row of a block it
   * draws again (highlighting arriving late, a theme change), the row jumped
   * to among them. A row is not flashed: the flash is styled outside
   * pierre's shadow root, and the row wears its annotation's tint already.
   */
  const flashAnnotation = useCallback(
    (annotation: DisplayedAnnotation) => {
      const find = () => {
        const container = containerRef.current;
        if (!container) return null;
        const mark = container.querySelector<HTMLElement>(
          `[${MARK_KEY_ATTR}="${annotation.key}"]`,
        );
        let place = placeOf.current.get(annotation.key);
        if (mark === null && place?.row != null && !place.row.isConnected) {
          layoutRef.current();
          place = placeOf.current.get(annotation.key);
        }
        const row = mark === null && place?.row?.isConnected ? place.row : null;
        const block = place?.block.isConnected ? place.block : null;
        const target = mark ?? row ?? block;
        return target === null ? null : { target, row, block };
      };
      const found = find();
      if (found === null) return;
      const { target, row, block } = found;
      // The walk up to a shut fold that `revealBlock` takes stops at pierre's
      // shadow root, so a row's folds are opened from its block.
      if (row !== null && block !== null) openEnclosingFolds(block);
      keepHold(
        glideToRevealed(() => find()?.target ?? null, {
          flash: target !== row,
        }),
      );
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
      // The gutter holds the chips and the mouse's "Comment Lx" button, and
      // only from `sm` up: below it the text takes the width and the chips
      // ride on the border of the card around it.
      className="relative sm:pr-10"
      onClick={onClick}
      data-testid="annotated-markdown"
    >
      {/* Always the provider, never only when there are labels: a wrapper
          that came and went would remount the document under it (T-60). */}
      <CompareLabelsContext.Provider
        value={compareLabels ?? DEFAULT_COMPARE_LABELS}
      >
        <CompareViewerProvider slug={slug} issueNumber={issueNumber}>
          <MarkdownViewWithPlugins
            slug={slug}
            issueNumber={issueNumber}
            rehypePlugins={rehypePlugins}
            fenceBaselines={fenceBaselines}
            collapseLongFences={false}
            document
            remarkPlugins={remarkPlugins}
          >
            {body}
          </MarkdownViewWithPlugins>
        </CompareViewerProvider>
      </CompareLabelsContext.Provider>

      {chips.map((chip) => (
        <AnnotationChip
          key={chip.blockKey}
          slug={slug}
          issueNumber={issueNumber}
          chip={chip}
          onOpen={trackOpen}
          onFlash={flashAnnotation}
          onEditDraft={onEditDraft}
          onRemoveDraft={onRemoveDraft}
          onResolve={onResolve}
          resolving={resolving}
          wide={wide}
          popoverLayer={popoverLayer}
        />
      ))}

      <SelectionEntry pending={pending} clear={clear} onStage={onStage}>
        {pending !== null && <CommentEntryLabel anchor={pending} />}
      </SelectionEntry>
    </div>
  );
});

const AnnotationChip = memo(function AnnotationChip({
  slug,
  issueNumber,
  chip,
  onOpen,
  onFlash,
  onEditDraft,
  onRemoveDraft,
  onResolve,
  resolving,
  wide,
  popoverLayer,
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
  /** Told when the chip's popover opens or closes, by the chip's key. */
  onOpen: (key: string, open: boolean) => void;
  onFlash: (annotation: DisplayedAnnotation) => void;
  onEditDraft: (draft: SpecReviewDraft) => void;
  onRemoveDraft: (id: string) => void;
  onResolve: (commentId: number) => void;
  resolving: boolean;
  /** At least `sm`: the chip sits in the gutter. */
  wide: boolean;
  /** Where the popover opens below `sm`; see `AnnotatedMarkdown`. */
  popoverLayer: HTMLElement | null;
}) {
  const draftCount = chip.items.filter((i) => i.kind === "draft").length;
  const triggerRef = useRef<HTMLButtonElement>(null);
  // A chip that follows a box as it scrolls is the browser's to move, on the
  // box's scroll timeline. Its keyframes go from the chip's own top, which
  // the layout that made it measured with the box scrolled where it was
  // then. `transform` is theirs alone: below `sm` the chip's sideways shift
  // is `translate`, which adds to it.
  useLayoutEffect(() => {
    const follow = chip.follow;
    const el = triggerRef.current;
    if (follow === undefined || el === null) return;
    const range = follow.path.at(-1)?.[0] ?? 0;
    const animation = el.animate(
      follow.path.map(([at, top]) => ({
        offset: at / range,
        transform: `translateY(${top - chip.top}px)`,
      })),
      { timeline: new ScrollTimeline({ source: follow.box }), fill: "both" },
    );
    return () => animation.cancel();
  }, [chip.follow, chip.top]);
  const locate = (item: DisplayedAnnotation) => (
    <button
      type="button"
      className="cursor-pointer hover:underline"
      title="Scroll to what this points at"
      onClick={() => onFlash(item)}
    >
      {labelOf(item)}
    </button>
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [alignOffset, setAlignOffset] = useState(0);
  // Below `sm` the popover opens centred on the visible part of the screen,
  // but with its top no lower than the chip's and its bottom no higher, so
  // it always spans the chip's row. Worked out as it opens, and again only
  // when its own size changes: a thread resolved, or the width settling once
  // Radix knows the room left of the chip. Never on scroll: from where it
  // opened it rides with the page.
  useLayoutEffect(() => {
    if (wide || !open) return;
    const trigger = triggerRef.current;
    const content = contentRef.current;
    if (trigger === null || content === null) return;
    const place = () => {
      // The height the cap leaves it, not the whole thread's.
      const height = content.offsetHeight;
      const at = trigger.getBoundingClientRect();
      // Undefined, not the null the DOM types admit, where there is no API.
      const view = window.visualViewport;
      const middle =
        view == null
          ? window.innerHeight / 2
          : view.offsetTop + view.height / 2;
      const top = Math.min(
        at.top,
        Math.max(middle - height / 2, at.bottom - height),
      );
      setAlignOffset(top - at.top);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(content);
    return () => observer.disconnect();
  }, [wide, open]);
  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        onOpen(chip.blockKey, next);
      }}
    >
      {/* Below `sm` the chip is a count badge centred on the card's right
          border, `--spec-card-inset` past the text's edge (0 where nothing
          sets it), and opaque, so the border does not run through it: the
          same tint, laid over the page's background. Its 1.5rem height, and
          from `sm` up its line, padding and border, are also `chipHeight`'s:
          change one, change the other. */}
      <PopoverTrigger
        ref={triggerRef}
        data-annotation-ui=""
        className={cn(
          "absolute right-0 inline-flex cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs tabular-nums shadow-sm",
          // 2px a side below `sm` keeps 1 to 99 notes in the 1.5rem circle.
          "max-sm:right-[calc(var(--spec-card-inset,0px)*-1)] max-sm:h-6 max-sm:min-w-6 max-sm:translate-x-1/2 max-sm:justify-center max-sm:px-0.5 max-sm:py-0",
          draftCount > 0
            ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-700 max-sm:bg-[color-mix(in_srgb,var(--color-indigo-500)_10%,var(--background))] dark:text-indigo-400"
            : "border-amber-500/60 bg-amber-500/10 text-amber-700 max-sm:bg-[color-mix(in_srgb,var(--color-amber-500)_10%,var(--background))] dark:text-amber-400",
        )}
        style={{ top: chip.top }}
        aria-label={`${chip.items.length} comment${chip.items.length === 1 ? "" : "s"}`}
      >
        <MessageSquareTextIcon className="size-3.5 max-sm:hidden" />
        {chip.items.length}
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        side="left"
        // From `sm` up, the one layout that handles collisions (below): a
        // thread belongs beside its chip. The popover layer's "always"
        // keeps the surface on screen after the chip has scrolled away, which
        // pins it to the viewport edge over unrelated text; "partial" still
        // pushes it back while part of the chip shows, then lets it follow.
        sticky="partial"
        // Radix moves its `position: fixed` wrapper from the page's scroll
        // events, which reach the main thread a frame or more after the
        // browser has scrolled the page: a popover beside its chip trails it.
        // Below `sm` the ride-along layer is the wrapper's containing block,
        // so the browser scrolls the popover with the text. With collisions
        // off, where it sits depends on the chip alone, so what Floating UI
        // works out on scroll is where it already is, and a popover leaving
        // the screen is neither pushed back nor flipped to the chip's other
        // side. From `sm` up `shift` holds a tall popover still on screen; in
        // the layer it would ride a frame with the text before being pulled
        // back each time, so that layout keeps the `<body>` portal.
        container={wide ? null : popoverLayer}
        avoidCollisions={wide}
        alignOffset={wide ? 0 : alignOffset}
        // One `min()` for the cap: `cn()` keeps a single `max-h-*`, so a
        // second one here would drop the popover layer's viewport cap. From
        // `sm` up the Radix variable is the room Floating UI leaves the
        // popover beside its chip, never more than the viewport. Below it
        // nothing a scroll changes sizes the popover: the cap is the small
        // viewport's height, the one with the browser's bars out, and the
        // width the room left of the chip, which a vertical scroll keeps.
        // `transition-none`: the layer's `duration-100` also eases
        // `max-height`, which then trails that room as the page scrolls.
        className={cn(
          "w-96 space-y-3 overflow-y-auto transition-none",
          wide
            ? "max-h-[min(24rem,var(--radix-popover-content-available-height,calc(100dvh-1rem)))] max-w-[calc(100vw-2rem)]"
            : "max-h-[min(24rem,calc(100svh-1rem))] max-w-[var(--radix-popover-content-available-width,calc(100vw-2rem))]",
        )}
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
            <div
              key={item.key}
              className={cn("rounded-md border p-2 text-sm", COMMENT_SURFACE)}
            >
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
                      className="text-green-700 dark:text-green-400"
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
