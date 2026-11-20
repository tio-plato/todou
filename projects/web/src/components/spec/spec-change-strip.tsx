import { type RefObject, useRef, useState } from "react";
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
import { DELETION_CLASSES } from "@/lib/rehype-fold-unchanged.ts";
import { parseSourceLoc, SOURCE_LINE_ATTR } from "@/lib/rehype-source-lines.ts";
import { usableViewport } from "@/lib/scroll-insets.ts";
import { CHANGED_SELECTOR, stopsIn } from "@/lib/spec-change-nav.ts";
import type { OutlineHeading, SectionStat } from "@/lib/spec-outline.ts";
import {
  layoutTicks,
  type Mark,
  stripToDocument,
  type Tick,
  type TickKind,
} from "@/lib/spec-strip.ts";
import { useLayoutTick } from "@/lib/use-layout-tick.ts";
import { cn } from "@/lib/utils.ts";

/** The strip's width, centred on the card's right border. */
const STRIP_WIDTH = 14;

/** How far off a tick a click may land and still be a click on it. */
const HIT_SLOP = 3;

/** How far the pointer moves before a press on the strip is a drag. */
const DRAG_SLOP = 3;

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
 * tick shows over a change's.
 */
const PAINT: ReadonlyArray<readonly [TickKind, string]> = [
  ["heading", "left-0 right-0 bg-foreground/30"],
  // The green bar a changed block wears down its left edge, and the red one
  // a removed block does.
  [
    "stop",
    "left-0 right-0 bg-[color-mix(in_oklab,var(--diff-addition)_60%,transparent)]",
  ],
  [
    "del",
    "left-0 right-0 bg-[color-mix(in_oklab,var(--diff-deletion)_60%,transparent)]",
  ],
  // The chips' amber and indigo, on the strip's right half.
  ["comment", "left-1/2 right-0 bg-amber-500"],
  ["draft", "left-1/2 right-0 bg-indigo-500"],
];

/**
 * The card's right border, drawn as a map of the whole file from lg up
 * (T-234): its changes, its open comments and drafts, its h2s and a frame
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
  const drag = useRef<{ startY: number; moved: boolean } | null>(null);

  useLayoutTick(contentRef, () => {
    const card = cardRef.current;
    const doc = renderedDocumentIn(card);
    if (card === null || doc === null) return;
    const rect = card.getBoundingClientRect();
    const cardDocTop = rect.top + window.scrollY;
    // Fixed for a given window and toolbar: the bar's height when the card
    // sits as low as it ever does, at the top of the page, so that the
    // whole bar shows there too. Never taller than the card it runs down.
    const stripHeight = Math.max(
      0,
      Math.min(window.innerHeight - cardDocTop - gap, rect.height),
    );
    const { marks, stopIndex } = collectMarks(
      doc,
      rect.top,
      annotations,
      baselineAnnotations,
      oldToNew,
      { changes: showChanges, comments: showComments },
    );
    const next: Layout = {
      ticks: layoutTicks(marks, rect.height, stripHeight),
      stopIndex,
      sections: sectionTops(doc, rect.top, headings),
      cardHeight: rect.height,
      stripHeight,
    };
    setLayout((prev) => (sameLayout(prev, next) ? prev : next));
    // What is on screen moves with every scroll; only the frame follows it.
    const frame = frameRef.current;
    if (frame !== null && rect.height > 0) {
      const from = Math.max(0, stickyTop - rect.top);
      const to = Math.min(rect.height, window.innerHeight - rect.top);
      const scale = stripHeight / rect.height;
      frame.style.top = `${from * scale}px`;
      frame.style.height = `${Math.max(0, to - from) * scale}px`;
    }
  }, [
    ...deps,
    annotations,
    baselineAnnotations,
    headings,
    showComments,
    showChanges,
    stickyTop,
    gap,
  ]);

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

  /** Put a point of the card in the middle of what the toolbar leaves. */
  const scrollToPoint = (down: number, behavior: ScrollBehavior) => {
    const card = cardRef.current;
    if (card === null) return;
    const usable = usableViewport();
    const pageY = card.getBoundingClientRect().top + window.scrollY + down;
    window.scrollTo({
      top: pageY - (usable.top + usable.height / 2),
      behavior,
    });
  };

  const hitTick = (y: number, kind: TickKind) =>
    layout.ticks.find(
      (tick) =>
        tick.kind === kind &&
        y >= tick.top - HIT_SLOP &&
        y <= tick.top + tick.height + HIT_SLOP,
    );

  const click = (clientY: number) => {
    const at = pointAt(clientY);
    if (at === null) return;
    const tick = hitTick(at.y, "stop") ?? hitTick(at.y, "del");
    if (tick !== undefined) land(tick.target);
    else scrollToPoint(at.down, "smooth");
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
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { startY: event.clientY, moved: false };
        }}
        onPointerMove={(event) => {
          const at = pointAt(event.clientY);
          setHover(
            at === null
              ? null
              : {
                  y: event.clientY,
                  right: window.innerWidth - at.left + 6,
                  section: at.section,
                },
          );
          // The press, not the capture, decides whether this is a drag:
          // Chromium can take a capture back the moment it grants it, and a
          // button released off the bar never says so here.
          if ((event.buttons & 1) === 0) drag.current = null;
          const pressed = drag.current;
          if (pressed === null || at === null) return;
          if (
            !pressed.moved &&
            Math.abs(event.clientY - pressed.startY) < DRAG_SLOP
          ) {
            return;
          }
          pressed.moved = true;
          scrollToPoint(at.down, "instant");
        }}
        onPointerUp={(event) => {
          const pressed = drag.current;
          drag.current = null;
          if (pressed !== null && !pressed.moved) click(event.clientY);
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
              <div className="font-mono text-[11px]">
                {stat.plus > 0 && (
                  <span className="diff-addition-text">+{stat.plus}</span>
                )}
                {stat.plus > 0 && stat.minus > 0 && " "}
                {stat.minus > 0 && (
                  <span className="diff-deletion-text">−{stat.minus}</span>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
