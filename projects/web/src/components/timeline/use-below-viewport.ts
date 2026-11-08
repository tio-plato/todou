import { useEffect, useState } from "react";

/**
 * Whether `el` is below the viewport: `true` while it is, `false` while it is
 * on screen or anywhere above it, `null` before the first reading and where
 * the engine has no IntersectionObserver.
 *
 * The observer's root reaches far above the viewport, so all of the page
 * above it counts as inside and leaving the root can only mean going below.
 * A root of the viewport alone reads "not intersecting" on both sides, and
 * calls back only when that changes: a jump straight from below to above or
 * back — `window.scrollTo`, Home, an anchor — never calls it, and the reading
 * stays on the side the element left. Stretched upwards, the root's bottom
 * edge lies across every such jump.
 */
export function useBelowViewport(el: Element | null): boolean | null {
  const [below, setBelow] = useState<boolean | null>(null);
  useEffect(() => {
    if (el === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry !== undefined) setBelow(!entry.isIntersecting);
      },
      { rootMargin: "100000px 0px 0px 0px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      setBelow(null);
    };
  }, [el]);
  return below;
}
