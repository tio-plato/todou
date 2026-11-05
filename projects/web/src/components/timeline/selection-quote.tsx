import { TextQuoteIcon } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { AnchorRange } from "@/components/spec/selection-entry.tsx";
import {
  type QuoteTarget,
  useQuoteReply,
} from "@/components/timeline/quote-reply.tsx";
import { Button } from "@/components/ui/button";
import { quoteOfSelection } from "@/lib/quote-markdown.ts";
import { anchorForSelection } from "@/lib/selection-anchor.ts";
import {
  composedContains,
  elementNear,
  type SelectionEndpoints,
  selectionEndpoints,
} from "@/lib/selection-endpoints.ts";
import {
  buildSegmentIndex,
  type SegmentIndex,
} from "@/lib/spec-source-index.ts";
import { POINTER_FINE, useMediaQuery } from "@/lib/use-media-query.ts";

/**
 * Each body's markdown as it was last indexed: a body is indexed the first
 * time a selection in it is read, and again once it renders something else.
 */
const INDEXES = new WeakMap<Element, { source: string; index: SegmentIndex }>();

function segmentIndexOf(body: Element, source: string): SegmentIndex {
  const known = INDEXES.get(body);
  if (known !== undefined && known.source === source) return known.index;
  const index = buildSegmentIndex(source);
  INDEXES.set(body, { source, index });
  return index;
}

/** A selection inside one quotable body, anchored in what it renders. */
export type QuotableSelection = {
  body: Element;
  source: string;
  anchor: AnchorRange;
};

/**
 * A point in the light DOM standing for `node`: an endpoint inside a shadow
 * root becomes its outermost host, from before it or after it, since a range
 * cannot hold a point in another tree.
 */
function lightPoint(
  node: Node,
  offset: number,
  side: "before" | "after",
): { node: Node; offset: number } {
  let host: Element | null = null;
  for (
    let root = node.getRootNode();
    root instanceof ShadowRoot;
    root = root.host.getRootNode()
  ) {
    host = root.host;
  }
  const parent = host?.parentNode;
  if (host === null || parent == null) return { node, offset };
  const at = Array.prototype.indexOf.call(parent.childNodes, host);
  return { node: parent, offset: side === "before" ? at : at + 1 };
}

/** The selection's endpoints as a light-DOM range, in document order. */
function lightRange(ends: SelectionEndpoints): Range {
  const range = document.createRange();
  let start = lightPoint(ends.start.node, ends.start.offset, "before");
  let end = lightPoint(ends.end.node, ends.end.offset, "after");
  range.setStart(start.node, start.offset);
  // The legacy endpoints are anchor and focus, which a backwards drag
  // hands over backwards.
  if (range.comparePoint(end.node, end.offset) < 0) {
    start = lightPoint(ends.end.node, ends.end.offset, "before");
    end = lightPoint(ends.start.node, ends.start.offset, "after");
    range.setStart(start.node, start.offset);
  }
  range.setEnd(end.node, end.offset);
  return range;
}

/** Whether `range` covers any text of `body` but whitespace. */
function coversText(range: Range, body: Element): boolean {
  const inBody = document.createRange();
  inBody.selectNodeContents(body);
  const from = inBody.comparePoint(range.startContainer, range.startOffset);
  const to = inBody.comparePoint(range.endContainer, range.endOffset);
  if (from > 0 || to < 0) return false;
  if (from === 0) inBody.setStart(range.startContainer, range.startOffset);
  if (to === 0) inBody.setEnd(range.endContainer, range.endOffset);
  return inBody.toString().trim() !== "";
}

/**
 * `selectionEndpoints`, or null where it throws: some browsers know
 * `getComposedRanges` only by an older signature, and reject this one. No
 * selection is no reason to break the caller — the menu reads this on the
 * press that opens it, and a throw there keeps the menu shut.
 */
function endpointsOf(
  selection: Selection,
  container: Element,
): SelectionEndpoints | null {
  try {
    return selectionEndpoints(selection, container);
  } catch {
    return null;
  }
}

