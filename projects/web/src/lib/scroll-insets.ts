import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import {
  headerHidden,
  pageLands,
  pageShifted,
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
 * Every overlay's inset, the strip this module's own landings aim at whatever
 * holds focus. `scroll-padding` lets go of the overlays on the edge holding
 * focus, for the browser's own reveals (see `useScrollInsets`). One per page,
 * like the `scroll-padding` beside it; null where no page declared overlays.
 */
let landingInsets: { top: number; bottom: number } | null = null;

function insetsOnRoot(): { top: number; bottom: number } {
  const style = getComputedStyle(document.documentElement);
  return {
    top: pixelsOf(style.scrollPaddingTop),
    bottom: pixelsOf(style.scrollPaddingBottom),
  };
}

/**
 * The part of the visual viewport no overlay covers, in client coordinates,
 * so that it pairs with `getBoundingClientRect()` plus `scrollY` as page
 * coordinates.
 *
 * Read back off the module rather than passed down: the calls that land a
 * target sit deep inside components that know nothing about the page's
 * overlays. With none declared, `scroll-padding` on `<html>` is all there is.
 */
export function usableViewport(): UsableViewport {
  const { top, bottom } = landingInsets ?? insetsOnRoot();
  const edges = visualViewportInsets();
  return {
    top: visualViewportClientTop() + top,
    height: window.innerHeight - edges.top - edges.bottom - top - bottom,
  };
}

/**
 * Where a reading list starts on screen: at the element right before it when
 * that is marked `data-list-lead` as the list's own opening line (the
 * timeline's divider), else at the list's top. Found again on every call,
 * since the lead can be swapped for another element.
 */
export function listTop(list: Element): number {
  const lead = list.previousElementSibling;
  return (
    lead?.hasAttribute("data-list-lead") ? lead : list
  ).getBoundingClientRect().top;
}

/** Whether a reading list's start shows below the top overlays. */
export function listTopShows(list: Element): boolean {
  return listTop(list) > usableViewport().top;
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
    flash: highlight = true,
  }: {
    mode?: RevealMode;
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
  clearingEveryOverlay(() => el.scrollIntoView({ block }));
  if (highlight) flash(el);
}

/**
 * Run `reveal` against every overlay's inset, then hand `<html>` back the one
 * the browser's own reveals use. Every engine fixes where `scrollIntoView`
 * ends when it is called.
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
 * own target at every resize, so a newer landing retires the older one, which
 * hands nothing over to the reader's place. `placedHeight` is how tall the
 * page was when it last put the page somewhere.
 */
let held: {
  release: () => void;
  retire: () => void;
  onEnd: boolean;
  placedHeight: number;
} | null = null;

/**
 * Where the page's owner last put the page: the hold's last placement, or the
 * reader's place put back (`useReadingList`). One for both, since the reader's
 * place stays still while a landing is held.
 */
let placedAt = 0;

/**
 * Whether the scroll that left the page at `y` is the owner's own. Every
 * placement the owner makes is instant, a glide's too, which is placed one
 * frame at a time, so its event finds the page where it put it.
 */
function ownScroll(y: number): boolean {
  return Math.abs(y - placedAt) <= 1;
}

/**
 * The page's reading list: told when a landing takes the page, so that it
 * keeps nothing it would not use meanwhile, and when one lets go of it.
 */
let readingList: { drop: () => void; handOver: () => void } | null = null;

/**
 * A landing begun with no reading list on the page, waiting for the one its
 * own commit declares: a card opened from the cache lands in the commit that
 * mounts its list, ahead of the list's own effect.
 */
let awaitingList: ((list: NonNullable<typeof readingList>) => void) | null =
  null;

/** What the reader does that takes the page over from a landing. */
const INPUTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** How far short of a landing on the bottom still counts as at the end. */
const END_SLACK = 40;

/**
 * Fired on `window` once a glide has ended, arrived or stopped where it got
 * to, unless another has taken over meanwhile.
 */
export const GLIDE_END_EVENT = "todou:glide-end";

/** Whether a landing is gliding to its stop; see `hold`. */
let gliding = false;

/**
 * Whether the page is moving by a landing's glide rather than standing where
 * it was put: what it passes on the way was not read.
 */
export function isGliding(): boolean {
  return gliding;
}

/** The longest a glide takes, however far it goes. */
const GLIDE_MAX_MS = 450;

/**
 * How long a glide over `distance` takes: longer the further it goes, a
 * screen in about 0.28 s, three in 0.36 s, seven or more in 0.45 s.
 */
function glideMs(distance: number): number {
  return Math.min(
    GLIDE_MAX_MS,
    200 + 80 * Math.log2(1 + Math.abs(distance) / window.innerHeight),
  );
}

/** Ease-out cubic: moving from the first frame, slowing into the stop. */
function easeOut(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

/**
 * Whether a landing its caller asked to glide does: not for a reader who
 * asked the system for less motion, nor for a stop gone or no more than a
 * pixel away, nor where nothing can hold it (happy-dom). Asked, the header
 * settles first (see `pageLands`), and the stop is measured against it.
 */
function glides(asked: boolean, destination: () => number | null): boolean {
  if (
    !asked ||
    typeof ResizeObserver === "undefined" ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return false;
  pageLands();
  const to = destination();
  return to !== null && Math.abs(to - window.scrollY) > 1;
}

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
  return held?.onEnd ? placedAt : null;
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
 * page, more than `END_SLACK` from where it would put it now, and further
 * than the page has grown since, or the other way. A page that grows before
 * the hold has put it back can still deliver the `scroll` of the last
 * placement, the target moved and nobody having moved the page. Scroll
 * anchoring moves the page by what grew above what is on screen, which is
 * never more than all that grew, and usually moves the target with it; a
 * target above what grew stays behind, to be put back once the hold hears of
 * the growth.
 *
 * With `target`, the page is also kept from getting shorter than the bottom
 * of the screen where the hold last put it, by a `min-height` on `<html>`,
 * which moves nothing: the shell fills the viewport by its own `min-h-dvh`.
 * A page shrinking under the offset it is at has the browser cut the offset
 * to the new largest one at the next layout, a move nobody made that the rule
 * above cannot tell from one: WebKit can grow the page again in the same
 * task, and the cut's `scroll` then finds the page grown and moved up. Only
 * what shrinks by more than lies below the target reaches the floor, and the
 * next placement lowers it with the page, measured from the end the page
 * declared; a page that declared none, its target the largest offset, would
 * stay on its floor until the hold ends. A card's first landing comes before
 * its page declares the end, so the floor does not wait for one. However the
 * hold ends, the floor goes first, so that the reader's place is picked on
 * the page as its content stands.
 *
 * However it lets go, but for a newer landing taking over, the page passes to
 * the reader's place (`useReadingList`), picked where the page is then: the
 * reading list there when the landing began, or declared in the same commit,
 * not one a new page declared since. A card swapped for another releases its
 * landing as it unmounts, after the next card's list is in, and that card has
 * had no input yet.
 *
 * Given `glide`, where the landing's stop is now (null once its target is
 * gone), the hold first glides the page there from where it stands, in place
 * of the landing's own first placement: one placement a frame, each the
 * owner's own as any other, so nothing that tells its scrolls from others
 * changes. Each is made once the frame is drawn, not in the frame's callback:
 * placed there, iOS draws the sticky header a frame late now and then, the
 * page showing through where it stands. The glide eases out over a time set
 * by its distance, the stop measured again at every placement: what grows
 * above the stop carries the whole path along with it, and the glide arrives
 * on the stop where it is by then. Its progress is time, not frames, so a
 * busy main thread costs frames and never time; one late past its end goes
 * straight to the stop. The page growing meanwhile is put back on the path,
 * not the stop. The time up, the landing places the page itself, where it
 * would have landed at once, and holds it there as ever. However the hold
 * ends, the glide stops where it has got to.
 */
function hold(
  container: Element,
  place: (release: () => void) => void,
  onEnd = false,
  target?: () => number,
  glide?: () => number | null,
) {
  held?.retire();
  if (typeof ResizeObserver === "undefined") return () => {}; // happy-dom
  readingList?.drop();
  let heir = readingList;
  if (heir === null) {
    const adopt = (list: NonNullable<typeof readingList>) => {
      heir = list;
    };
    awaitingList = adopt;
    // A commit's effects all run before any microtask.
    queueMicrotask(() => {
      if (awaitingList === adopt) awaitingList = null;
    });
  }
  const controller = new AbortController();
  // Raised before the page's height is taken, which then has the same floor
  // under it as every height compared with it later.
  const floor = () => {
    if (target === undefined) return;
    document.documentElement.style.setProperty(
      "min-height",
      `${placedAt + window.innerHeight}px`,
    );
  };
  // Under way: when it began, how long it takes, how far it went from where
  // the page stood to where the stop then was, and the next frame's request
  // and placement.
  let path: {
    start: number;
    ms: number;
    distance: number;
    frame: number;
    task: ReturnType<typeof setTimeout> | undefined;
  } | null = null;
  const stopGlide = () => {
    if (path === null) return;
    cancelAnimationFrame(path.frame);
    clearTimeout(path.task);
    path = null;
    gliding = false;
    // Told once whatever ended it has run: a landing that takes over with a
    // glide of its own and no input from the reader, as Back to a comment's
    // address does after the old one is released, ends the move where that
    // glide stops, not here. The reader's own input ends it here.
    queueMicrotask(() => {
      if (!gliding) window.dispatchEvent(new Event(GLIDE_END_EVENT));
    });
  };
  // Where the page was put, which its scroll and the growth after it are
  // read against.
  const placed = () => {
    if (held?.release !== release) return;
    placedAt = window.scrollY;
    floor();
    held.placedHeight = document.documentElement.scrollHeight;
  };
  // Put the page where it goes now: on the glide's path while it lasts,
  // then where the landing puts it, which ends the glide.
  const placeNow = () => {
    const now = performance.now();
    const progress = path === null ? 1 : (now - path.start) / path.ms;
    const to = path !== null && progress < 1 ? (glide?.() ?? null) : null;
    if (path === null || to === null) place(release);
    else
      window.scrollTo(0, onPage(to - path.distance * (1 - easeOut(progress))));
    placed();
    if (to === null) stopGlide();
  };
  const nextFrame = () => {
    const under = path;
    if (under === null) return;
    under.frame = requestAnimationFrame(() => {
      under.task = setTimeout(() => {
        placeNow();
        nextFrame();
      }, 0);
    });
  };
  // Mid-glide, only a page that grew is put back on the path in the frame:
  // the observer reports once as soon as it starts observing, grown or not,
  // and that report would place every glide's first frame in the frame.
  const observer = new ResizeObserver(() => {
    if (
      path !== null &&
      held?.release === release &&
      document.documentElement.scrollHeight === held.placedHeight
    )
      return;
    placeNow();
  });
  const end = (handOver: boolean) => {
    if (controller.signal.aborted) return;
    observer.disconnect();
    controller.abort();
    if (held?.release === release) held = null;
    if (target !== undefined)
      document.documentElement.style.removeProperty("min-height");
    if (handOver && heir !== null && readingList === heir) heir.handOver();
    stopGlide();
  };
  const release = () => end(true);
  // The reader takes over the page as they last saw it: what grew since the
  // last frame, before the observer could put the page back, is put back
  // first, or their place would be picked off a page never drawn. The head
  // arriving and the reader's first scroll can fall in one frame.
  const takeOver = () => {
    if (
      held?.release === release &&
      document.documentElement.scrollHeight !== held.placedHeight
    )
      placeNow();
    release();
  };
  observer.observe(container);
  for (const type of INPUTS) {
    window.addEventListener(type, takeOver, {
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
        const moved = y - placedAt;
        const grown = document.documentElement.scrollHeight - held.placedHeight;
        if (
          !ownScroll(y) &&
          Math.abs(y - target()) > END_SLACK &&
          (moved < Math.min(0, grown) - 1 || moved > Math.max(0, grown) + 1)
        )
          release();
      },
      { passive: true, signal: controller.signal },
    );
  }
  placedAt = window.scrollY;
  floor();
  held = {
    release,
    retire: () => end(false),
    onEnd,
    placedHeight: document.documentElement.scrollHeight,
  };
  const to = glide?.() ?? null;
  if (to !== null) {
    const distance = to - window.scrollY;
    path = {
      start: performance.now(),
      ms: glideMs(distance),
      distance,
      frame: 0,
      task: undefined,
    };
    gliding = true;
    nextFrame();
  }
  return release;
}

/** Hold `el` where `revealBlock` put it; see `hold`. */
export function holdRevealed(
  el: HTMLElement,
  container: Element,
  mode: RevealMode = "auto",
): () => void {
  return hold(container, revealing(finder(el), mode));
}

/**
 * Glide to where `revealBlock` puts `target`, flashing it as that does when
 * the glide begins, and hold it there as `holdRevealed` does; see `hold`. A
 * target passed as a function is found anew for every placing and every
 * frame of the glide. Where it does not glide, it is revealed at once.
 */
export function glideToRevealed(
  target: HTMLElement | (() => HTMLElement | null),
  {
    mode = "auto",
    flash: highlight = true,
  }: { mode?: RevealMode; flash?: boolean } = {},
): () => void {
  const find = finder(target);
  const el = find();
  if (el === null) return () => {};
  openEnclosingFolds(el);
  const stop = () => {
    const now = find();
    return now === null ? null : onPage(startTarget(now, mode));
  };
  if (!glides(true, stop)) {
    revealBlock(el, { mode, flash: highlight });
    return hold(document.body, revealing(find, mode));
  }
  if (highlight) flash(el);
  return hold(document.body, revealing(find, mode), false, undefined, stop);
}

/** A target as `glideToRevealed` takes it, as the function that finds it. */
function finder(
  target: HTMLElement | (() => HTMLElement | null),
): () => HTMLElement | null {
  return typeof target === "function"
    ? target
    : () => (target.isConnected ? target : null);
}

/** The placement holding what `find` finds where `revealBlock` puts it. */
function revealing(
  find: () => HTMLElement | null,
  mode: RevealMode,
): (release: () => void) => void {
  return (release) => {
    const el = find();
    // Gone with a route change nobody touched the page for.
    if (el === null) release();
    else revealBlock(el, { mode, flash: false });
  };
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
  const el = endElement();
  if (el === null) return maxScroll();
  return onPage(
    el.getBoundingClientRect().bottom + window.scrollY - visibleBottom(),
  );
}

/** The largest offset the page can be scrolled to. */
function maxScroll(): number {
  const root = document.documentElement;
  return Math.max(0, root.scrollHeight - root.clientHeight);
}

/** `y` brought within the offsets the page can be scrolled to. */
function onPage(y: number): number {
  return Math.min(maxScroll(), Math.max(0, y));
}

function scrollToEnd() {
  // Before anything is measured: the header settles first (see `pageLands`).
  pageLands();
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

/**
 * Go to the end of the conversation and stay there, gliding there when told
 * to; see `hold`.
 */
export function landAtBottom({
  glide = false,
}: {
  glide?: boolean;
} = {}): () => void {
  if (glides(glide, endTarget))
    return hold(document.body, scrollToEnd, true, endTarget, endTarget);
  scrollToEnd();
  return hold(document.body, scrollToEnd, true, endTarget);
}

/**
 * Where `revealBlock` in `mode`, `"start"` unless told otherwise, puts the
 * page for `el`, in page coordinates.
 */
export function startTarget(
  el: HTMLElement,
  mode: RevealMode = "start",
): number {
  const rect = el.getBoundingClientRect();
  return restingScrollY(
    { top: rect.top + window.scrollY, height: rect.height },
    usableViewport(),
    mode,
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
  {
    flash: highlight = true,
    glide = false,
  }: { flash?: boolean; glide?: boolean } = {},
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
    // Before anything is measured: the header settles first (see `pageLands`).
    pageLands();
    const { y, onEnd } = spot();
    window.scrollTo(0, y);
    return onEnd;
  };
  let own: (() => void) | null = null;
  // Measured again for each frame of a glide, which tells the hold too
  // whether the stop is now short at the bottom.
  const stop = () => {
    if (!el.isConnected) return null;
    const { y, onEnd } = spot();
    if (own !== null && held?.release === own) held.onEnd = onEnd;
    return y;
  };
  const glided = glides(glide, stop);
  // Placed before it is held, so the hold starts from where it put the page.
  const onEnd = glided ? spot().onEnd : place();
  own = hold(
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
    glided ? stop : undefined,
  );
  return own;
}

/**
 * Glide to the page offset `destination()` gives, asked again for every
 * frame and every placing after, and hold the page there as `landAtBottom`
 * holds the end; see `hold`. Where it does not glide, it goes there at once.
 * Null from it means what it measures from is gone, and so is the hold.
 */
export function glideToY(destination: () => number | null): () => void {
  const stop = () => {
    const y = destination();
    return y === null ? null : onPage(y);
  };
  const place = (release: () => void) => {
    // Before anything is measured: the header settles first (see `pageLands`).
    pageLands();
    const y = stop();
    if (y === null) release();
    else window.scrollTo(0, y);
  };
  const target = () => stop() ?? window.scrollY;
  if (glides(true, stop))
    return hold(document.body, place, false, target, stop);
  if (stop() === null) return () => {};
  place(() => {});
  return hold(document.body, place, false, target);
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

/** A unit of the page's reading list, and where its top stood on screen. */
export type ReadingUnit = { key: string; top: number };

/**
 * The unit the reader is reading, and the units beside it on screen to fall
 * back on, nearest first: those below it, or above it for the last unit kept
 * at the end of the conversation.
 *
 * `withList` marks a place that moves with the list's top (`listTop`):
 * whatever moves that top on screen, the page above the list growing or a
 * scroll, moves the units with it, and only what moves them within the list
 * is put back. Their tops are on screen all the same.
 */
export type ReadingPlace = ReadingUnit & {
  after: ReadingUnit[];
  withList?: true;
};

/** Each unit's top moved by `by`, as a scroll of the page moves it. */
function scrolled(place: ReadingPlace, by: number): ReadingPlace {
  return {
    ...place,
    top: place.top - by,
    after: place.after.map((unit) => ({ key: unit.key, top: unit.top - by })),
  };
}

/**
 * Keep what the reader is reading where it is as the page changes around it.
 * With the landings `hold` keeps, the one thing on the page that scrolls it
 * by itself; one per page, declared by the page's reading list.
 *
 * `pick` names the unit being read in `list`, where its top is, and the units
 * beside it; null when the reader is reading nothing in the list. Given the
 * element a click landed on, it names that element's unit instead, or
 * answers undefined when that is no unit, and the place is picked again as
 * after a scroll. A click or a typed key outside the list is put to it too:
 * null lets go of the place, the reader having pressed or typed on what
 * precedes the list, and any other answer leaves it as it is. `locate` finds
 * a unit again by its key.
 *
 * Nothing is picked before the reader's first input or the first landing to
 * let go of the page: until then the page is still assembling itself, a
 * comment link's folds opening toward their target say, and nobody's place
 * is in it. From then on every scroll the owner did not make picks again,
 * and so does an input that ends a landing or finds nothing kept; a typed
 * key moves nothing, and one that scrolls is heard as its scroll. A click in
 * the list takes the unit it landed on, so what it opens grows downward from
 * where the reader pressed. A click or a typed key on what precedes the list
 * lets go instead, the key landing where the focus is: what the reader opened
 * or types in the card's body stays put while the list changes. A scroll is
 * picked by where the page is, whatever made it.
 *
 * While a landing is held it owns the page, and nothing is put back.
 * Otherwise every resize of the page or of the list's column, and every
 * commit of the component declaring the list, puts the unit back: a commit
 * can move it with no resize at all, the tail sliding by an item as tall as
 * the one arriving. The commit's layout effect is declared where this is
 * called, so the caller's own effects declared after it measure the page put
 * back. The column counts as well as the page: where the sidebar is the
 * taller column, the page does not grow with the list's.
 *
 * Only what the content did is put back. Whatever scrolled the page since the
 * owner last knew where it was is the reader's: a fling Firefox and iOS have
 * applied before its scroll event, a caret CodeMirror revealed in an
 * animation frame, find in page. So the browser's own scroll anchoring is off
 * while a unit is kept, or its adjustments would be taken for the reader's
 * and made twice. Put back toward the top it had when picked, every time, so
 * that a scroll step's rounding never adds up; and at once, while the reader
 * scrolls too, since what they read is what stays put, at the cost of a
 * fling or smooth scroll cut short. Gone, the first unit after it still on
 * the page stands in, and the reader's place is picked again from there;
 * all gone, nothing moves until the next pick.
 *
 * A place kept at the end with the body above the list still in view moves
 * with the list's top instead (`withList`): what grows above the list and
 * the reader's own scrolls move that top and the place with it, so only what
 * moves the unit within the list is put back, and editing the body pushes
 * nobody. The top is the divider line's, which belongs to the list: as it
 * shrinks with the card's last hidden comment revealed, what was pressed is
 * put back. Once a put back has taken the list's top under the top overlays,
 * the place is measured from the screen like any other.
 *
 * The auto-hiding header is told how far the page really moved, which the
 * page's ends can make less than asked: it is the page placing itself, not
 * the reader scrolling, and never a landing, which would settle the header
 * under a finger still dragging the page.
 */
export function useReadingList(
  list: RefObject<HTMLElement | null>,
  pick: (list: HTMLElement, at?: Element) => ReadingPlace | null | undefined,
  locate: (list: HTMLElement, key: string) => HTMLElement | null,
): void {
  const latest = useRef({ pick, locate });
  const sync = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const root = document.documentElement;
    let started = false;
    let place: ReadingPlace | null = null;
    // Where the page and the list's top were when this last knew, and
    // whether the next scroll event may be the one its own put back made.
    let seenY = window.scrollY;
    let seenListTop = 0;
    let shifted = false;
    const keep = (next: ReadingPlace | null) => {
      if (next === null && place !== null)
        root.style.removeProperty("overflow-anchor");
      else if (next !== null && place === null)
        root.style.setProperty("overflow-anchor", "none");
      place = next;
      seenY = window.scrollY;
      seenListTop = list.current === null ? 0 : listTop(list.current);
    };
    const repick = () => {
      const el = list.current;
      keep(el === null ? null : (latest.current.pick(el) ?? null));
    };
    // Whether a click or a key landed outside the list on what `pick` lets
    // go for.
    const landsAbove = (target: EventTarget | null) => {
      const el = list.current;
      return (
        el !== null &&
        target instanceof Element &&
        !el.contains(target) &&
        latest.current.pick(el, target) === null
      );
    };
    const onInput = (event: Event) => {
      // A landing letting go hands the page over itself.
      if (held !== null) return;
      started = true;
      // Only a key: a press, a wheel or a touch on the body may scroll
      // nothing and bring no click, and nothing would pick the place again.
      if (event.type === "keydown" && landsAbove(event.target)) keep(null);
      else if (place === null) repick();
    };
    const onClick = (event: MouseEvent) => {
      const el = list.current;
      if (held !== null || el === null) return;
      if (!(event.target instanceof Element)) return;
      if (!el.contains(event.target)) {
        if (landsAbove(event.target)) keep(null);
        return;
      }
      started = true;
      const picked = latest.current.pick(el, event.target);
      if (picked === undefined) repick();
      else keep(picked);
    };
    const onScroll = () => {
      if (held !== null) return;
      const own = shifted && ownScroll(window.scrollY);
      shifted = false;
      if (own) seenY = window.scrollY;
      else if (started) repick();
    };
    const putBack = () => {
      const el = list.current;
      if (held !== null || place === null || el === null) return;
      const { locate: find } = latest.current;
      const y = window.scrollY;
      const kept = scrolled(
        place,
        place.withList ? seenListTop - listTop(el) : y - seenY,
      );
      seenY = y;
      place = kept;
      let unit = find(el, kept.key);
      let wanted = kept.top;
      let fellBack = false;
      for (const next of kept.after) {
        if (unit !== null) break;
        unit = find(el, next.key);
        wanted = next.top;
        fellBack = true;
      }
      if (unit === null) {
        keep(null);
        return;
      }
      const delta = unit.getBoundingClientRect().top - wanted;
      if (delta !== 0) {
        window.scrollBy(0, delta);
        seenY = window.scrollY;
        if (seenY !== y) {
          placedAt = seenY;
          shifted = true;
          pageShifted(seenY - y);
        }
      }
      // Its own scroll moved the list's top too, and is no move within it.
      seenListTop = listTop(el);
      if (fellBack) {
        repick();
        return;
      }
      // What stands beside it moves against it as the unit itself grows.
      place = {
        key: kept.key,
        top: kept.top,
        after: kept.after.flatMap((next) => {
          const found = find(el, next.key);
          return found === null
            ? []
            : [{ key: next.key, top: found.getBoundingClientRect().top }];
        }),
      };
      // Once the list's top has gone under the top overlays, the body out of
      // view, the place is measured from the screen like any other.
      if (kept.withList && listTopShows(el)) place.withList = true;
    };
    const own = {
      drop: () => {
        keep(null);
        shifted = false;
      },
      handOver: () => {
        started = true;
        repick();
      },
    };
    readingList = own;
    awaitingList?.(own);
    awaitingList = null;
    const controller = new AbortController();
    for (const type of INPUTS) {
      window.addEventListener(type, onInput, {
        capture: true,
        passive: true,
        signal: controller.signal,
      });
    }
    window.addEventListener("click", onClick, {
      capture: true,
      passive: true,
      signal: controller.signal,
    });
    window.addEventListener("scroll", onScroll, {
      passive: true,
      signal: controller.signal,
    });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(putBack);
    observer?.observe(document.body);
    let column: Element | null = null;
    sync.current = () => {
      const parent = list.current?.parentElement ?? null;
      if (parent !== column) {
        if (column !== null) observer?.unobserve(column);
        if (parent !== null) observer?.observe(parent);
        column = parent;
      }
      putBack();
    };
    return () => {
      controller.abort();
      observer?.disconnect();
      sync.current = () => {};
      keep(null);
      if (readingList === own) readingList = null;
    };
  }, [list]);

  useLayoutEffect(() => {
    latest.current = { pick, locate };
    sync.current();
  });
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
        (shell === null
          ? 0
          : Math.max(0, shell.getBoundingClientRect().height - headerHidden()));
      if (shell !== null) watch(shell);
      let bottomInset = 0;
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
      // no overlay and no gap, nothing past the visual viewport's edge: the
      // overlays stacked inside the holder would still cover it. Nor does it
      // depend on where the holder stands, which no scroll re-measures: a
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
      root.style.scrollPaddingTop = `${topHeld ? 0 : topInset}px`;
      root.style.scrollPaddingBottom = `${bottomHeld ? 0 : bottomInset}px`;
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
      const rect = target.getBoundingClientRect();
      if (rect.top < visualViewportClientTop() || rect.bottom > visibleBottom())
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
