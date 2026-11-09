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
  type CodeHighlightRanges,
  type LineMark,
  markRows,
  supportsCodeHighlights,
  useCodeHighlights,
} from "@/lib/code-highlights.ts";
import {
  type CodeRowSource,
  codeBodyLines,
  codeRowSource,
  oldCodeRowSource,
} from "@/lib/code-rows.ts";
import {
  type CompareAnchor,
  compareAnchorForSelection,
} from "@/lib/compare-anchor.ts";
import { rangeInRow, rowText } from "@/lib/pierre-rows.ts";
import {
  coverageOf,
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
  OLD_FLAT_ATTR,
  OLD_LINE_ATTR,
  OLD_SOURCE_ATTR,
  parseSourceLoc,
  rehypeSourceLines,
  SOURCE_LINE_ATTR,
} from "@/lib/rehype-source-lines.ts";
import { holdRevealed, revealBlock, useOwnHold } from "@/lib/scroll-insets.ts";
import { anchorForSelection, OLD_CODE_BLOCK } from "@/lib/selection-anchor.ts";
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
  blockKey: string;
  top: number;
  items: DisplayedAnnotation[];
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
 * annotation on it hangs its chip on: a restored block, or a marker.
 */
const OLD_HOLDER = `[${OLD_LINE_ATTR}], .spec-del-block`;

/** The wrappers of the code blocks pierre draws rows in, old ones included. */
const CODE_WRAPPERS = `[${CODE_CONTENT_START_ATTR}], ${OLD_CODE_BLOCK}`;

/**
 * How tall `AnnotationChip` draws a chip, so how close two can sit before
 * they overlap: from `sm` up a 16px line, 2px padding and a 1px border, top
 * and bottom; below it a 24px count badge (`max-sm:h-6`).
 */
