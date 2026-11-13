import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import {
  VIEWPORT_CHROME_EVENT,
  visualViewportInsets,
} from "@/lib/viewport-chrome.ts";

/** Page coordinates of the thing to be revealed. */
export type ScrollBlock = { top: number; height: number };

/** Viewport coordinates of the strip no overlay covers. */
export type UsableViewport = { top: number; height: number };

/**
 * `"auto"` centres a block that fits and tops-aligns one that does not;
 * `"start"` demands the top edge even when the block would fit, which is what
 * a file diff wants — its path header under the toolbar (T-190 §5).
 */
export type RevealMode = "auto" | "start";

/** Gap between an overlay's edge and whatever lands against it. */
const BREATHING_ROOM = 8;

/** Which `scrollIntoView` alignment reveals as much of `block` as it can. */
export function blockFor(
  block: ScrollBlock,
  usable: UsableViewport,
  mode: RevealMode = "auto",
): ScrollLogicalPosition {
  if (mode === "start") return "start";
  // Overlays can leave nothing over — a long draft in the composer takes the
  // strip past zero — and centring in a negative strip aims above its own top.
  if (usable.height <= 0) return "start";
  return block.height <= usable.height ? "center" : "start";
}

/**
 * Where the page comes to rest once `scrollIntoView` has placed `block`.
 * ↑↓ and the counter read this instead of performing the scroll, so the number
 * on screen cannot disagree with where the arrow lands (T-61).
 */
export function restingScrollY(
  block: ScrollBlock,
  usable: UsableViewport,
  mode: RevealMode = "auto",
): number {
  if (blockFor(block, usable, mode) === "start") return block.top - usable.top;
  return block.top + block.height / 2 - (usable.top + usable.height / 2);
}

/** `auto` and anything unparseable both mean "no overlay on that edge". */
function pixelsOf(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Read back off `<html>` rather than passed down: the calls that land a target
 * sit deep inside components that know nothing about the page's overlays, and
 * `scroll-padding` is already the value the engine itself obeys.
 */
export function usableViewport(): UsableViewport {
  const style = getComputedStyle(document.documentElement);
  const top = pixelsOf(style.scrollPaddingTop);
  const bottom = pixelsOf(style.scrollPaddingBottom);
  return { top, height: window.innerHeight - top - bottom };
}

/** One-shot highlight; restartable when the same target is revealed again. */
function flash(el: HTMLElement) {
  el.classList.remove("anchor-flash");
  // Reflow so removing+adding the class restarts the animation.
  void el.offsetWidth;
  el.classList.add("anchor-flash");
  el.addEventListener(
    "animationend",
    () => el.classList.remove("anchor-flash"),
    { once: true },
  );
}

/**
 * Open every closed `<details>` between `el` and the document root.
 *
 * A target inside a shut fold has no box at all, so `scrollIntoView` on it
 * does nothing and reports nothing.
 */
export function openEnclosingFolds(el: Element): void {
  for (let from = el.parentElement; from !== null; ) {
    const fold = from.closest("details:not([open])");
    if (fold === null) return;
    fold.setAttribute("open", "");
    from = fold.parentElement;
  }
}

/**
 * Bring `el` into the strip no overlay covers, and flash it. The one landing
 * out of which every anchor, ↑↓ step and per-file jump is served.
 */
export function revealBlock(
  el: HTMLElement,
  {
    mode = "auto",
    behavior,
    flash: highlight = true,
  }: {
    mode?: RevealMode;
    behavior?: ScrollBehavior;
    flash?: boolean;
  } = {},
): void {
  openEnclosingFolds(el);
  const rect = el.getBoundingClientRect();
  const block = blockFor(
    { top: rect.top + window.scrollY, height: rect.height },
    usableViewport(),
    mode,
  );
  el.scrollIntoView({ block, behavior });
  if (highlight) flash(el);
}

/**
 * The page's one hold. Two at once would each put the viewport back on its
 * own target at every resize, so a newer landing retires the older one.
 * `placedAt` is where it last put the page, `placedHeight` how tall the page
 * was then.
 */
let held: {
  release: () => void;
  onEnd: boolean;
  placedAt: number;
  placedHeight: number;
} | null = null;

/** How far short of a landing on the bottom still counts as at the end. */
const END_SLACK = 40;

/**
 * Whether an untouched reader is being held on a particular element, as
 * opposed to the end of the document or nothing at all.
 */
export function isHoldingTarget(): boolean {
  return held !== null && !held.onEnd;
}

/**
 * Where a hold on the end last put the page, or null with no hold or one on a
 * target. An untouched reader held there has not left the end since they
 * landed on it, wherever the page has moved meanwhile: it is still to be put
 * back, or scroll anchoring moved it along with the end.
 */
export function endHeldAt(): number | null {
  return held?.onEnd ? held.placedAt : null;
}

/**
 * Run `place` again every time `container` resizes, until the reader's first
 * input. Returns the release, for when the landing stops mattering first.
 *
 * A landing is made against the page as it stands, and the page keeps
 * arriving after it: images, diffs, attachment lists, each pushing the target
 * away from where it was put (T-188, T-520, T-527). After the first input,
 * re-placing would fight the reader. There is no settle timeout: late
 * content lands with unbounded gaps, and a timer that fires inside one
 * re-opens the race.
 *
 * Dragging the scrollbar counts as input: Chromium and Firefox both deliver
 * its `pointerdown` to `<html>` (measured on T-527).
 *
 * Given `target`, where a placement would put the page now, it also lets go
 * once something else has moved the page off its landing: iOS scrolling to
 * the top at a tap on the status bar, or find in page scrolling to a match,
 * sends none of those inputs, and the next image or new item would put the
 * reader back at the end. Off means all of: away from where it last put the
 * page, more than `END_SLACK` from where it would put it now, and by other
 * than what the page has grown since. A page that grows before the hold has
 * put it back can still deliver the `scroll` of the last placement, the
 * target moved and nobody having moved the page. Scroll anchoring, and the
 * timeline keeping its place as its head mounts above, move the page by just
 * what it grew, usually with the target; a target above what grew stays
 * behind, to be put back once the hold hears of the growth.
 */
function hold(
  container: Element,
  place: (release: () => void) => void,
  onEnd = false,
  target?: () => number,
) {
  held?.release();
  if (typeof ResizeObserver === "undefined") return () => {}; // happy-dom
  const controller = new AbortController();
  const observer = new ResizeObserver(() => {
    place(release);
    if (held?.release !== release) return;
    held.placedAt = window.scrollY;
    held.placedHeight = document.documentElement.scrollHeight;
  });
  const release = () => {
    observer.disconnect();
    controller.abort();
    if (held?.release === release) held = null;
  };
  observer.observe(container);
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    window.addEventListener(type, release, {
      capture: true,
      passive: true,
      signal: controller.signal,
    });
  }
  if (target !== undefined) {
    window.addEventListener(
      "scroll",
      () => {
        if (held?.release !== release) return;
        const y = window.scrollY;
        if (
          Math.abs(y - held.placedAt) > 1 &&
          Math.abs(y - target()) > END_SLACK &&
          Math.abs(
            y -
              held.placedAt -
              (document.documentElement.scrollHeight - held.placedHeight),
          ) > 1
        )
          release();
      },
      { passive: true, signal: controller.signal },
    );
  }
  held = {
    release,
    onEnd,
    placedAt: window.scrollY,
    placedHeight: document.documentElement.scrollHeight,
  };
  return release;
}

