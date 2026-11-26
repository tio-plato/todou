import { type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  blockForLine,
  type DisplayedAnnotation,
  visibleAnchor,
} from "@/components/spec/annotated-markdown.tsx";
import {
  headingsByLine,
  type Land,
  renderedDocumentIn,
  shownFor,
} from "@/components/spec/spec-outline.tsx";
import { StatNumbers } from "@/components/timeline/spec-version-card.tsx";
import { DELETION_CLASSES } from "@/lib/rehype-fold-unchanged.ts";
import { parseSourceLoc, SOURCE_LINE_ATTR } from "@/lib/rehype-source-lines.ts";
import {
  glideToY,
  restingScrollY,
  usableViewport,
  useOwnHold,
} from "@/lib/scroll-insets.ts";
import { CHANGED_SELECTOR, stopsIn } from "@/lib/spec-change-nav.ts";
import type { OutlineHeading, SectionStat } from "@/lib/spec-outline.ts";
import {
  layoutTicks,
  type Mark,
  stripToDocument,
  type Tick,
  type TickKind,
  tickAt,
} from "@/lib/spec-strip.ts";
import { useLayoutTick } from "@/lib/use-layout-tick.ts";
import { cn } from "@/lib/utils.ts";

/** The strip's width, centred on the card's right border. */
const STRIP_WIDTH = 14;

/** How far off a tick a click may land and still be a click on it. */
const HIT_SLOP = 3;

/** How far the pointer moves before a press on the strip is a drag. */
const DRAG_SLOP = 3;

/** The ticks a press lands on; elsewhere it scrolls that point into view. */
const LANDING_KINDS: readonly TickKind[] = ["stop", "del"];

/**
 * The card's padding box in the viewport: what the strip's column spans, and
 * so what its scale maps onto the bar.
 */
function paddingBoxOf(card: HTMLElement): { top: number; height: number } {
  return {
    top: card.getBoundingClientRect().top + card.clientTop,
    height: card.clientHeight,
  };
}

const DELETION_SELECTOR = [...DELETION_CLASSES]
  .map((name) => `.${name}`)
  .join(", ");

/** What a tick points at, so a click on it lands where ↓ would. */
type Target = HTMLElement;

/**
 * Everything the strip marks, in the card's coordinates: each stop ↑↓ step
 * over, numbered as they number them; each deletion no stop holds, which
 * nothing else would mark; each open comment and draft at its block; and
 * each h2. Something a fold or a closed `<details>` hides is measured where
 * the reader sees it stand.
 */
export function collectMarks(
  doc: HTMLElement,
  cardTop: number,
  annotations: DisplayedAnnotation[],
  baselineAnnotations: DisplayedAnnotation[],
  oldToNew: (oldLine: number) => number,
  { changes, comments }: { changes: boolean; comments: boolean },
): { marks: Mark<Target>[]; stopIndex: Map<Target, number> } {
  const marks: Mark<Target>[] = [];
  const stopIndex = new Map<Target, number>();
  const measure = (kind: TickKind, el: HTMLElement, target: Target) => {
    const rect = el.getBoundingClientRect();
    marks.push({ kind, top: rect.top - cardTop, height: rect.height, target });
  };
  const located = (el: HTMLElement): HTMLElement | null => {
    const loc = parseSourceLoc(el.getAttribute(SOURCE_LINE_ATTR));
    return loc === null ? visibleAnchor(el) : shownFor(doc, el, loc.start);
  };

  if (changes) {
    const stops = stopsIn(doc, CHANGED_SELECTOR);
    stops.forEach((stop, i) => {
      stopIndex.set(stop, i);
      measure("stop", located(stop) ?? stop, stop);
    });
    for (const del of stopsIn(doc, DELETION_SELECTOR)) {
      if (stops.some((stop) => stop.contains(del))) continue;
      measure("del", located(del) ?? del, del);
    }
  }

  if (comments) {
    const blocks = [
      ...doc.querySelectorAll<HTMLElement>(`[${SOURCE_LINE_ATTR}]`),
    ].flatMap((el) => {
      const loc = parseSourceLoc(el.getAttribute(SOURCE_LINE_ATTR));
      return loc === null ? [] : [{ el, ...loc }];
    });
    const mark = (annotation: DisplayedAnnotation, line: number) => {
      if (annotation.start < 1) return;
      if (annotation.kind === "comment" && annotation.item.resolved !== null) {
        return;
      }
      const block = blocks[blockForLine(blocks, line)];
      if (block === undefined) return;
      const shown = shownFor(doc, block.el, line);
      if (shown === null) return;
      measure(
        annotation.kind === "draft" ? "draft" : "comment",
        shown,
        block.el,
      );
    };
    for (const annotation of annotations) mark(annotation, annotation.start);
    for (const annotation of baselineAnnotations) {
      mark(annotation, oldToNew(annotation.start));
    }
  }

  for (const heading of doc.querySelectorAll<HTMLElement>(
    `h2[${SOURCE_LINE_ATTR}]`,
  )) {
    const shown = located(heading);
    if (shown !== null) measure("heading", shown, heading);
  }
  return { marks, stopIndex };
}

