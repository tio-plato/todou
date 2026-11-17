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
import { useQuoteReply } from "@/components/timeline/quote-reply.tsx";
import { Button } from "@/components/ui/button";
import { quoteOfSelection } from "@/lib/quote-markdown.ts";
import {
  cutsQuote,
  entryQuote,
  type QuotePart,
} from "@/lib/quote-questions.ts";
import { anchorForSelection } from "@/lib/selection-anchor.ts";
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

/**
 * Worn by the element a quotable part renders into: a body, or one text of
 * a question card.
 */
export const QUOTE_BODY_ATTR = "data-quote-body";

/** Worn by the outermost element of a question card. */
export const QUOTE_QUESTIONS_ATTR = "data-quote-questions";

/**
 * What each quotable part renders and which part it is, indexed the first
 * time it is quoted.
 */
const BODIES = new WeakMap<
  Element,
  { source: string; part: QuotePart; index: SegmentIndex | null }
>();

const BODY: QuotePart = { kind: "body" };

/**
 * The ref for a quotable body's element: it hands the element on to `ref`,
 * the one `useQuoteTarget` gives, and records the markdown the element
 * renders. That is `MarkdownView`'s own input, which for an action line is
 * not the stored body; a selection's columns count in it.
 */
export function useQuotableBody(
  ref: (el: HTMLElement | null) => void,
  source: string,
): RefCallback<HTMLDivElement> {
  return useCallback(
    (el: HTMLDivElement | null) => {
      ref(el);
      if (el !== null) BODIES.set(el, { source, part: BODY, index: null });
    },
    [ref, source],
  );
}

/** The ref for one text of a question card, recorded as `part`. */
export function useQuotablePart(
  source: string,
  part: QuotePart,
): RefCallback<HTMLDivElement> {
  return useCallback(
    (el: HTMLDivElement | null) => {
      if (el !== null) BODIES.set(el, { source, part, index: null });
    },
    [source, part],
  );
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

/** One quotable part a selection selects text in, anchored in its source. */
type QuotedPart = {
  el: Element;
  source: string;
  part: QuotePart;
  anchor: AnchorRange;
};

/** A selection inside one entry, anchored in each part it reaches. */
export type QuotableSelection = {
  /** The comment, action line or issue body the parts belong to. */
  entry: Element;
  /** The parts the selection selects text in, in document order. */
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

/** Whether one of the endpoints is in a shadow root under `body`. */
function endsInShadowOf(ends: SelectionEndpoints, body: Element): boolean {
  return [ends.start.node, ends.end.node].some(
    (node) =>
      node.getRootNode() instanceof ShadowRoot && composedContains(body, node),
  );
}

/**
 * `ends`, anchored in the part `el` renders; null where no anchor fits. An
 * end outside the part is put on its edge first, which makes "from here to
 * the end" quotable.
 */
function anchorIn(el: Element, ends: SelectionEndpoints): QuotedPart | null {
  const shown = BODIES.get(el);
  if (shown === undefined) return null;
  shown.index ??= buildSegmentIndex(shown.source);
  const anchor = anchorForSelection(el, shown.index, ends);
  return anchor === null
    ? null
    : { el, source: shown.source, part: shown.part, anchor };
}

/**
 * The quotable parts under `root` the selection selects text in, and where in
 * each one's source; null unless they all belong to one entry and the
 * selection starts in one of them or in the entry's question card. A
 * selection reaching into a second entry is about two of them, so it quotes
 * neither — but one that merely ends at the very start of the next, as a
 * triple-click does, selects no text there and still counts. Within one
 * entry it may run from the body through the question card, each part taking
 * its own cut.
 */
export function quotableSelection(
  selection: Selection | null,
  root: Element | Document,
): QuotableSelection | null {
  if (selection === null) return null;
  const scope = root instanceof Document ? root.documentElement : root;
  const all = selectionEndpoints(selection, scope);
  if (all === null || all.collapsed) return null;
  const ordered = orderedEndpoints(all);
  if (ordered === null) return null;
  const { range } = ordered;
  const selected = selection.toString() !== "";
  // Only the parts this lets through are anchored: a long timeline holds
  // many, and this runs on every settled selection change.
  const touched = [...scope.querySelectorAll(`[${QUOTE_BODY_ATTR}]`)].filter(
    (el) =>
      // Code rows sit in pierre's shadow root, where a light range sees
      // only an empty host: that the selection ends in one says it more
      // reliably than any text the range could find.
      (selected && endsInShadowOf(all, el)) || coversText(range, el),
  );
  const first = touched[0];
  if (first === undefined) return null;
  const entry = entryOf(first);
  if (touched.some((el) => entryOf(el) !== entry)) return null;
  // Started outside what it quotes, in the entry's header or anywhere above
  // it, a selection runs into that header and is no quote from one entry
  // (T-723). Its end may run on past the body, as a triple-click's does.
  const start = ordered.ends.start.node;
  const cards = entry.querySelectorAll(`[${QUOTE_QUESTIONS_ATTR}]`);
  if (![...touched, ...cards].some((el) => composedContains(el, start))) {
    return null;
  }
  const [head, ...rest] = touched.flatMap((el) => {
    const ends = selectionEndpoints(selection, el);
    if (ends === null || ends.collapsed) return [];
    return anchorIn(el, ends) ?? [];
  });
  return head === undefined ? null : { entry, parts: [head, ...rest] };
}

/** The markdown a selection quotes: each part's cut, laid out together. */
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
 * The box the selection takes up. The legacy range is what has one — but
 * when the browser clamped it onto a shadow host it is an empty box there,
 * and the end's own element is then what says where the selection is
 * (T-164): code rows sit in pierre's shadow root.
 */
function selectionRect(selection: Selection, scope: Element): DOMRect {
  const legacy = selection.getRangeAt(0);
  if (!legacy.collapsed) return legacy.getBoundingClientRect();
  const ends = selectionEndpoints(selection, scope);
  const end = ends === null ? null : elementNear(ends.end.node);
  return (end ?? legacy).getBoundingClientRect();
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
      // The same reading as the `…` menu's Quote reply: the words selected,
      // across a question card's texts too, in one entry.
      const picked = quotableSelection(selection, document);
      const markdown = picked === null ? "" : quoteOfQuotable(picked);
      if (picked === null || markdown === "") {
        setPending(null);
        return;
      }
      const rect = selectionRect(selection, picked.entry);
      // A question card's texts line up with the card.
      const last = picked.parts[picked.parts.length - 1].el;
      const frame = (
        targets.get(last)?.frame() ??
        last.closest(`[${QUOTE_QUESTIONS_ATTR}]`) ??
        last
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
    // The selection goes first: the comment box takes the focus and puts its
    // caret as the quote lands, and clearing the selection after that would
    // take the caret with it.
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