function chipHeight(wide: boolean): number {
  return wide ? 22 : 24;
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
 * Where an annotation on the baseline was put back, found by its baseline
 * position as `blockForLine` finds a current one's block, and never by how
 * it was painted, which another annotation over the same text, or a block
 * marked whole, leaves without a key of its own: the first run of removed
 * text one of its `spans` covers, else the innermost block put back whole
 * on the first of its lines one reaches, else the first code row of the
 * baseline on its lines. Null when none of it was put back.
 */
function baselinePlace(
  annotation: DisplayedAnnotation,
  spans: SpanDecoration[],
  baseline: SegmentIndex,
  runs: OldRun[],
  restored: Array<{ el: Element; start: number; end: number }>,
  rows: () => CodeRowSource[],
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
      (row) =>
        row.line !== null &&
        row.line >= annotation.start &&
        row.line <= annotation.end,
    )?.wrapper ?? null
  );
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
   * on the removed content the comparison puts back of it. Pass a stable
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
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  /** The element each chip of a baseline annotation hangs on, by its key. */
  const oldChipEls = useRef(new Map<string, HTMLElement>());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(NO_FOLDS);
  const wide = useMediaQuery(SM_UP);
  const remarkPlugins = useMarkdownRemarkPlugins(slug);

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

  /** Where each code row the comparison drew of its baseline sits there. */
  const baselineCodeRows = useCallback(
    (container: Element): CodeRowSource[] => {
      if (baselineIndex === null || fenceBaselines === undefined) return [];
      return [...container.querySelectorAll(CODE_WRAPPERS)].flatMap((wrapper) =>
        [...wrapper.querySelectorAll("diffs-container")].flatMap((host) =>
          [...(host.shadowRoot?.querySelectorAll("[data-line]") ?? [])]
            .map((row) => oldCodeRowSource(baselineIndex, fenceBaselines, row))
            .filter((source) => source !== null),
        ),
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
    // An annotation on the baseline hangs where its text was put back: on
    // the current block a removed word or a deleted code row sits in,
    // sharing that block's chip, or on a restored block or a marker, with
    // a chip of its own. One with none of its text put back hangs nowhere.
    const holders = [...container.querySelectorAll<HTMLElement>(OLD_HOLDER)];
    const oldGrouped = new Map<number, DisplayedAnnotation[]>();
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
      let oldRows: CodeRowSource[] | null = null;
      const rows = () => {
        oldRows ??= baselineCodeRows(container);
        return oldRows;
      };
      for (const annotation of baselineAnnotations) {
        const put = baselinePlace(
          annotation,
          spansByKey.get(annotation.key) ?? [],
          baselineIndex,
          runs,
          restored,
          rows,
        );
        const holder = put?.closest(`[${SOURCE_LINE_ATTR}], ${OLD_HOLDER}`);
        if (holder == null) continue;
        const own = holders.indexOf(holder as HTMLElement);
        if (own >= 0) {
          oldGrouped.set(own, [...(oldGrouped.get(own) ?? []), annotation]);
          continue;
        }
        const at = els.indexOf(holder as HTMLElement);
        if (at >= 0) grouped.set(at, [...(grouped.get(at) ?? []), annotation]);
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
    oldChipEls.current = new Map();
    for (const [at, items] of oldGrouped) {
      const el = holders[at];
      if (el === undefined) continue;
      const top = chipTop(containerRect, visibleAnchor(el));
      // A block put back where another chip hangs — first in a current
      // block, inside another restored one, under the same closed fold —
      // would draw its chip over that one: it joins it instead.
      const near = next.find(
        (chip) => Math.abs(chip.top - top) < chipHeight(wide),
      );
      if (near !== undefined) {
        near.items = [...near.items, ...items];
        continue;
      }
      const blockKey = `old-${at}`;
      oldChipEls.current.set(blockKey, el);
      next.push({ blockKey, top, items });
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
  }, [
    annotations,
    baselineAnnotations,
    changedRanges,
    index,
    baselineIndex,
    oldSpans,
    baselineCodeRows,
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
      // The baseline's own rows, which annotations on it paint the same way:
      // every row of a block put back whole, the deleted rows of an edited
      // one. `oldCodeRowSource` places them in the baseline.
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
                oldCodeRowSource(old.index, old.fences, row),
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
    // image or a font arriving. Folded into one layout per frame. The wash
    // a layout toggles changes the height once more, and the next layout
    // toggles nothing, so it settles there.
    const container = containerRef.current;
    let frame: number | null = null;
    let observer: ResizeObserver | null = null;
    if (container !== null && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        frame ??= requestAnimationFrame(() => {
          frame = null;
          layout();
        });
      });
      observer.observe(container);
    }
    return () => {
      window.removeEventListener("resize", layout);
      observer?.disconnect();
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
        ) ??
        oldChipEls.current.get(blockKey) ??
        null;
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
      // The gutter holds the chips and the mouse's "Comment Lx" button, and
      // only from `sm` up: below it the text takes the width and the chips
      // ride on the border of the card around it.
      className="relative sm:pr-10"
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
          wide={wide}
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
  onFlash,
  onEditDraft,
  onRemoveDraft,
  onResolve,
  resolving,
  wide,
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
  /** At least `sm`: the chip sits in the gutter and opens to its left. */
  wide: boolean;
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
      {/* Below `sm` the chip is a count badge centred on the card's right
          border, `--spec-card-inset` past the text's edge (0 where nothing
          sets it), and opaque, so the border does not run through it: the
          same tint, laid over the page's background. Its 24px height is
          also `chipHeight`'s: change one, change the other. */}
      <PopoverTrigger
        data-annotation-ui=""
        className={cn(
          "absolute right-0 inline-flex cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs shadow-sm",
          "max-sm:right-[calc(var(--spec-card-inset,0px)*-1)] max-sm:h-6 max-sm:min-w-6 max-sm:translate-x-1/2 max-sm:justify-center max-sm:py-0",
          draftCount > 0
            ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-700 max-sm:bg-[color-mix(in_srgb,var(--color-indigo-500)_10%,var(--background))] dark:text-indigo-400"
            : "border-amber-500/60 bg-amber-500/10 text-amber-700 max-sm:bg-[color-mix(in_srgb,var(--color-amber-500)_10%,var(--background))] dark:text-amber-400",
        )}
        style={{ top: chip.top }}
        aria-label={`${chip.items.length} comment(s) on this block`}
      >
        <MessageSquareTextIcon className="size-3.5 max-sm:hidden" />
        {chip.items.length}
      </PopoverTrigger>
      <PopoverContent
        side={wide ? "left" : "bottom"}
        align={wide ? "start" : "end"}
        // A thread belongs to its chip's block. The popover layer's "always"
        // keeps the surface on screen after the chip has scrolled away, which
        // pins it to the viewport edge over unrelated text; "partial" still
        // pushes it back while part of the chip shows, then lets it follow.
        sticky="partial"
        className="max-h-96 w-96 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto"
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