/** Hold `el` where `revealBlock` put it; see `hold`. */
export function holdRevealed(
  el: HTMLElement,
  container: Element,
  mode: RevealMode = "auto",
  behavior?: ScrollBehavior,
): () => void {
  return hold(container, (release) => {
    // Gone with a route change nobody touched the page for.
    if (!el.isConnected) release();
    else revealBlock(el, { mode, behavior, flash: false });
  });
}

/** The element ending the page's conversation; see `useScrollInsets`. */
let declaredEnd: RefObject<HTMLElement | null> | null = null;

function endElement(): HTMLElement | null {
  const el = declaredEnd?.current ?? null;
  return el?.isConnected ? el : null;
}

/**
 * Page coordinate of the conversation's end: the bottom edge of the element
 * the page declared, or the document's end on a page that declared none.
 */
export function conversationEnd(): number {
  const el = endElement();
  return el === null
    ? document.documentElement.scrollHeight
    : el.getBoundingClientRect().bottom + window.scrollY;
}

/**
 * The bottom of what the reader sees, in `getBoundingClientRect`'s
 * coordinates: above an on-screen keyboard. Chromium and Firefox measure those
 * from the layout viewport, where the visual one starts `offsetTop` down and
 * `pageTop - scrollY` is that same `offsetTop`; Safari on iOS measures them
 * from the visual viewport itself, its `pageTop` the window's own `scrollY`,
 * and the difference is 0 there.
 *
 * With the keyboard up, iOS moves `scrollY` and client rects as soon as the
 * page scrolls itself, but `pageTop` only at the visual viewport's next
 * update, a frame or two later: read in between, the difference is the
 * distance just scrolled, and a landing placed by it scrolls that far again.
 * So the difference only tells which of the two origins the engine uses.
 */
