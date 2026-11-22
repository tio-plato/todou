import {
  atConversationEnd,
  type ReadingPlace,
  type ReadingUnit,
  topShows,
  type UsableViewport,
  usableViewport,
} from "@/lib/scroll-insets.ts";

/**
 * Whether the seam between the head and the tail, `seamTop` down the
 * viewport, says the reader came up from the tail (T-30). In the upper half,
 * the tail side is what they are reading, and it stays where it is as the
 * seam changes; in the lower half, they are reading the head side, and what
 * lies above the seam does not move by itself.
 */
function readingFromTail(seamTop: number): boolean {
  return seamTop < window.innerHeight / 2;
}

/**
 * The unit a child of the timeline's list stands for: its own, or for a
 * placeholder still in front of a filled unit (T-690), that unit's. Null for
 * what is no unit: a notice, the head's loading skeletons, the fold block,
 * the list's end.
 */
function unitOf(child: Element): string | null {
  return (
    child.getAttribute("data-placeholder-for") ??
    child.getAttribute("data-unit")
  );
}

/**
 * Where the unit under `key` is on the page: the placeholder still standing
 * in for it, or the unit itself. A hidden run revealed since is its first
 * comment, which opens downward from where the run was (T-281).
 */
export function locateUnit(list: HTMLElement, key: string): HTMLElement | null {
  const run = /^hidden-(\d+)$/.exec(key);
  return (
    childFor(list, key) ??
    (run === null ? null : childFor(list, `comment-${run[1]}`))
  );
}

/**
 * The list's child standing for the unit under `key`, its placeholder coming
 * before the unit it stands in front of. Only the list's own children: what a
 * unit renders inside it is no unit.
 */
function childFor(list: HTMLElement, key: string): HTMLElement | null {
  for (const child of list.children)
    if (child instanceof HTMLElement && unitOf(child) === key) return child;
  return null;
}

/**
 * The unit the reader is reading in the timeline's `list`, and the units
 * beside it on screen; `seam` is the key of the tail's first unit, whose top
 * is the seam between the head and the tail, given only where there is a head
 * side at all.
 *
 * - With the seam in the screen's upper half, the reader came up from the
 *   tail, which stays where it is as the seam changes (T-30), and as its
 *   oldest item slides into the fold with an arrival, whatever else changes
 *   above it: the first unit below the seam showing under the top overlays.
 *   Ahead of the rule below, so a short head side with the card's body still
 *   in view keeps the tail too.
 * - While the list's top shows below the top overlays, the reader can see
 *   the card's title, body or attachments above it, and nothing should push
 *   those away for what grows there: editing the body grows the page above
 *   the list. At the end of the conversation, the unit the rule below takes,
 *   moving with the list's top (`withList`): what grows above the list moves
 *   it along, and only what grows in the list is put back. Anywhere else
 *   none, and the browser keeps what precedes the list where it is.
 * - At the end of the conversation, the last unit showing above the bottom
 *   overlays: the reader is at the end, the comment box under their hand, and
 *   whatever loads above them, the first load's skeletons filled in included,
 *   leaves them there. The rules above take this one too.
 * - Otherwise the first unit showing under the top overlays. With the seam in
 *   the lower half, the head side's last unit ends above it, so whatever goes
 *   into the seam pushes nobody.
 *
 * Given `at`, an element a click landed on, the unit holding it instead: what
 * the click opens grows downward from where the reader pressed. With the body
 * in view, unless the tail's rule holds, that unit moves with the list's top
 * at the end, and is none anywhere else, as above. Undefined when the click
 * landed on no unit, such as the fold block's Load more, for the rules above
 * to decide. Outside the list, none for a click on what precedes it, showing
 * under the top overlays, with the body in view and the tail's rule not
 * holding: the reader pressed the card's title, body or attachments, and
 * what that opens grows downward from there, at the end too. An ancestor of
 * the list precedes nothing, so a press on blank space in its column keeps
 * the end. Undefined for any other click outside the list.
 *
 * A placeholder counts as the unit it stands for, so a reader looking at a
 * skeleton keeps the place of what fills it.
 */
