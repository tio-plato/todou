import { Component, type RefObject } from "react";

/**
 * Whether the seam between the head and the tail, `seamTop` down the
 * viewport, says the reader came up from the tail (T-30). In the upper half,
 * the tail side is what they are reading, and it stays where it is as the
 * seam changes; in the lower half, they are reading the head side, and what
 * lies above the seam does not move by itself.
 */
export function readingFromTail(seamTop: number): boolean {
  return seamTop < window.innerHeight / 2;
}

type Props = {
  /** The timeline's list, its units each under `data-unit`. */
  list: RefObject<HTMLElement | null>;
  /** The keys of the tail side's units, in order. */
  tailUnits: string[];
  /** The keys of the tail side's items, in order. */
  tailItems: string[];
  /** The keys of every item on either side. */
  present: ReadonlySet<string>;
};

/** A unit on the page before and after a commit, and where it was before. */
type Anchor = { key: string; top: number };

function unitIn(list: HTMLElement | null, key: string): HTMLElement | null {
  return list?.querySelector<HTMLElement>(`[data-unit="${key}"]`) ?? null;
}

/**
 * Keeps the tail side where it was as its oldest item slides into the fold.
 *
 * Something arriving refetches the newest page, and the item it pushes out of
 * the tail leaves the page above a reader scrolled up into it: the list's own
 * scroll anchoring is off, so what they are reading moves up by its height.
 * Put back by how far a unit still on the page moved in that commit, which
 * takes in whatever else changed above it, the fold block appearing with the
 * first slide included. Not by the height that left: a browser that has
 * already moved the page itself would have it moved twice.
 *
 * A class, which renders nothing: `getSnapshotBeforeUpdate` is the one place
 * React reads the page before a commit changes it. A function component has
 * no counterpart, and a layout effect's cleanup runs once its children's DOM
 * has already changed.
 */
export class TailSlideAnchor extends Component<Props> {
  getSnapshotBeforeUpdate(prev: Props): Anchor | null {
    // An item gone from both sides, not a unit gone from the tail: Load more
    // moves the items ahead of the tail to the head side, where they stay on
    // the page under its own compensation, and a group's key changes with its
    // first event, whatever moved that.
    const oldest = prev.tailItems[0];
    if (oldest === undefined || this.props.present.has(oldest)) return null;
    const list = this.props.list.current;
    const seam = prev.tailUnits[0];
    const seamEl = seam === undefined ? null : unitIn(list, seam);
    if (seamEl === null || !readingFromTail(seamEl.getBoundingClientRect().top))
      return null;
    // The first unit of the new tail already on the page, so on it after the
    // commit too.
    for (const key of this.props.tailUnits) {
      const el = unitIn(list, key);
      if (el !== null) return { key, top: el.getBoundingClientRect().top };
    }
    return null;
  }

  componentDidUpdate(_prev: Props, _state: unknown, anchor?: Anchor | null) {
    if (!anchor) return;
    const el = unitIn(this.props.list.current, anchor.key);
    if (el === null) return;
    const delta = el.getBoundingClientRect().top - anchor.top;
    if (delta !== 0) window.scrollBy(0, delta);
  }

  render() {
    return null;
  }
}