function visibleBottom(): number {
  const vv = window.visualViewport;
  if (vv == null || Math.abs(vv.scale - 1) > 0.01) return window.innerHeight;
  const fromLayout = Math.abs(vv.pageTop - window.scrollY - vv.offsetTop) < 1;
  return (fromLayout ? vv.offsetTop : 0) + vv.height;
}

/**
 * Where a landing on the bottom puts the page: the conversation's end on the
 * bottom of what the reader sees.
 *
 * Not the document's end, which lies below the shell's footer and, on a narrow
 * screen, below the sidebar that follows the comment box: a landing there put
 * the box a sidebar's height out of sight. Less what an on-screen keyboard
 * covers, so the box's place lands above the keyboard rather than behind it.
 * Measured afresh at every call, since the hold calls again as the page grows.
 *
 * Never past the largest offset there is, and on a page with no declared end
 * exactly that offset, not `scrollHeight`: iOS Safari takes the overshoot
 * literally for a frame, parking the visual viewport a whole screen past the
 * end — one blank white frame on every landing (T-585).
 */
function endTarget(): number {
  const root = document.documentElement;
  const max = Math.max(0, root.scrollHeight - root.clientHeight);
  const el = endElement();
  if (el === null) return max;
  const target =
    el.getBoundingClientRect().bottom + window.scrollY - visibleBottom();
  return Math.min(max, Math.max(0, target));
}

function scrollToEnd() {
  window.scrollTo(0, endTarget());
}

/**
 * Whether the reader is at the end of the conversation: no more than a line or
 * two short of where a landing on the bottom puts the page, or past it with
 * the end still below the top overlays. Past it is a phone's sidebar or a
 * desktop's footer; a reader who has taken the end out of sight above is
 * reading those instead.
 */
export function atConversationEnd(): boolean {
  const y = window.scrollY;
  return (
    y >= endTarget() - END_SLACK && conversationEnd() - y > usableViewport().top
  );
}

/** Go to the end of the conversation and stay there; see `hold`. */
export function landAtBottom(): () => void {
  scrollToEnd();
  return hold(document.body, scrollToEnd, true, endTarget);
}

/**
 * Where `revealBlock` in `"start"` mode puts the page for `el`, in page
 * coordinates.
 */
export function startTarget(el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  return restingScrollY(
    { top: rect.top + window.scrollY, height: rect.height },
    usableViewport(),
    "start",
  );
}

/**
 * Bring `el`'s top under the top overlays, as `revealBlock` does in `"start"`
 * mode, but no further down than a landing on the bottom goes: what follows
 * `el` may be shorter than a screen, and the rest of the way down is the
 * footer or, on a phone, the sidebar below the comment box. Flash it unless
 * told not to, and hold it there; see `hold`. Each placement measures both
 * again, so `el` rises as what follows it loads. While stopped short at the
 * bottom it is a landing on the bottom, and what arrives meanwhile is
 * followed.
 */
export function revealAboveEnd(
  el: HTMLElement,
  { flash: highlight = true }: { flash?: boolean } = {},
): () => void {
  openEnclosingFolds(el);
  if (highlight) flash(el);
  // Where it goes, and whether that stops it short at the bottom.
  const spot = () => {
    const start = startTarget(el);
    const end = endTarget();
    return { y: Math.max(0, Math.min(start, end)), onEnd: start >= end };
  };
  const place = () => {
    const { y, onEnd } = spot();
    window.scrollTo(0, y);
    return onEnd;
  };
  // Placed before it is held, so the hold starts from where it put the page.
  const onEnd = place();
  return hold(
    document.body,
    (release) => {
      // Gone with a route change nobody touched the page for.
      if (!el.isConnected) release();
      else {
        const nowOnEnd = place();
        if (held?.release === release) held.onEnd = nowOnEnd;
      }
    },
    onEnd,
    () => spot().y,
  );
}

/**
 * Keep the release of the last hold this component started, and call it on
 * unmount: a page left without input would otherwise go on being held.
 */
export function useOwnHold(): (release: () => void) => void {
  const own = useRef<() => void>(() => {});
  useEffect(() => () => own.current(), []);
  return useCallback((release: () => void) => {
    own.current();
    own.current = release;
  }, []);
}

export type ScrollInsetSources = {
  /** Overlays pinned to the viewport's top edge, beneath the shell header. */
  top?: ReadonlyArray<RefObject<HTMLElement | null>>;
  bottom?: ReadonlyArray<RefObject<HTMLElement | null>>;
  /**
   * The element whose bottom edge ends the conversation, where landings on
   * the bottom go; without one they go to the document's end.
   */
  end?: RefObject<HTMLElement | null>;
};