/** Whether `range` starts before the contents of `body`. */
function startsBefore(range: Range, body: Element): boolean {
  const inBody = document.createRange();
  inBody.selectNodeContents(body);
  return inBody.comparePoint(range.startContainer, range.startOffset) < 0;
}

/** Whether one of the endpoints is in a shadow root under `body`. */
function endsInShadowOf(ends: SelectionEndpoints, body: Element): boolean {
  return [ends.start.node, ends.end.node].some(
    (node) =>
      node.getRootNode() instanceof ShadowRoot && composedContains(body, node),
  );
}

/**
 * The quote target the selection selects text in, and where in the markdown
 * it renders; null unless that is exactly one body. A selection reaching
 * into a second body is about two of them, so it quotes neither — but one
 * that merely ends at the very start of the next, as a triple-click does,
 * selects no text there and still counts. An end past the body is clamped
 * to its last block, which makes "from here to the end" quotable; a start
 * before it, in the entry's header say, quotes nothing.
 */
export function quotableSelection(
  selection: Selection | null,
  targets: ReadonlyMap<Element, QuoteTarget>,
): QuotableSelection | null {
  if (selection === null) return null;
  const all = endpointsOf(selection, document.documentElement);
  if (all === null || all.collapsed) return null;
  const range = lightRange(all);
  const selected = selection.toString() !== "";
  const bodies = [...targets.keys()].filter(
    (body) =>
      // Code rows sit in pierre's shadow root, where a light range sees
      // only an empty host: that the selection ends in one says it more
      // reliably than any text the range could find.
      (selected && endsInShadowOf(all, body)) || coversText(range, body),
  );
  const body = bodies.length === 1 ? bodies[0] : undefined;
  const target = body && targets.get(body);
  if (body === undefined || target === undefined) return null;
  if (startsBefore(range, body)) return null;
  const ends = endpointsOf(selection, body);
  if (ends === null || ends.collapsed) return null;
  const source = target.body();
  const anchor = anchorForSelection(body, segmentIndexOf(body, source), ends);
  return anchor === null ? null : { body, source, anchor };
}

/** Marks the floating entry, so a press on it is not a new selection. */
const UI_ATTR = "data-selection-quote";

/** How long a press on the entry may hold a selection the press collapsed. */
const PRESS_WINDOW_MS = 300;

/** Where the entry sits, in document coordinates, and what it quotes. */
type Pending = { markdown: string; top: number; right: number };

/**
 * Where the selection ends on screen. The legacy range is what has a box —
 * but where the browser clamped it onto a shadow host, as it does for a
 * selection in a code block's rows, it is an empty box at the host, and the
 * element the selection ends in says where to sit instead (T-164).
 */
function selectionRect(selection: Selection, body: Element): DOMRect {
  const range = selection.getRangeAt(0);
  if (range.collapsed) {
    const ends = endpointsOf(selection, body);
    const near = ends === null ? null : elementNear(ends.end.node);
    if (near != null) return near.getBoundingClientRect();
  }
  return range.getBoundingClientRect();
}

/**
 * The floating Quote reply (T-723): select text inside one entry's body and
 * the entry's own Quote reply comes to the selection, without the `…`. It
 * follows the spec review page's Comment entry — under the selection's last
 * line on the body's right edge for a mouse, a bar pinned to the viewport's
 * foot for touch — and the press handling that lets it outlive the selection
 * its own press collapses (T-60) is the same.
 */
