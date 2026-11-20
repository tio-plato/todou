import { type RefObject, useEffect, useRef, useState } from "react";
import { visibleAnchor } from "@/components/spec/annotated-markdown.tsx";
import {
  FOLD_CLASS,
  FOLD_KEY_ATTR,
  FOLDED_CLASS,
  keyLines,
} from "@/lib/rehype-fold-unchanged.ts";
import { parseSourceLoc, SOURCE_LINE_ATTR } from "@/lib/rehype-source-lines.ts";
import type { RevealMode } from "@/lib/scroll-insets.ts";
import { usableViewport } from "@/lib/scroll-insets.ts";
import { activeHeading, type OutlineHeading } from "@/lib/spec-outline.ts";
import { useLayoutTick } from "@/lib/use-layout-tick.ts";
import { cn } from "@/lib/utils.ts";

/** How the page lands on what it was asked to show: its `flashTo`. */
export type Land = (
  target: HTMLElement,
  mode?: RevealMode,
  highlight?: boolean,
) => void;

const HEADING_SELECTOR = ["h1", "h2", "h3", "h4", "h5", "h6"]
  .map((tag) => `${tag}[${SOURCE_LINE_ATTR}]`)
  .join(", ");

/** The rendered document inside the page's content, when one is drawn. */
export function renderedDocumentIn(
  root: HTMLElement | null,
): HTMLElement | null {
  return (
    root?.querySelector<HTMLElement>('[data-testid="annotated-markdown"]') ??
    null
  );
}

/** Each rendered heading by its first source line. */
export function headingsByLine(doc: HTMLElement): Map<number, HTMLElement> {
  const byLine = new Map<number, HTMLElement>();
  for (const el of doc.querySelectorAll<HTMLElement>(HEADING_SELECTOR)) {
    const loc = parseSourceLoc(el.getAttribute(SOURCE_LINE_ATTR));
    if (loc !== null && !byLine.has(loc.start)) byLine.set(loc.start, el);
  }
  return byLine;
}

/** The fold placeholder standing in for the blocks that hold `line`. */
export function foldOver(doc: HTMLElement, line: number): HTMLElement | null {
  for (const button of doc.querySelectorAll<HTMLElement>(`.${FOLD_CLASS}`)) {
    const lines = keyLines(button.getAttribute(FOLD_KEY_ATTR) ?? "");
    if (lines !== null && lines.start <= line && line <= lines.end) {
      return button;
    }
  }
  return null;
}

/**
 * What stands on screen for an element of the document: itself, the fold
 * placeholder hiding it, or the closed `<details>` around it. A folded or
 * closed one has no box of its own to measure.
 */
export function shownFor(
  doc: HTMLElement,
  el: HTMLElement,
  line: number,
): HTMLElement | null {
  if (el.closest(`.${FOLDED_CLASS}`) !== null) return foldOver(doc, line);
  return visibleAnchor(el);
}

/**
 * Take the reader to the heading on `line`. One a fold hides is opened first,
 * by its own placeholder, the way the reader would open it, and measured a
 * frame later, once it has a box; a closed `<details>` around one is
 * `revealBlock`'s to open. It lands under the toolbar, unflashed.
 */
export function jumpToHeading(
  root: HTMLElement | null,
  line: number,
  land: Land,
): void {
  const doc = renderedDocumentIn(root);
  if (doc === null) return;
  const heading = headingsByLine(doc).get(line);
  if (heading === undefined) return;
  if (heading.closest(`.${FOLDED_CLASS}`) === null) {
    land(heading, "start", false);
    return;
  }
  foldOver(doc, line)?.click();
  requestAnimationFrame(() => {
    // Opening the fold re-renders the document, which may have replaced the
    // element as well as given it a box.
    const opened = headingsByLine(doc).get(line);
    if (opened !== undefined) land(opened, "start", false);
  });
}

/**
 * The section the reader is in, measured against the rendered document every
 * time what is on screen may have moved. Its own state, held by the outline
 * alone: held by the page, every heading scrolled past would re-render the
 * document and every chip on it (T-601).
 */
function useActiveHeading(
  headings: OutlineHeading[],
  contentRef: RefObject<HTMLElement | null>,
): number {
  const [active, setActive] = useState(0);
  useLayoutTick(contentRef, () => {
    const doc = renderedDocumentIn(contentRef.current);
    if (doc === null || headings.length === 0) return;
    const byLine = headingsByLine(doc);
    const tops = headings.map(({ line }) => {
      const el = byLine.get(line);
      const shown = el === undefined ? null : shownFor(doc, el, line);
      return shown === null ? null : shown.getBoundingClientRect().top;
    });
    const usable = usableViewport();
    const page = document.documentElement;
    const atBottom =
      window.scrollY + window.innerHeight >= page.scrollHeight - 1;
    const next = activeHeading(
      tops,
      usable.top + 0.3 * usable.height,
      atBottom ? usable.top + usable.height : null,
    );
    setActive((prev) => (prev === next ? prev : next));
  }, [headings]);
  return active;
}

/** The nearest box around `el` that scrolls it, if any does. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let up = el.parentElement; up !== null; up = up.parentElement) {
    const { overflowY } = getComputedStyle(up);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      up.scrollHeight > up.clientHeight
    ) {
      return up;
    }
  }
  return null;
}

/**
 * Scroll the outline's own box until `row` shows. Not `scrollIntoView`, which
 * scrolls every box around it that can, and would move the page under a
 * rail that shows only part of itself.
 */
function keepInView(row: HTMLElement): void {
  const scroller = scrollerOf(row);
  if (scroller === null) return;
  const box = scroller.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const margin = 8;
  if (rect.top < box.top + margin) {
    scroller.scrollTop -= box.top + margin - rect.top;
  } else if (rect.bottom > box.bottom - margin) {
    scroller.scrollTop += rect.bottom - (box.bottom - margin);
  }
}

/**
 * The selected file's headings, beside the document from lg up and under the
 * file list in the Files popover below it (T-234). Four columns, laid out
 * across every row at once, so a count lines up with the counts above it
 * whatever the rows around it hold: the heading, then the open comments, the
 * drafts and the lines changed. A column empty on every row takes no width.
 */
export function SpecOutline({
  headings,
  contentRef,
  onJump,
}: {
  headings: OutlineHeading[];
  contentRef: RefObject<HTMLElement | null>;
  onJump: (line: number) => void;
}) {
  const active = useActiveHeading(headings, contentRef);
  const listRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new active row is what has to come into view
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(
      '[aria-current="location"]',
    );
    if (row != null) keepInView(row);
  }, [active, headings]);

  if (headings.length === 0) {
    return (
      <p className="px-2 py-1 text-sm text-muted-foreground">No headings</p>
    );
  }
  const top = Math.min(...headings.map((h) => h.level));
  return (
    <div
      ref={listRef}
      data-spec-outline=""
      className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-y-0.5"
    >
      {headings.map((heading, i) => (
        <button
          key={heading.line}
          type="button"
          title={heading.text}
          aria-current={i === active ? "location" : undefined}
          onClick={() => onJump(heading.line)}
          className={cn(
            "col-span-4 grid cursor-pointer grid-cols-subgrid items-center rounded-md px-2 py-1 text-left text-sm",
            i === active
              ? "bg-muted font-medium"
              : "text-muted-foreground hover:bg-muted/50",
          )}
        >
          <span
            className="truncate"
            style={{ paddingLeft: `${(heading.level - top) * 0.75}rem` }}
          >
            {heading.text}
          </span>
        </button>
      ))}
    </div>
  );
}
