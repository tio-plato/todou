import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import {
  pageLands,
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
 * Every overlay's inset, the strip this module's own landings aim at whatever
 * holds focus. `scroll-padding` lets go of the overlays on the edge holding
 * focus, for the browser's own reveals (see `useScrollInsets`). One per page,
 * like the `scroll-padding` beside it; null where no page declared overlays.
 */
let landingInsets: { top: number; bottom: number } | null = null;

/**
 * Read back off the module rather than passed down: the calls that land a
 * target sit deep inside components that know nothing about the page's
 * overlays. With none declared, `scroll-padding` on `<html>` is all there is.
 */
export function usableViewport(): UsableViewport {
  if (landingInsets !== null) {
    const { top, bottom } = landingInsets;
    return { top, height: window.innerHeight - top - bottom };
  }
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
  // Before anything is measured: the header settles first (see `pageLands`).
  pageLands();
  openEnclosingFolds(el);
  const rect = el.getBoundingClientRect();
  const block = blockFor(
    { top: rect.top + window.scrollY, height: rect.height },
    usableViewport(),
    mode,
  );
  clearingEveryOverlay(() => el.scrollIntoView({ block, behavior }));
  if (highlight) flash(el);
}

/**
 * Run `reveal` against every overlay's inset, then hand `<html>` back the one
 * the browser's own reveals use. Every engine fixes where `scrollIntoView`
 * ends when it is called, a smooth one included.
 */
function clearingEveryOverlay(reveal: () => void) {
  if (landingInsets === null) return reveal();
  const style = document.documentElement.style;
  const { scrollPaddingTop, scrollPaddingBottom } = style;
  style.scrollPaddingTop = `${landingInsets.top}px`;
  style.scrollPaddingBottom = `${landingInsets.bottom}px`;
  try {
    reveal();
  } finally {
    style.scrollPaddingTop = scrollPaddingTop;
    style.scrollPaddingBottom = scrollPaddingBottom;
  }
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

/**
 * Bottom of the document, which sits below a sticky composer's in-flow spot.
 *
 * The largest offset there is, not `scrollHeight`: iOS Safari takes the
 * overshoot literally for a frame, parking the visual viewport a whole screen
 * past the end — one blank white frame on every landing (T-585).
 */
function scrollToEnd() {
  // Before anything is measured: the header settles first (see `pageLands`).
  pageLands();
  const root = document.documentElement;
  window.scrollTo(0, Math.max(0, root.scrollHeight - root.clientHeight));
}

/** Go to the end of the document and stay there; see `hold`. */
export function landAtBottom(): () => void {
  scrollToEnd();
  return hold(document.body, scrollToEnd, true);
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
};

/**
 * Declare this page's overlays, so every `scrollIntoView` on it lands clear of
 * them.
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
    const overlays = () => {
      const declared = (refs: ReadonlyArray<RefObject<HTMLElement | null>>) =>
        refs.flatMap((r) => (r.current === null ? [] : [r.current]));
      return {
        // The shell header covers every route; making each page declare it
        // again would only give them a way to disagree.
        shell: document.querySelector<HTMLElement>("header"),
        top: declared(sources.current.top),
        bottom: declared(sources.current.bottom),
      };
    };
    const measure = () => {
      const { shell, top, bottom } = overlays();
      // A keyboard covers the layout viewport's bottom and can pan its top
      // out of view; the sticky edges follow it (T-585), and so must the
      // padding, or a reveal would centre its target behind the keyboard.
      const edges = visualViewportInsets();
      // What the header covers runs to its bottom edge, not its height: it
      // rides the visual viewport's top and may have slid partly away.
      let topInset =
        BREATHING_ROOM +
        (shell === null
          ? edges.top
          : Math.max(edges.top, shell.getBoundingClientRect().bottom));
      if (shell !== null) watch(shell);
      let bottomInset = edges.bottom;
      for (const el of top) {
        topInset += el.getBoundingClientRect().height;
        watch(el);
      }
      for (const el of bottom) {
        bottomInset += el.getBoundingClientRect().height;
        watch(el);
      }
      landingInsets = { top: topInset, bottom: bottomInset };
      // The browser's own reveals honour scroll-padding as well, and an
      // overlay is sticky: whatever of it the inset covers, no scroll ever
      // uncovers. The caret reveals of Chromium and WebKit scrolled the page
      // on every typed character, the overlay riding along (T-519); WebKit
      // reveals the control Tab lands on after focusin, and Tab through the
      // header ran the page up a screen at a time. Every engine's drag-select autoscroll
      // honours it too: a drag begun on an overlay's own text kept the
      // pointer in that inset, and the page ran to one end of the document.
      // So the edge whose overlay holds focus or the press under way counts
      // no overlay and no gap, only what the visual viewport hides there:
      // the overlays stacked inside the holder would still cover it. Nor does
      // it depend on where the holder stands, which no scroll re-measures: a
      // composer focused while it sat in the page, short of the bottom, was
      // covered again once scrolled up to pin. While focus stays inside, the
      // browser reveals only what that overlay holds, and landings read
      // every overlay off `landingInsets`.
      const focused = document.activeElement;
      const holds = (el: HTMLElement) =>
        (focused !== null && el.contains(focused)) ||
        (pressed !== null && el.contains(pressed));
      const topHeld = (shell === null ? top : [shell, ...top]).some(holds);
      const bottomHeld = bottom.some(holds);
      root.style.scrollPaddingTop = `${topHeld ? edges.top : topInset}px`;
      root.style.scrollPaddingBottom = `${bottomHeld ? edges.bottom : bottomInset}px`;
    };
    // Chromium reveals the element Tab moves focus onto before its focus
    // event, against the inset of the moment the old one let go of focus:
    // every overlay counted, since nothing held focus then. A pinned overlay
    // does not move with the page, so the page goes back where the keystroke
    // found it. Tab from no focus at all has no focusout to act on, but every
    // focus move a key makes happens in that key's own task, so the position
    // is kept for that task alone; a later focusin is no keystroke's.
    let keyedAt: number | null = null;
    const key = () => {
      keyedAt = window.scrollY;
      setTimeout(() => {
        keyedAt = null;
      }, 0);
    };
    const keepStill = (target: EventTarget | null) => {
      const from = keyedAt;
      const revealed = window.scrollY;
      if (from === null || from === revealed || !(target instanceof Element))
        return;
      const { shell, top, bottom } = overlays();
      if (![shell, ...top, ...bottom].some((el) => el?.contains(target)))
        return;
      window.scrollTo(window.scrollX, from);
      // Not every overlay is pinned where it stands: the composer settles
      // back into the page at its end, and a narrow screen slides the header
      // away. A reveal that brought the control into sight was a real one.
      const edges = visualViewportInsets();
      const rect = target.getBoundingClientRect();
      if (
        rect.top < edges.top ||
        rect.bottom > window.innerHeight - edges.bottom
      )
        window.scrollTo(window.scrollX, revealed);
    };
    const arrive = (event: FocusEvent) => {
      keepStill(event.target);
      measure();
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
    document.addEventListener("focusin", arrive);
    document.addEventListener("focusout", measure);
    window.addEventListener("keydown", key, { capture: true, passive: true });
    const pointer = { capture: true, passive: true };
    window.addEventListener("pointerdown", press, pointer);
    window.addEventListener("pointerup", release, pointer);
    window.addEventListener("pointercancel", release, pointer);
    // A press held while the window loses focus — switching apps, a native
    // dialog — ends with its pointerup delivered elsewhere, and until the next
    // press any scrollIntoView could park its target behind the overlay.
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener(VIEWPORT_CHROME_EVENT, measure);
      document.removeEventListener("focusin", arrive);
      document.removeEventListener("focusout", measure);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", release);
      observer?.disconnect();
      landingInsets = null;
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
}