export function SelectionQuote() {
  const { available, quote, targets } = useQuoteReply();
  const pointerFine = useMediaQuery(POINTER_FINE);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const dragging = useRef(false);
  const pressingUi = useRef(false);

  const decide = useCallback(
    (keepOnEmpty = false) => {
      const selection = window.getSelection();
      if (
        selection === null ||
        selection.rangeCount === 0 ||
        selection.toString() === ""
      ) {
        if (!keepOnEmpty && !pressingUi.current) setPending(null);
        return;
      }
      // Mid-drag the entry would sit under the words still being selected;
      // `pointerup` schedules the read that counts.
      if (dragging.current) return;
      // Just what is selected, cut from the body's markdown, as the `…`
      // menu's Quote reply quotes it.
      const picked = quotableSelection(selection, targets);
      const markdown =
        picked === null ? "" : quoteOfSelection(picked.source, picked.anchor);
      if (picked === null || markdown === "") {
        setPending(null);
        return;
      }
      const rect = selectionRect(selection, picked.body);
      const frame = (
        targets.get(picked.body)?.frame() ?? picked.body
      ).getBoundingClientRect();
      setPending({
        markdown,
        // Never below the body: a selection ending on a block's last
        // character can report the rect of the empty line after it.
        top: Math.min(rect.bottom, frame.bottom) + window.scrollY + 6,
        right: frame.right + window.scrollX,
      });
    },
    [targets],
  );

  // Every path that changes a selection, as on the spec page (T-384):
  // keyboard, a drag released anywhere, and the touch long-press.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let frame: number | null = null;
    let pressTimer: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        decide();
      });
    };
    const clearPressWindow = () => {
      pressingUi.current = false;
      if (pressTimer !== null) {
        window.clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    // What the window held back is the "selection is gone" verdict, so
    // closing it has to read the selection again.
    const releaseUi = () => {
      clearPressWindow();
      schedule();
    };
    document.addEventListener("selectionchange", schedule, { signal });
    document.addEventListener(
      "pointerdown",
      (event) => {
        const onUi =
          event.target instanceof Element &&
          event.target.closest(`[${UI_ATTR}]`) !== null;
        if (!onUi) {
          // A finger selects through the platform's own long press and
          // handles, whose pointer events promise no end: iOS sends one
          // pointerdown for a handle drag and nothing after it. Holding
          // the read back is for the entry sitting under the words a mouse
          // or pen is still selecting, so a touch never holds it.
          if (event.pointerType !== "touch") dragging.current = true;
          return;
        }
        pressingUi.current = true;
        // A press that slides off the entry fires neither `click` nor
        // `pointercancel`, and must not keep a dead entry on screen.
        pressTimer = window.setTimeout(releaseUi, PRESS_WINDOW_MS);
      },
      { capture: true, signal },
    );
    document.addEventListener(
      "pointerup",
      () => {
        dragging.current = false;
        schedule();
      },
      { signal },
    );
    document.addEventListener(
      "pointercancel",
      () => {
        dragging.current = false;
        releaseUi();
      },
      { signal },
    );
    document.addEventListener("click", releaseUi, { signal });
    // The entry was measured against a layout a resize has moved; with no
    // selection left to measure, it stays where it is.
    window.addEventListener(
      "resize",
      () => {
        if (pendingRef.current !== null) decide(true);
      },
      { signal },
    );
    return () => {
      controller.abort();
      if (frame !== null) cancelAnimationFrame(frame);
      clearPressWindow();
    };
  }, [decide]);

  if (!available || pending === null) return null;

  const onQuote = () => {
    // The selection goes first: the comment box takes the focus and the
    // caret inside this press, and clearing the selection after that would
    // take the caret back out of it.
    setPending(null);
    window.getSelection()?.removeAllRanges();
    quote(pending.markdown);
  };

  return createPortal(
    pointerFine ? (
      <QuoteButton
        size="sm"
        className="absolute z-10 -translate-x-full shadow-md"
        style={{ top: pending.top, left: pending.right }}
        onQuote={onQuote}
      />
    ) : (
      // The platform's own bubble floats against a touch selection, and
      // neither can move the other; the viewport's foot is the one place
      // both fit, and the one a thumb always reaches.
      <div
        className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-2 backdrop-blur"
        {...{ [UI_ATTR]: "" }}
      >
        <QuoteButton size="lg" className="w-full" onQuote={onQuote} />
      </div>
    ),
    document.body,
  );
}

function QuoteButton({
  size,
  className,
  style,
  onQuote,
}: {
  size: "sm" | "lg";
  className: string;
  style?: CSSProperties;
  onQuote: () => void;
}) {
  return (
    <Button
      size={size}
      className={className}
      style={style}
      {...{ [UI_ATTR]: "" }}
      // A mouse press would collapse the selection under the button before
      // `click` fires (T-60); a touch press is left to the press window.
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") e.preventDefault();
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onQuote}
    >
      <TextQuoteIcon className="size-3.5" />
      Quote reply
    </Button>
  );
}
