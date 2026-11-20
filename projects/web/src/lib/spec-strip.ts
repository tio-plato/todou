/**
 * The geometry of the change strip along a rendered spec's right edge:
 * the whole card mapped onto one fixed-height bar, so a tick keeps
 * its place on the bar however far the page scrolls.
 */

export type TickKind = "stop" | "del" | "comment" | "draft" | "heading";

/** Something to mark, in the card's own coordinates. */
export type Mark<T> = {
  kind: TickKind;
  top: number;
  height: number;
  target: T;
};

/** A mark drawn on the bar, in the bar's coordinates. */
export type Tick<T> = Mark<T>;

/** The least height a tick is drawn at, so a one-line change still shows. */
export const MIN_TICK = 3;

/** Ticks of a kind closer than this on the bar are drawn as one. */
const MERGE_GAP = 1;

/** A point down the card, as far down the bar. */
export function documentToStrip(
  y: number,
  cardHeight: number,
  stripHeight: number,
): number {
  return cardHeight > 0 ? (y / cardHeight) * stripHeight : 0;
}

/** A point down the bar, as far down the card. */
export function stripToDocument(
  y: number,
  cardHeight: number,
  stripHeight: number,
): number {
  return stripHeight > 0 ? (y / stripHeight) * cardHeight : 0;
}

/**
 * Every mark scaled from the card onto the bar. A heading is a hairline; the
 * rest are at least `MIN_TICK` tall, and two of a kind that would touch or
 * overlap on the bar become one, which goes where the first of them went.
 */
export function layoutTicks<T>(
  marks: Mark<T>[],
  cardHeight: number,
  stripHeight: number,
): Tick<T>[] {
  const ticks: Tick<T>[] = [];
  const last = new Map<TickKind, Tick<T>>();
  const scaled = marks
    .map((mark) => ({
      ...mark,
      top: documentToStrip(mark.top, cardHeight, stripHeight),
      height:
        mark.kind === "heading"
          ? 1
          : Math.max(
              MIN_TICK,
              documentToStrip(mark.height, cardHeight, stripHeight),
            ),
    }))
    .sort((a, b) => a.top - b.top);
  for (const tick of scaled) {
    const before = last.get(tick.kind);
    if (
      before !== undefined &&
      tick.top - (before.top + before.height) < MERGE_GAP
    ) {
      before.height = Math.max(
        before.height,
        tick.top + tick.height - before.top,
      );
      continue;
    }
    ticks.push(tick);
    last.set(tick.kind, tick);
  }
  return ticks;
}
