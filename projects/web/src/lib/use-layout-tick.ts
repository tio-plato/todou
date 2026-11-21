import { type DependencyList, type RefObject, useEffect, useRef } from "react";

/**
 * Call `callback` once now and then at most once a frame whenever what is
 * on screen may have moved: the page scrolled, the window resized, or
 * `target` changed size, which is how opening a fold or a diagram drawing
 * itself announces a new document height with no scroll event at all.
 *
 * `resized` is false when only the page scrolled since the last call: what
 * lies where on the page is as it was, only the window over it moved.
 *
 * The callback is read through a ref, so a fresh closure per render neither
 * re-subscribes nor misses a frame. `deps` are what the callback measures
 * against besides the page: a change to one of them calls it again.
 */
export function useLayoutTick(
  target: RefObject<HTMLElement | null>,
  callback: (resized: boolean) => void,
  deps: DependencyList = [],
): void {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    let frame = 0;
    let resized = true;
    const run = () => {
      frame = 0;
      const was = resized;
      resized = false;
      latest.current(was);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(run);
    };
    const reflow = () => {
      resized = true;
      schedule();
    };
    run();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", reflow);
    const el = target.current;
    let observer: ResizeObserver | null = null;
    if (el !== null && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(reflow);
      observer.observe(el);
    }
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", reflow);
      observer?.disconnect();
    };
  }, [target]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller names what its callback reads
  useEffect(() => latest.current(true), deps);
}
