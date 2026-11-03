import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Character-precise marks on code, which pierre draws inside shadow roots of
 * its own where no `<mark>` can be injected (T-31): a block's contents are
 * pierre's, and an element wrapped around their text would be torn out on
 * pierre's next render. The CSS Custom Highlight API paints DOM ranges
 * without touching the DOM, so the comments and drafts anchored to columns
 * of a code line are painted as ranges over pierre's own text nodes.
 *
 * The registry is page-wide, because the browser's is: `CSS.highlights` holds
 * one highlight per name. Each surface that paints — the rendered document,
 * the source of one version, the source diff — registers its ranges under
 * an owner of its own, and the two named highlights are rebuilt from every
 * owner's, so one surface unmounting takes only its own ranges away.
 */

export type CodeHighlightRanges = { comment: Range[]; draft: Range[] };

/** Fired, bubbling, on a pierre host each time it has drawn its rows. */
export const CODE_RENDERED_EVENT = "todou:code-rendered";

const COMMENT_HIGHLIGHT = "spec-comment";
const DRAFT_HIGHLIGHT = "spec-draft";

/** What covers a whole row: a comment outranks a draft, as below. */
export type LineMark = "comment" | "draft";

/**
 * Worn by one of pierre's rows, and by its line number, while an annotation
 * anchored to whole lines covers it. A highlight paints glyphs only, so a
 * blank line, the space past a line's text and its number would stay bare,
 * and a whole line painted that way would read like a triple-click's columns.
 */
export const LINE_MARK_ATTR = "data-spec-line";

/**
 * The marks, as each pierre surface's `unsafeCSS`: a `::highlight()` rule
 * only reaches text in the tree its stylesheet belongs to, and a rule on
 * `LINE_MARK_ATTR` only rows in that tree. The colours are the prose marks'
 * (`mark.spec-mark-*` in styles.css); custom properties inherit into a
 * shadow root, so the same variables serve. A marked row's tint is an image
 * laid over pierre's own background colour, so an added or deleted line
 * keeps its green or red under it, and a selected one its selection.
 */
export const CODE_HIGHLIGHT_CSS = `
::highlight(${COMMENT_HIGHLIGHT}) {
  background-color: color-mix(in oklab, var(--color-amber-500) 30%, transparent);
}
::highlight(${DRAFT_HIGHLIGHT}) {
  background-color: color-mix(in oklab, var(--color-indigo-500) 26%, transparent);
}
:is([data-line], [data-column-number])[${LINE_MARK_ATTR}="comment"] {
  --spec-line-tint: color-mix(in oklab, var(--color-amber-500) 12%, transparent);
  background-image: linear-gradient(var(--spec-line-tint), var(--spec-line-tint));
}
:is([data-line], [data-column-number])[${LINE_MARK_ATTR}="draft"] {
  --spec-line-tint: color-mix(in oklab, var(--color-indigo-500) 12%, transparent);
  background-image: linear-gradient(var(--spec-line-tint), var(--spec-line-tint));
}
`;

const NO_ROWS: ReadonlyMap<Element, LineMark> = new Map();

/**
 * Mark the rows of `root` that `wanted` names, each with the kind covering
 * it, and their line numbers with them; take the mark off every other row
 * and number there. `root` is one tree of rows, a pierre host's shadow root
 * or the light DOM around one, and `wanted` holds rows of that tree. pierre
 * draws the numbers as a column of their own, each sharing its row's line
 * index. An attribute is only written where its value changes, since each
 * write restyles the row.
 */
