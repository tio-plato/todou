import { type RefObject, useEffect, useRef } from "react";

/**
 * Call `callback` once now and then at most once a frame whenever what is
 * on screen may have moved: the page scrolled, the window resized, or
 * `target` changed size, which is how opening a fold or a diagram drawing
 * itself announces a new document height with no scroll event at all.
 *
 * The callback is read through a ref, so a fresh closure per render neither
 * re-subscribes nor misses a frame.
 */
export function useLayoutTick(
  target: RefObject<HTMLElement | null>,
  callback: () => void,
): void {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    let frame = 0;
    const run = () => {
      frame = 0;
      latest.current();
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(run);
    };
    run();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const el = target.current;
    let observer: ResizeObserver | null = null;
    if (el !== null && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(el);
    }
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [target]);
}
