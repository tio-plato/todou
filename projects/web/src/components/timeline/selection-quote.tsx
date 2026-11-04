import { TextQuoteIcon } from "lucide-react";
import { type RefCallback, type RefObject, useCallback } from "react";
import {
  type AnchorRange,
  SelectionEntry,
  useSelectionEntry,
} from "@/components/spec/selection-entry.tsx";
import { useQuoteReply } from "@/components/timeline/quote-reply.tsx";
import { quoteOfSelection } from "@/lib/quote-markdown.ts";
import { anchorForSelection } from "@/lib/selection-anchor.ts";
import {
  composedContains,
  type SelectionEndpoints,
  selectionEndpoints,
} from "@/lib/selection-endpoints.ts";
import {
  buildSegmentIndex,
  type SegmentIndex,
} from "@/lib/spec-source-index.ts";

/** Worn by the element a quotable body renders into. */
export const QUOTE_BODY_ATTR = "data-quote-body";

/** What each quotable body renders, indexed the first time it is quoted. */
const BODIES = new WeakMap<
  Element,
  { source: string; index: SegmentIndex | null }
>();

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
      if (el !== null) BODIES.set(el, { source, index: null });
    },
    [bodyRef, source],
  );
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

/** Whether one of the endpoints is in a shadow root under `body`. */
function endsInShadowOf(ends: SelectionEndpoints, body: Element): boolean {
  return [ends.start.node, ends.end.node].some(
    (node) =>
      node.getRootNode() instanceof ShadowRoot && composedContains(body, node),
  );
}

/**
 * The quotable body under `root` the selection selects text in, and where in
 * its source; null unless that is exactly one body. A selection reaching into
 * a second body is about two of them, so it quotes neither — but one that
 * merely ends at the very start of the next, as a triple-click does, selects
 * no text there and still counts. An end outside the body is clamped to its
 * first or last block, which makes "from here to the end" quotable.
 */
export function quotableSelection(
  selection: Selection | null,
  root: Element | Document,
): QuotableSelection | null {
  if (selection === null) return null;
  const scope = root instanceof Document ? root.documentElement : root;
  const all = endpointsOf(selection, scope);
  if (all === null || all.collapsed) return null;
  const range = lightRange(all);
  const selected = selection.toString() !== "";
  const bodies = [...scope.querySelectorAll(`[${QUOTE_BODY_ATTR}]`)].filter(
    (body) =>
      // Code rows sit in pierre's shadow root, where a light range sees
      // only an empty host: that the selection ends in one says it more
      // reliably than any text the range could find.
      (selected && endsInShadowOf(all, body)) || coversText(range, body),
  );
  const body = bodies.length === 1 ? bodies[0] : undefined;
  const entry = body && BODIES.get(body);
  if (body === undefined || entry === undefined) return null;
  const ends = endpointsOf(selection, body);
  if (ends === null || ends.collapsed) return null;
  entry.index ??= buildSegmentIndex(entry.source);
  const anchor = anchorForSelection(body, entry.index, ends);
  return anchor === null ? null : { body, source: entry.source, anchor };
}

/** An anchor the floating entry offers, with the body it quotes. */
type QuoteAnchor = AnchorRange & { body: Element; source: string };

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
      return picked === null
        ? null
        : { ...picked.anchor, body: picked.body, source: picked.source };
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
      onStage={(anchor) => quote(quoteOfSelection(anchor.source, anchor))}
    >
      <TextQuoteIcon className="size-4" />
      Quote reply
    </SelectionEntry>
  );
}
