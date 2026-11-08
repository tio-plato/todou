import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import {
  headerHidden,
  VIEWPORT_CHROME_EVENT,
  visualViewportClientTop,
  visualViewportInsets,
} from "@/lib/viewport-chrome.ts";

/** Page coordinates of the thing to be revealed. */
export type ScrollBlock = { top: number; height: number };

/** Client coordinates of the strip no overlay covers. */
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
 * The part of the visual viewport no overlay covers, in client coordinates,
 * so that it pairs with `getBoundingClientRect()` plus `scrollY` as page
 * coordinates.
 *
 * Read back off `<html>` rather than passed down: the calls that land a target
 * sit deep inside components that know nothing about the page's overlays, and
 * `scroll-padding` is already the value the engine itself obeys.
 */
export function usableViewport(): UsableViewport {
  const style = getComputedStyle(document.documentElement);
  const top = pixelsOf(style.scrollPaddingTop);
  const bottom = pixelsOf(style.scrollPaddingBottom);
  const edges = visualViewportInsets();
  return {
    top: visualViewportClientTop() + top,
    height: window.innerHeight - edges.top - edges.bottom - top - bottom,
  };
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
 */
let held: { release: () => void; onEnd: boolean } | null = null;

/**
 * Whether an untouched reader is being held on a particular element, as
 * opposed to the end of the document or nothing at all.
 */
export function isHoldingTarget(): boolean {
  return held !== null && !held.onEnd;
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
 */
function hold(
  container: Element,
  place: (release: () => void) => void,
  onEnd = false,
) {
  held?.release();
  if (typeof ResizeObserver === "undefined") return () => {}; // happy-dom
  const controller = new AbortController();
  const observer = new ResizeObserver(() => place(release));
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
  held = { release, onEnd };
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
 * from the layout viewport, where the visual one starts `pageTop - scrollY`
 * down; Safari on iOS measures them from the visual viewport itself, its
 * `pageTop` the window's own `scrollY`, and the same sum gives 0 there.
 */
function visibleBottom(): number {
  const vv = window.visualViewport;
  if (vv == null || Math.abs(vv.scale - 1) > 0.01) return window.innerHeight;
  return vv.pageTop - window.scrollY + vv.height;
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

/** Go to the end of the conversation and stay there; see `hold`. */
export function landAtBottom(): () => void {
  scrollToEnd();
  return hold(document.body, scrollToEnd, true);
}

/** Where `revealBlock` in `"start"` mode puts the page for `el`. */
function startTarget(el: HTMLElement): number {
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
 * footer or, on a phone, the sidebar below the comment box. Flash it, and
 * hold it there; see `hold`. Each placement measures both again, so `el` rises
 * as what follows it loads. While stopped short at the bottom it is a landing
 * on the bottom, and what arrives meanwhile is followed.
 */
export function revealAboveEnd(el: HTMLElement): () => void {
  openEnclosingFolds(el);
  flash(el);
  const place = () => {
    const start = startTarget(el);
    const end = endTarget();
    window.scrollTo(0, Math.max(0, Math.min(start, end)));
    if (held?.release === release) held.onEnd = start >= end;
  };
  const release = hold(document.body, (release) => {
    // Gone with a route change nobody touched the page for.
    if (!el.isConnected) release();
    else place();
  });
  place();
  return release;
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
      // Both engines resolve the root's scroll-padding against the visual
      // viewport, which already ends at an on-screen keyboard: WebKit grows
      // the target by it inside `visualViewportRect()`
      // (`LocalFrameView::scrollRectToVisible`), Blink shrinks the visual
      // viewport by it (`RootFrameViewport::VisibleScrollSnapportRect`). So
      // every term is measured from the visual viewport's edges. Adding its
      // offsets as well counted the keyboard twice and moved the padding with
      // every pan, and iOS, which reveals the caret on each keystroke, threw
      // the page past the caret to the other side every time.
      // The header counts its height less the share it has slid away, not its
      // bottom edge: that edge carries `offsetTop` in Blink and lags a pan by
      // a frame in WebKit.
      let topInset =
        BREATHING_ROOM +
        (shell === null ? 0 : Math.max(0, extent(shell) - headerHidden()));
      if (shell !== null) watch(shell);
      let bottomInset = 0;
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
