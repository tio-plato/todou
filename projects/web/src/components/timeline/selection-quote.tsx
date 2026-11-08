import type {
  Question,
  QuestionAnswer,
  QuestionsComponent,
} from "@todou/shared";
import { TextQuoteIcon } from "lucide-react";
import {
  type CSSProperties,
  type RefCallback,
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
import {
  cutsQuote,
  entryQuote,
  type QuotePart,
} from "@/lib/quote-questions.ts";
import { anchorForSelection, sideOf } from "@/lib/selection-anchor.ts";
import {
  composedContains,
  elementNear,
  orderedEndpoints,
  type SelectionEndpoints,
  selectionEndpoints,
} from "@/lib/selection-endpoints.ts";
import {
  buildSegmentIndex,
  type SegmentIndex,
} from "@/lib/spec-source-index.ts";
import { POINTER_FINE, useMediaQuery } from "@/lib/use-media-query.ts";

/** Worn by the outermost element of a question card. */
export const QUOTE_QUESTIONS_ATTR = "data-quote-questions";

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

/**
 * The comment or action line `el` belongs to: the root that carries its id.
 * The issue body has none above it, and is its own entry.
 */
export function entryOf(el: Element): Element {
  return el.closest("[data-comment-id]") ?? el;
}

/** What each question card shows, by the element it renders into. */
const QUESTIONS = new WeakMap<
  Element,
  { component: QuestionsComponent; answers: readonly QuestionAnswer[] | null }
>();

/**
 * The ref for a question card's outermost element: it records the questions
 * and the answers the card shows, null while there are none or they are not
 * known. Outermost because a popped-out form renders into another document,
 * and the page keeps only this element and a placeholder inside it.
 */
export function useQuotableQuestions(
  component: QuestionsComponent,
  answers: readonly QuestionAnswer[] | null,
): RefCallback<HTMLDivElement> {
  return useCallback(
    (el: HTMLDivElement | null) => {
      if (el !== null) QUESTIONS.set(el, { component, answers });
    },
    [component, answers],
  );
}

/** The questions an entry's card shows, and their answers; null for none. */
export function questionsIn(entry: Element): {
  questions: readonly Question[];
  answers: readonly QuestionAnswer[] | null;
} | null {
  const card = entry.querySelector(`[${QUOTE_QUESTIONS_ATTR}]`);
  const shown = card === null ? undefined : QUESTIONS.get(card);
  return shown === undefined
    ? null
    : { questions: shown.component.questions, answers: shown.answers };
}

/**
 * What quoting a whole entry quotes: its stored body, then the questions and
 * answers its card shows. `entry` is null for an entry not rendered, which
 * quotes its body alone.
 */
export function wholeQuoteOf(entry: Element | null, body: string): string {
  return entryQuote({
    body,
    questions: null,
    answers: null,
    ...(entry === null ? null : questionsIn(entry)),
  });
}

/** One quote target a selection selects text in, anchored in its source. */
type QuotedPart = {
  el: Element;
  source: string;
  part: QuotePart;
  anchor: AnchorRange;
};

/** A selection inside one entry, anchored in each target it reaches. */
export type QuotableSelection = {
  /** The comment, action line or issue body the targets belong to. */
  entry: Element;
  /** The targets the selection selects text in, in document order. */
  parts: [QuotedPart, ...QuotedPart[]];
};

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
 * `ends` with an endpoint outside the target `el` put on its own edge.
 * Clamped to its first or last block instead, it would name that block and
 * quote all of it. On the edge it selects nothing, and `anchorForSelection`
 * moves it onto the first or last character selected: a triple-click on a
 * body's last block ends past the body and quotes that block's text, and a
 * selection run on from a body into its question card starts before each
 * text of the card it reaches.
 */
function onEdges(el: Element, ends: SelectionEndpoints): SelectionEndpoints {
  const ordered = orderedEndpoints(ends);
  if (ordered === null) return ends;
  const { start, end } = ordered.ends;
  const before = sideOf(el, start.node, start.offset) === "before";
  const after = sideOf(el, end.node, end.offset) === "after";
  if (!before && !after) return ends;
  return {
    start: before ? { node: el, offset: 0 } : start,
    end: after ? { node: el, offset: el.childNodes.length } : end,
    collapsed: ends.collapsed,
  };
}

/**
 * `ends`, anchored in what the target `el` renders; null where no anchor
 * fits. An end past the target is put on its edge first, which makes "from
 * here to the end" quotable.
 */
function anchorIn(
  el: Element,
  target: QuoteTarget,
  ends: SelectionEndpoints,
): QuotedPart | null {
  const source = target.body();
  const index = segmentIndexOf(el, source);
  // Should the edge leave a target of some unforeseen shape no anchor, the
  // endpoints as selected still clamp to a block rather than lose the button.
  const placed = onEdges(el, ends);
  const anchor =
    anchorForSelection(el, index, placed) ??
    (placed === ends ? null : anchorForSelection(el, index, ends));
  return anchor === null ? null : { el, source, part: target.part(), anchor };
}

/** For sorting elements into document order. */
function inDocumentOrder(a: Element, b: Element): number {
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    ? -1
    : 1;
}

/**
 * The quote targets the selection selects text in, and where in what each
 * renders; null unless they all belong to one entry. A selection reaching
 * into a second entry is about two of them, so it quotes neither — but one
 * that merely ends at the very start of the next, as a triple-click does,
 * selects no text there and still counts. Within one entry it may run from
 * the body through the question card, each target taking its own cut. A
 * selection that starts before the first of them, in the entry's header
 * say, quotes nothing.
 */
export function quotableSelection(
  selection: Selection | null,
  targets: ReadonlyMap<Element, QuoteTarget>,
): QuotableSelection | null {
  if (selection === null) return null;
  const all = endpointsOf(selection, document.documentElement);
  if (all === null || all.collapsed) return null;
  const ordered = orderedEndpoints(all);
  if (ordered === null) return null;
  const { range } = ordered;
  const selected = selection.toString() !== "";
  // Only the targets this lets through are anchored: a long timeline holds
  // many, and this runs on every settled selection change.
  const touched = [...targets.keys()]
    .filter(
      (el) =>
        // A question form popped out into a window of its own renders its
        // texts there, out of reach of this window's selection.
        el.ownerDocument === document &&
        // Code rows sit in pierre's shadow root, where a light range sees
        // only an empty host: that the selection ends in one says it more
        // reliably than any text the range could find.
        ((selected && endsInShadowOf(all, el)) || coversText(range, el)),
    )
    .sort(inDocumentOrder);
  const first = touched[0];
  if (first === undefined || startsBefore(range, first)) return null;
  const entry = entryOf(first);
  if (touched.some((el) => entryOf(el) !== entry)) return null;
  const [head, ...rest] = touched.flatMap((el) => {
    const target = targets.get(el);
    const ends = endpointsOf(selection, el);
    if (target === undefined || ends === null || ends.collapsed) return [];
    return anchorIn(el, target, ends) ?? [];
  });
  return head === undefined ? null : { entry, parts: [head, ...rest] };
}

/** The markdown a selection quotes: each target's cut, laid out together. */
export function quoteOfQuotable(picked: QuotableSelection): string {
  return cutsQuote(
    picked.parts
      .map(({ source, part, anchor }) => ({
        part,
        text: quoteOfSelection(source, anchor),
      }))
      .filter((cut) => cut.text.trim() !== ""),
  );
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
      const markdown = picked === null ? "" : quoteOfQuotable(picked);
      if (picked === null || markdown === "") {
        setPending(null);
        return;
      }
      // The target the selection ends in; a question's text lines the
      // button up with its whole entry, as the body does.
      const last = picked.parts[picked.parts.length - 1] ?? picked.parts[0];
      const rect = selectionRect(selection, last.el);
      const frame = (
        (last.part.kind === "body" ? targets.get(last.el)?.frame() : null) ??
        picked.entry
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