export function pickReadingUnit(
  list: HTMLElement,
  seam: string | undefined,
  at?: Element,
): ReadingPlace | null | undefined {
  const usable = usableViewport();
  const units = unitsIn(list);
  const bodyInView = topShows(list);
  const seamAt =
    seam === undefined ? -1 : units.findIndex((u) => u.key === seam);
  const seamUnit = units[seamAt];
  const fromTail =
    seamUnit !== undefined &&
    readingFromTail(seamUnit.el.getBoundingClientRect().top);
  if (at !== undefined) {
    let child: Element | null = at;
    while (child !== null && child.parentElement !== list)
      child = child.parentElement;
    if (child === null) {
      // What precedes the list in the document, its ancestors aside.
      const where = list.compareDocumentPosition(at);
      return bodyInView &&
        !fromTail &&
        (where & Node.DOCUMENT_POSITION_PRECEDING) !== 0 &&
        (where & Node.DOCUMENT_POSITION_CONTAINS) === 0 &&
        at.getBoundingClientRect().bottom > usable.top
        ? null
        : undefined;
    }
    const key = unitOf(child);
    const clicked = key === null ? -1 : units.findIndex((u) => u.key === key);
    if (clicked === -1) return undefined;
    return bodyInView && !fromTail
      ? atEndWithList(() => placeAt(units, clicked, 1, usable))
      : placeAt(units, clicked, 1, usable);
  }
  if (fromTail)
    return atConversationEnd()
      ? placeAtBottom(units, usable)
      : placeAt(units, firstShowing(units, seamAt, usable), 1, usable);
  if (bodyInView) return atEndWithList(() => placeAtBottom(units, usable));
  if (atConversationEnd()) return placeAtBottom(units, usable);
  return placeAt(units, firstShowing(units, 0, usable), 1, usable);
}

/**
 * With the body above the list in view, `place()` moving with the list's top
 * at the end of the conversation, and nothing anywhere else.
 */
function atEndWithList(place: () => ReadingPlace | null): ReadingPlace | null {
  if (!atConversationEnd()) return null;
  const at = place();
  return at === null ? null : { ...at, withList: true };
}

/** A child of the list standing for a unit, and the unit's key. */
type UnitChild = { el: Element; key: string };

/**
 * The list's children standing for units, each unit once: a unit still
 * behind its placeholder takes no height and comes right after the
 * placeholder, which stands for it.
 */
function unitsIn(list: HTMLElement): UnitChild[] {
  const units: UnitChild[] = [];
  for (const el of list.children) {
    const key = unitOf(el);
    if (key !== null && key !== units.at(-1)?.key) units.push({ el, key });
  }
  return units;
}

/**
 * The first unit from `low` on ending below the top overlays, found by
 * halves: the units stand one under the other, so their bottoms only grow.
 */
function firstShowing(
  units: UnitChild[],
  low: number,
  usable: UsableViewport,
): number {
  let high = units.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const bottom = units[mid]?.el.getBoundingClientRect().bottom ?? 0;
    if (bottom > usable.top) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** The last unit whose top shows above the bottom overlays. */
function placeAtBottom(
  units: UnitChild[],
  usable: UsableViewport,
): ReadingPlace | null {
  let at = units.length - 1;
  while (
    at > 0 &&
    (units[at]?.el.getBoundingClientRect().top ?? 0) >=
      usable.top + usable.height
  )
    at -= 1;
  return placeAt(units, at, -1, usable);
}

/**
 * The unit at `at`, and beside it, nearest first in the direction of `step`,
 * every other unit still showing on screen, or at least the next one: an
 * arrival can slide the reader's unit and those after it out of the page in
 * one commit.
 */
function placeAt(
  units: UnitChild[],
  at: number,
  step: 1 | -1,
  usable: UsableViewport,
): ReadingPlace | null {
  const unit = units[at];
  if (unit === undefined) return null;
  const beside: ReadingUnit[] = [];
  for (let i = at + step; i >= 0 && i < units.length; i += step) {
    const next = units[i];
    if (next === undefined) break;
    const box = next.el.getBoundingClientRect();
    const shows =
      step > 0 ? box.top < usable.top + usable.height : box.bottom > usable.top;
    if (beside.length > 0 && !shows) break;
    beside.push({ key: next.key, top: box.top });
  }
  return {
    key: unit.key,
    top: unit.el.getBoundingClientRect().top,
    after: beside,
  };
}
