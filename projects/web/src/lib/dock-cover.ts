import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * The folded phone composer's floating button: `OPENER` in composer.tsx,
 * repeated rather than imported so this module does not reach into a
 * component.
 */
const OPENER = "[data-composer-opener]";

/**
 * How much of the viewport's bottom the floating composer covers. Only the
 * layer that actually floats counts: the dock while it is sticky, and while a
 * folded dock waits at the page end as ordinary content on a phone (T-585),
 * the button standing in for it, from the visual viewport's bottom to the
 * button's top. Whether the dock floats is read from its computed `position`
 * rather than by restating the `max-sm:has-[[data-collapsed]]:static` rule it
 * gets that from, so the two cannot drift apart.
 */
function dockCover(dock: HTMLElement | null): number {
  if (dock === null) return 0;
  if (getComputedStyle(dock).position !== "static")
    return dock.getBoundingClientRect().height;
  const opener = dock.querySelector(OPENER)?.getBoundingClientRect();
  if (opener === undefined || opener.height === 0) return 0;
  // The button rides the `--vv-bottom` the shell last published, and so do
  // the layers above it: a fresh reading of the visual viewport could be one
  // the shell has not published yet.
  const ridden = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--vv-bottom"),
  );
  return window.innerHeight - (Number.isNaN(ridden) ? 0 : ridden) - opener.top;
}

/**
 * Publish what the comment composer covers on `<html>` as `--dock-cover`, for
 * the layers that float above it (`aboveDock`). The composer's height is a
 * runtime value: it unfolds, a draft grows it, staged files and errors stack
 * onto it, and no fixed offset clears all of those.
 *
 * Measured in a layout effect, so the variable is there for the first paint,
 * and again from a `ResizeObserver`, whose callback runs after layout and
 * before paint: the layers above move in the same frame the dock grows. Only
 * those layers read the variable, never the dock, so the observer cannot loop.
 */
export function useDockCover(dock: RefObject<HTMLElement | null>): void {
  const follow = useRef<(el: HTMLElement | null) => void>(() => {});

  useLayoutEffect(() => {
    const root = document.documentElement;
    let current: HTMLElement | null = null;
    const measure = () =>
      root.style.setProperty("--dock-cover", `${dockCover(current)}px`);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    follow.current = (el) => {
      if (el === current) return;
      if (current !== null) observer?.unobserve(current);
      current = el;
      // The border box is what covers the page, and unfolding changes the
      // dock's padding as well as its content.
      if (el !== null) observer?.observe(el, { box: "border-box" });
      measure();
    };
    if (observer !== null) window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
      follow.current = () => {};
      root.style.removeProperty("--dock-cover");
    };
  }, []);

  // The page swaps the dock out while the card is in the trash and mounts a
  // new one when it comes back, and an observer left on the detached element
  // would keep the old value.
  useLayoutEffect(() => {
    follow.current(dock.current);
  });
}

/**
 * A sticky `bottom` for a layer floating `gap` pixels above the comment
 * composer, which itself rides the visual viewport's bottom (`--vv-bottom`):
 * above an on-screen keyboard, the layer clears both.
 */
export function aboveDock(gap: number): string {
  return `calc(${gap}px + var(--vv-bottom, 0px) + var(--dock-cover, 0px))`;
}
