import { useCallback, useEffect, useRef } from "react";

/** Down the page, or up it. */
export type ScrollDirection = 1 | -1;

/**
 * How long after an input the window's movement is still the reader's: long
 * enough for a browser's smooth scroll to play out.
 */
const INPUT_LASTS_MS = 1000;
/** How far the window has to move one way before it counts, past a jitter. */
const MIN_TRAVEL = 8;

/** Where the keys move a caret or a selection rather than the page. */
const EDITABLE =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function keyDirection(event: KeyboardEvent): ScrollDirection | null {
  if (event.target instanceof Element && event.target.closest(EDITABLE))
    return null;
  switch (event.key) {
    case "ArrowDown":
    case "PageDown":
      return 1;
    case "ArrowUp":
    case "PageUp":
    case "Home":
      return -1;
    case " ":
      return event.shiftKey ? -1 : 1;
    default:
      return null;
  }
}

/**
 * Call `onScroll` each time the reader scrolls the page, with which way.
 * Returns a function that forgets the input seen so far, for a scroll about
 * to be made on the reader's behalf.
 *
 * The direction comes from the reader's input — the wheel, a dragging finger,
 * the scrolling keys, the scrollbar — and counts once the window itself has
 * moved that way within a second of it. A wheel turned over a scrollable box
 * moves the box alone, and the page's own scrolls come with no input at all:
 * a landing and its hold, an anchor, keeping the reader's place while content
 * arrives above it.
 */
export function useReaderScroll(
  onScroll: (direction: ScrollDirection) => void,
): () => void {
  const callback = useRef(onScroll);
  callback.current = onScroll;
  const forget = useRef(() => {});

  useEffect(() => {
    let intent: { direction: ScrollDirection; at: number } | null = null;
    let travel = 0;
    let lastY = window.scrollY;
    let touchY: number | null = null;
    let dragging = false;

    const intend = (direction: ScrollDirection) => {
      const now = performance.now();
      if (
        intent === null ||
        intent.direction !== direction ||
        now - intent.at > INPUT_LASTS_MS
      )
        travel = 0;
      intent = { direction, at: now };
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) intend(event.deltaY > 0 ? 1 : -1);
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined) return;
      // A finger moving up drags the page down.
      if (touchY !== null && y !== touchY) intend(y < touchY ? 1 : -1);
      touchY = y;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = keyDirection(event);
      if (direction !== null) intend(direction);
    };
    // Chromium and Firefox both deliver a press on the scrollbar to `<html>`.
    const onPointerDown = (event: PointerEvent) => {
      dragging = event.target === document.documentElement;
    };
    const onPointerUp = () => {
      dragging = false;
    };
    // A drag released outside the window may send no pointerup at all; the
    // next move over the page with no button down says it is over.
    const onPointerMove = (event: PointerEvent) => {
      if (event.buttons === 0) dragging = false;
    };
    const onWindowScroll = () => {
      const moved = window.scrollY - lastY;
      lastY = window.scrollY;
      if (moved === 0) return;
      const direction: ScrollDirection = moved > 0 ? 1 : -1;
      // Dragging the scrollbar, the movement is the input.
      if (dragging) intend(direction);
      if (intent === null || performance.now() - intent.at > INPUT_LASTS_MS)
        return;
      if (direction !== intent.direction) {
        travel = 0;
        return;
      }
      travel += Math.abs(moved);
      if (travel >= MIN_TRAVEL) callback.current(direction);
    };

    forget.current = () => {
      intent = null;
      travel = 0;
      dragging = false;
    };
    const controller = new AbortController();
    const options = { capture: true, passive: true, signal: controller.signal };
    window.addEventListener("wheel", onWheel, options);
    window.addEventListener("touchstart", onTouchStart, options);
    window.addEventListener("touchmove", onTouchMove, options);
    window.addEventListener("keydown", onKeyDown, options);
    window.addEventListener("pointerdown", onPointerDown, options);
    window.addEventListener("pointerup", onPointerUp, options);
    window.addEventListener("pointercancel", onPointerUp, options);
    window.addEventListener("pointermove", onPointerMove, options);
    window.addEventListener("scroll", onWindowScroll, options);
    return () => {
      controller.abort();
      forget.current = () => {};
    };
  }, []);

  return useCallback(() => forget.current(), []);
}
