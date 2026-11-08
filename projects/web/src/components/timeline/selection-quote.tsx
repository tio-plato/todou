import type {
  Question,
  QuestionAnswer,
  QuestionsComponent,
} from "@todou/shared";
import { TextQuoteIcon } from "lucide-react";
import { type RefCallback, type RefObject, useCallback } from "react";
import {
  type AnchorRange,
  SelectionEntry,
  useSelectionEntry,
} from "@/components/spec/selection-entry.tsx";
import { useQuoteReply } from "@/components/timeline/quote-reply.tsx";
import { quoteOfSelection } from "@/lib/quote-markdown.ts";
import {
  cutsQuote,
  entryQuote,
  type QuotePart,
} from "@/lib/quote-questions.ts";
import { anchorForSelection } from "@/lib/selection-anchor.ts";
import {
  composedContains,
  orderedEndpoints,
  type SelectionEndpoints,
  selectionEndpoints,
} from "@/lib/selection-endpoints.ts";
import {
  buildSegmentIndex,
  type SegmentIndex,
} from "@/lib/spec-source-index.ts";

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
 * The ref for a quotable body's element: it fills `bodyRef` and records the
 * markdown the element renders. That is `MarkdownView`'s own input, which for
 * an action line is not the stored body; a selection's columns count in it.
 */
export function useQuotableBody(
  bodyRef: RefObject<HTMLDivElement | null>,
  source: string,
): RefCallback<HTMLDivElement> {
  return useCallback(
    (el: HTMLDivElement | null) => {
      bodyRef.current = el;
      if (el !== null) BODIES.set(el, { source, part: BODY, index: null });
    },
    [bodyRef, source],
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
 * each one's source; null unless they all belong to one entry. A selection
 * reaching into a second entry is about two of them, so it quotes neither —
 * but one that merely ends at the very start of the next, as a triple-click
 * does, selects no text there and still counts. Within one entry it may run
 * from the body through the question card, each part taking its own cut.
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

/** An anchor the floating entry offers, with the selection it quotes. */
type QuoteAnchor = AnchorRange & { picked: QuotableSelection };

/**
 * The floating Quote reply for whatever the reader selects in one entry
 * under `containerRef`, which has to be `relative`. One for the page rather
 * than one per entry: each listens on the whole document.
 */
export function SelectionQuote({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const { available, quote } = useQuoteReply();
  const resolve = useCallback(
    (container: Element): QuoteAnchor | null => {
      // A trashed card has no comment box to quote into.
      if (!available) return null;
      const picked = quotableSelection(window.getSelection(), container);
      return picked === null ? null : { ...picked.parts[0].anchor, picked };
    },
    [available],
  );
  const { pending, clear } = useSelectionEntry(containerRef, resolve);
  return (
    <SelectionEntry
      pending={pending}
      clear={clear}
      // Over the comment box, which docks at z-10 and comes later in the
      // page: a selection just above it would put the button under it.
      className="z-20"
      onStage={(anchor) => quote(quoteOfQuotable(anchor.picked))}
    >
      <TextQuoteIcon className="size-4" />
      Quote reply
    </SelectionEntry>
  );
}