/** Where each section starts, down the card, in outline order. */
function sectionTops(
  doc: HTMLElement,
  cardTop: number,
  headings: OutlineHeading[],
): Array<number | null> {
  const byLine = headingsByLine(doc);
  return headings.map(({ line }) => {
    const el = byLine.get(line);
    const shown = el === undefined ? null : shownFor(doc, el, line);
    return shown === null ? null : shown.getBoundingClientRect().top - cardTop;
  });
}

type Layout = {
  ticks: Tick<Target>[];
  stopIndex: Map<Target, number>;
  sections: Array<number | null>;
  cardHeight: number;
  stripHeight: number;
};

const NO_LAYOUT: Layout = {
  ticks: [],
  stopIndex: new Map(),
  sections: [],
  cardHeight: 0,
  stripHeight: 0,
};

function sameLayout(a: Layout, b: Layout): boolean {
  return (
    a.cardHeight === b.cardHeight &&
    a.stripHeight === b.stripHeight &&
    a.ticks.length === b.ticks.length &&
    a.ticks.every((tick, i) => {
      const other = b.ticks[i];
      return (
        other !== undefined &&
        tick.kind === other.kind &&
        tick.top === other.top &&
        tick.height === other.height &&
        tick.target === other.target
      );
    }) &&
    a.sections.length === b.sections.length &&
    a.sections.every((top, i) => top === b.sections[i])
  );
}

/**
 * How each kind of tick is drawn, in the order they are drawn, so a note's
 * tick shows over a change's, and a change's over a removal it overlaps,
 * which is where a press on the two lands (`LANDING_KINDS`).
 */
const PAINT: ReadonlyArray<readonly [TickKind, string]> = [
  ["heading", "left-0 right-0 bg-foreground/30"],
  // The red bar a removed block wears down its left edge, and the green one
  // a changed block does.
  [
    "del",
    "left-0 right-0 bg-[color-mix(in_oklab,var(--diff-deletion)_60%,transparent)]",
  ],
  [
    "stop",
    "left-0 right-0 bg-[color-mix(in_oklab,var(--diff-addition)_60%,transparent)]",
  ],
  // The chips' amber and indigo, on the strip's right half.
  ["comment", "left-1/2 right-0 bg-amber-500"],
  ["draft", "left-1/2 right-0 bg-indigo-500"],
];

/**
 * The card's right border, drawn as a map of the whole file from lg up:
 * its changes, its open comments and drafts, its h2s and a frame
 * around what is on screen, at their places down the file. The bar stays in
 * view while the card scrolls past, and a click on it goes where it points.
 *
 * Hidden from assistive tech: the outline and ↑↓ reach everything it does.
 */