export function markRows(
  root: ParentNode,
  wanted: ReadonlyMap<Element, LineMark> = NO_ROWS,
): void {
  const marked = root.querySelectorAll(`[${LINE_MARK_ATTR}]`);
  if (wanted.size === 0 && marked.length === 0) return;
  const next = new Map(wanted);
  if (wanted.size > 0) {
    const numbers = new Map<string, Element[]>();
    for (const cell of root.querySelectorAll("[data-column-number]")) {
      const index = cell.getAttribute("data-line-index");
      if (index === null) continue;
      numbers.set(index, [...(numbers.get(index) ?? []), cell]);
    }
    for (const [row, kind] of wanted) {
      const index = row.getAttribute("data-line-index");
      if (index === null) continue;
      for (const cell of numbers.get(index) ?? []) next.set(cell, kind);
    }
  }
  for (const el of marked) {
    if (!next.has(el)) el.removeAttribute(LINE_MARK_ATTR);
  }
  for (const [el, kind] of next) {
    if (el.getAttribute(LINE_MARK_ATTR) !== kind) {
      el.setAttribute(LINE_MARK_ATTR, kind);
    }
  }
}

/** Baseline 2025; elsewhere code keeps its whole-block wash. */
export function supportsCodeHighlights(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight === "function"
  );
}

const owners = new Map<object, CodeHighlightRanges>();

function rebuild(): void {
  const comment = [...owners.values()].flatMap((owned) => owned.comment);
  const draft = [...owners.values()].flatMap((owned) => owned.draft);
  for (const [name, ranges, priority] of [
    // A comment outranks a draft where the two overlap, as the whole-block
    // classes do (`markBlockClass`).
    [COMMENT_HIGHLIGHT, comment, 1],
    [DRAFT_HIGHLIGHT, draft, 0],
  ] as const) {
    if (ranges.length === 0) {
      CSS.highlights.delete(name);
      continue;
    }
    // Added one by one: spread into the constructor, tens of thousands of
    // ranges (column comments across long files) overflow the call stack.
    const highlight = new Highlight();
    for (const range of ranges) highlight.add(range);
    highlight.priority = priority;
    CSS.highlights.set(name, highlight);
  }
}

/** Replace what `owner` paints. A no-op where the API is missing. */
export function setCodeHighlights(
  owner: object,
  ranges: CodeHighlightRanges,
): void {
  if (!supportsCodeHighlights()) return;
  owners.set(owner, ranges);
  rebuild();
}

/** Take away everything `owner` paints. */
export function clearCodeHighlights(owner: object): void {
  if (!supportsCodeHighlights()) return;
  if (owners.delete(owner)) rebuild();
}

/**
 * Tell the surface around a pierre host that its rows were drawn again: every
 * render replaces the text nodes the last ranges were built on.
 */
export function announceCodeRendered(
  node: HTMLElement,
  phase?: "mount" | "update" | "unmount",
): void {
  if (phase === "unmount") return;
  node.dispatchEvent(new CustomEvent(CODE_RENDERED_EVENT, { bubbles: true }));
}

/**
 * Keep the ranges `paint` computes for the code under `containerRef`
 * registered: now, whenever `paint` changes (what is annotated did), after
 * each pierre render inside the container — a scroll that brings a patch's
 * next file into view, unmodified lines expanded, a theme switch — and when a
 * `<details>` opens or shuts. Renders arrive in bursts, one per item, so they
 * are folded into one pass per frame.
 */
export function useCodeHighlights(
  containerRef: RefObject<HTMLElement | null>,
  paint: (container: HTMLElement) => CodeHighlightRanges,
): void {
  const owner = useRef<object>({}).current;
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let frame: number | null = null;
    const run = () => {
      frame = null;
      setCodeHighlights(owner, paint(container));
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(run);
    };
    run();
    container.addEventListener(CODE_RENDERED_EVENT, schedule);
    // `toggle` does not bubble; capture hears every `<details>` below.
    container.addEventListener("toggle", schedule, true);
    return () => {
      container.removeEventListener(CODE_RENDERED_EVENT, schedule);
      container.removeEventListener("toggle", schedule, true);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [containerRef, paint, owner]);
  useEffect(() => () => clearCodeHighlights(owner), [owner]);
}