/**
 * Declare this page's overlays, so every `scrollIntoView` on it lands clear of
 * them, and where its conversation ends, for the landings on the bottom.
 *
 * `useLayoutEffect`, not `useEffect`: the timeline anchor scrolls from a
 * passive effect in a child, which runs before any passive effect here, and
 * its one-shot guard never offers a second chance. Layout effects run ahead of
 * the whole passive pass, so the insets are always in place first.
 *
 * The elements are measured directly rather than through `useElementHeight`,
 * whose state holds a fallback for one commit — 56 against a real 93 on a
 * narrow screen, exactly across the frame a hard refresh lands in.
 */
export function useScrollInsets({
  top = [],
  bottom = [],
  end,
}: ScrollInsetSources): void {
  const sources = useRef({ top, bottom });
  const remeasure = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const root = document.documentElement;
    const observed = new Set<Element>();
    let observer: ResizeObserver | null = null;
    let pressed: Node | null = null;

    const watch = (el: Element) => {
      if (observed.has(el)) return;
      observed.add(el);
      observer?.observe(el);
    };
    const measure = () => {
      // The shell header covers every route; making each page declare it again
      // would only give them a way to disagree.
      const shell = document.querySelector<HTMLElement>("header");
      // A caret inside a sticky overlay always sits within that overlay's own
      // inset, and Chrome's caret reveal honours scroll-padding: it scrolled
      // the page on every typed character, the overlay riding along, so the
      // caret was never "revealed" (T-519). Every engine's drag-select
      // autoscroll honours it too: a drag begun on an overlay's own text keeps
      // the pointer in that inset, and the page ran to one end of the
      // document. Nothing inside an overlay can be hidden behind it, so the
      // one holding focus or the press under way stops counting.
      const focused = document.activeElement;
      const extent = (el: HTMLElement) =>
        (focused !== null && el.contains(focused)) ||
        (pressed !== null && el.contains(pressed))
          ? 0
          : el.getBoundingClientRect().height;
      // A keyboard covers the layout viewport's bottom and can pan its top
      // out of view; the sticky edges follow it (T-585), and so must the
      // padding, or a reveal would centre its target behind the keyboard.
      const edges = visualViewportInsets();
      // What the header covers runs to its bottom edge, not its height: it
      // rides the visual viewport's top and may have slid partly away.
      let topInset =
        BREATHING_ROOM +
        (shell === null || extent(shell) === 0
          ? edges.top
          : Math.max(edges.top, shell.getBoundingClientRect().bottom));
      if (shell !== null) watch(shell);
      let bottomInset = edges.bottom;
      for (const el of sources.current.top.map((r) => r.current)) {
        if (el === null) continue;
        topInset += extent(el);
        watch(el);
      }
      for (const el of sources.current.bottom.map((r) => r.current)) {
        if (el === null) continue;
        bottomInset += extent(el);
        watch(el);
      }
      root.style.scrollPaddingTop = `${topInset}px`;
      root.style.scrollPaddingBottom = `${bottomInset}px`;
    };
    // Not a finger: iOS drags a selection handle with one touch pointerdown
    // and sends no pointerup or pointercancel after it, which would leave the
    // overlay uncounted until the next press. Nor a press of another button:
    // its context menu may keep the pointerup from the page.
    const press = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      pressed = event.target instanceof Node ? event.target : null;
      measure();
    };
    const release = () => {
      if (pressed === null) return;
      pressed = null;
      measure();
    };

    observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    remeasure.current = measure;
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener(VIEWPORT_CHROME_EVENT, measure);
    document.addEventListener("focusin", measure);
    document.addEventListener("focusout", measure);
    const pointer = { capture: true, passive: true };
    window.addEventListener("pointerdown", press, pointer);
    window.addEventListener("pointerup", release, pointer);
    window.addEventListener("pointercancel", release, pointer);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener(VIEWPORT_CHROME_EVENT, measure);
      document.removeEventListener("focusin", measure);
      document.removeEventListener("focusout", measure);
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      observer?.disconnect();
      root.style.removeProperty("scroll-padding-top");
      root.style.removeProperty("scroll-padding-bottom");
    };
  }, []);

  // An overlay that mounts later — the spec composer opening, the timeline's
  // own composer arriving with the card — had a null ref when the effect above
  // ran, and nothing observes an element that does not exist yet.
  useLayoutEffect(() => {
    sources.current = { top, bottom };
    remeasure.current();
  });

  // The ref rather than the element it holds, read at every landing: one page
  // per document, like the padding, and an element swapped in later is the
  // one landed on.
  useLayoutEffect(() => {
    if (end === undefined) return;
    declaredEnd = end;
    return () => {
      if (declaredEnd === end) declaredEnd = null;
    };
  }, [end]);
}