export function SpecChangeStrip({
  cardRef,
  contentRef,
  stickyTop,
  gap,
  headings,
  stats,
  annotations,
  baselineAnnotations,
  oldToNew,
  showComments,
  showChanges,
  land,
  deps,
}: {
  /** The card whose right border this is. */
  cardRef: RefObject<HTMLElement | null>;
  /** The page's content, whose size changes say the card's may have. */
  contentRef: RefObject<HTMLElement | null>;
  /** The toolbar's bottom: what lies above it is not on screen. */
  stickyTop: number;
  /** How far below the toolbar the bar stops, as the file rail does. */
  gap: number;
  headings: OutlineHeading[];
  /** Each section's changed lines while comparing. */
  stats: SectionStat[] | null;
  annotations: DisplayedAnnotation[];
  baselineAnnotations: DisplayedAnnotation[];
  oldToNew: (oldLine: number) => number;
  showComments: boolean;
  showChanges: boolean;
  land: Land;
  /** What the document is drawn from, so a new drawing is measured anew. */
  deps: unknown[];
}) {
  const [layout, setLayout] = useState<Layout>(NO_LAYOUT);
  const barRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    y: number;
    right: number;
    section: number;
  } | null>(null);
  const drag = useRef<{
    pointer: number;
    startY: number;
    moved: boolean;
    /** Where the page is dragged from. */
    from: number;
    /** The scale at the press, which holds for the whole drag. */
    cardHeight: number;
    stripHeight: number;
  } | null>(null);
  /** The bar's height as last measured, for the frame between measurements. */
  const stripHeightRef = useRef(0);
  /** Ends the watch for a release off the bar that the last press began. */
  const pressWatch = useRef<AbortController | null>(null);
  useEffect(() => () => pressWatch.current?.abort(), []);
  const keepHold = useOwnHold();

  useLayoutTick(
    contentRef,
    (resized) => {
      const card = cardRef.current;
      const doc = renderedDocumentIn(card);
      if (card === null || doc === null) return;
      const box = paddingBoxOf(card);
      // Where things lie down the card only changes when something changes
      // size; a scroll alone moves the frame and nothing else.
      if (resized) {
        // Fixed for a given window and toolbar: once stuck, the bar runs from
        // `gap` below the toolbar to `gap` above the window's foot, as the
        // file rail does; until it sticks it rides lower with the card, its
        // foot below the window. Never taller than the card it runs down.
        const stripHeight = Math.max(
          0,
          Math.min(window.innerHeight - stickyTop - 2 * gap, box.height),
        );
        stripHeightRef.current = stripHeight;
        const { marks, stopIndex } = collectMarks(
          doc,
          box.top,
          annotations,
          baselineAnnotations,
          oldToNew,
          { changes: showChanges, comments: showComments },
        );
        const next: Layout = {
          ticks: layoutTicks(marks, box.height, stripHeight),
          stopIndex,
          sections: sectionTops(doc, box.top, headings),
          cardHeight: box.height,
          stripHeight,
        };
        setLayout((prev) => (sameLayout(prev, next) ? prev : next));
      }
      const frame = frameRef.current;
      if (frame !== null && box.height > 0) {
        const from = Math.max(0, stickyTop - box.top);
        const to = Math.min(box.height, window.innerHeight - box.top);
        const scale = stripHeightRef.current / box.height;
        frame.style.top = `${from * scale}px`;
        frame.style.height = `${Math.max(0, to - from) * scale}px`;
      }
    },
    [
      ...deps,
      annotations,
      baselineAnnotations,
      headings,
      showComments,
      showChanges,
      stickyTop,
      gap,
    ],
  );

  /** The bar's y under the pointer, and the section it falls in. */
  const pointAt = (clientY: number) => {
    const bar = barRef.current;
    if (bar === null) return null;
    const box = bar.getBoundingClientRect();
    const y = clientY - box.top;
    const down = stripToDocument(y, layout.cardHeight, layout.stripHeight);
    let section = 0;
    layout.sections.forEach((at, i) => {
      if (at !== null && at <= down) section = i;
    });
    return { y, down, section, left: box.left };
  };

  /**
   * Where the page rests with a point of the card in the middle of what the
   * toolbar leaves, by the rule ↑↓ land by.
   */
  const restingFor = (down: number): number | null => {
    const card = cardRef.current;
    if (card === null) return null;
    const pageY = paddingBoxOf(card).top + window.scrollY + down;
    return restingScrollY({ top: pageY, height: 0 }, usableViewport());
  };

  const click = (clientY: number) => {
    const at = pointAt(clientY);
    if (at === null) return;
    const tick = tickAt(layout.ticks, at.y, LANDING_KINDS, HIT_SLOP);
    if (tick !== undefined) land(tick.target);
    // Glided to and held there like a tick's landing, the point
    // measured again as the card moves down the page.
    else keepHold(glideToY(() => restingFor(at.down)));
  };

  const heading = hover === null ? undefined : headings[hover.section];
  const stat = hover === null ? undefined : stats?.[hover.section];

  return (
    <div
      aria-hidden
      data-spec-strip=""
      className="absolute top-0 bottom-0 select-none"
      style={{ right: -(STRIP_WIDTH + 1) / 2, width: STRIP_WIDTH }}
    >
      <div
        ref={barRef}
        className="sticky cursor-pointer overflow-hidden rounded-full bg-border touch-none"
        style={{ top: stickyTop + gap, height: layout.stripHeight }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          // No text selection starts on the strip, and the drag keeps it.
          event.preventDefault();
          const bar = event.currentTarget;
          bar.setPointerCapture(event.pointerId);
          const pointer = event.pointerId;
          // A drag moves the page by how far the pointer goes, as a
          // scrollbar's thumb does, not to where the pointer is on the bar,
          // which itself moves off the top of the page and at its end. It
          // starts where the page is for a press on the frame; for one
          // beside it, as on a scrollbar's track, where a click there would
          // take the page, as far as the page goes.
          const frame = frameRef.current?.getBoundingClientRect();
          const onFrame =
            frame !== undefined &&
            event.clientY >= frame.top &&
            event.clientY <= frame.bottom;
          const at = onFrame ? null : pointAt(event.clientY);
          const resting = at === null ? null : restingFor(at.down);
          const pageEnd = Math.max(
            0,
            document.documentElement.scrollHeight - window.innerHeight,
          );
          drag.current = {
            pointer,
            startY: event.clientY,
            moved: false,
            from:
              resting === null
                ? window.scrollY
                : Math.min(Math.max(resting, 0), pageEnd),
            cardHeight: layout.cardHeight,
            stripHeight: layout.stripHeight,
          };
          // Without the capture, a release off the bar never reaches it, and
          // the tooltip would stay up until the pointer came back; a cancel
          // ends the press wherever it lands.
          pressWatch.current?.abort();
          const watch = new AbortController();
          pressWatch.current = watch;
          const end = (up: PointerEvent) => {
            if (up.pointerId !== pointer) return;
            watch.abort();
            const onBar = up.target instanceof Node && bar.contains(up.target);
            if (up.type === "pointerup" && onBar) return;
            drag.current = null;
            setHover(null);
          };
          for (const type of ["pointerup", "pointercancel"] as const) {
            window.addEventListener(type, end, { signal: watch.signal });
          }
        }}
        onPointerMove={(event) => {
          const at = pointAt(event.clientY);
          setHover(
            at === null
              ? null
              : {
                  y: event.clientY,
                  // From the edge a fixed box's `right` counts from, which
                  // leaves a classic scrollbar out.
                  right: document.documentElement.clientWidth - at.left + 6,
                  section: at.section,
                },
          );
          // The press, not the capture, decides whether this is a drag:
          // Chromium can take a capture back the moment it grants it, and a
          // button released off the bar never says so here.
          const pressed = drag.current;
          if (pressed === null || pressed.pointer !== event.pointerId) return;
          if ((event.buttons & 1) === 0) {
            drag.current = null;
            return;
          }
          if (
            !pressed.moved &&
            Math.abs(event.clientY - pressed.startY) < DRAG_SLOP
          ) {
            return;
          }
          pressed.moved = true;
          window.scrollTo({
            top:
              pressed.from +
              stripToDocument(
                event.clientY - pressed.startY,
                pressed.cardHeight,
                pressed.stripHeight,
              ),
            behavior: "instant",
          });
        }}
        onPointerUp={(event) => {
          const pressed = drag.current;
          if (pressed === null || pressed.pointer !== event.pointerId) return;
          drag.current = null;
          if (!pressed.moved) click(event.clientY);
        }}
        onPointerLeave={() => {
          if (drag.current === null) setHover(null);
        }}
      >
        {PAINT.flatMap(([kind, colour]) =>
          layout.ticks
            .filter((tick) => tick.kind === kind)
            .map((tick) => (
              <div
                key={`${kind}-${tick.top}`}
                data-kind={kind}
                data-stop-index={
                  kind === "stop"
                    ? layout.stopIndex.get(tick.target)
                    : undefined
                }
                className={cn(
                  "pointer-events-none absolute forced-color-adjust-none",
                  colour,
                )}
                style={{ top: tick.top, height: tick.height }}
              />
            )),
        )}
        <div
          ref={frameRef}
          data-spec-strip-frame=""
          className="pointer-events-none absolute right-0 left-0 rounded-full border-foreground/60 forced-color-adjust-none"
          style={{ borderWidth: 1.5, borderStyle: "solid" }}
        />
      </div>
      {hover !== null &&
        heading !== undefined &&
        createPortal(
          <div
            data-spec-strip-tooltip=""
            className="pointer-events-none fixed z-[60] max-w-72 -translate-y-1/2 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
            style={{ top: hover.y, right: hover.right }}
          >
            <div className="truncate font-medium">{heading.text}</div>
            {stat !== undefined && (stat.plus > 0 || stat.minus > 0) && (
              <div className="text-[11px]">
                <StatNumbers stat={stat} />
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
