/** What ↑↓ stops on: both kinds of "changed since the baseline" mark (T-158). */
export const CHANGED_SELECTOR = ".spec-changed, .spec-ins-block";

/**
 * The stops inside `root`, in document order and never one inside another.
 *
 * ↑↓ have always stepped over blocks — a paragraph with three edited words is
 * one stop, because the word-level marks are not in the selector. A swapped
 * image is the one mark that lands on an inline element, so the `<img>` and
 * the paragraph holding it both match (T-223); left in, one edit would stop
 * the reader twice a few pixels apart and count as two.
 */
export function stopsIn(root: HTMLElement, selector: string): HTMLElement[] {
  const stops: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(selector)) {
    // An ancestor comes first in document order, so the stop kept last is the
    // only one that can contain this element.
    if (stops.at(-1)?.contains(el) === true) continue;
    stops.push(el);
  }
  return stops;
}

/**
 * One navigation decision's inputs. Both ↑↓ and the counter read the same
 * `Stops`, so the number on screen is always the one the arrow will land on.
 */
export type Stops = {
  /** Page coordinates, ascending. */
  positions: number[];
  /** The line a candidate at rest aligns with, in the same coordinates. */
  pivot: number;
  tolerance?: number;
};

/**
 * How far off the pivot a candidate may sit and still count as the one the
 * reader is on. `scrollIntoView` lands a pixel or two off, and a candidate
 * that fails to exclude itself from both directions is one ↑↓ keeps
 * re-finding — the jam T-61 was opened about.
 */
const DEFAULT_TOLERANCE = 8;

/** Which candidate `direction` lands on, or -1 when there is none that way. */
export function stepIndex(
  { positions, pivot, tolerance = DEFAULT_TOLERANCE }: Stops,
  direction: 1 | -1,
): number {
  return direction === 1
    ? positions.findIndex((p) => p > pivot + tolerance)
    : positions.findLastIndex((p) => p < pivot - tolerance);
}

/**
 * Which candidate the reader is on, 1-based; 0 above all of them.
 *
 * Identical to `stepIndex(stops, 1)` by construction, which is what keeps the
 * counter and the arrows from describing the same screen differently: one ↓
 * always adds one, one ↑ always subtracts one.
 */
export function currentIndex(stops: Stops): number {
  const next = stepIndex(stops, 1);
  return next === -1 ? stops.positions.length : next;
}

const TYPING_TAGS = ["INPUT", "TEXTAREA", "SELECT"];

/** Radix runs its own first-letter typeahead over these same keys. */
const OVERLAY_SELECTOR = '[role="menu"],[role="dialog"],[role="listbox"]';

/**
 * Whether this keystroke is a navigation. A modifier belongs to the browser,
 * and an IME emits plain letters while composing pinyin — without this the
 * page would jump under a reader who is only typing.
 */
export function acceptsShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (target === null) return true;
  if (target.isContentEditable) return false;
  if (TYPING_TAGS.includes(target.tagName)) return false;
  // The target is not always an element — window and document both dispatch
  // here, and neither sits inside an overlay.
  if (typeof target.closest !== "function") return true;
  return target.closest(OVERLAY_SELECTOR) === null;
}
