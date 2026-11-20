import { describe, expect, it } from "vitest";
import {
  documentToStrip,
  layoutTicks,
  type Mark,
  stripToDocument,
} from "../src/lib/spec-strip.ts";

// The change strip's geometry (T-234): a 2000px card drawn on a 500px bar,
// a quarter of its size.
const CARD = 2000;
const BAR = 500;

const mark = (
  kind: Mark<string>["kind"],
  top: number,
  height: number,
  target = `${kind}@${top}`,
): Mark<string> => ({ kind, top, height, target });

describe("the change strip's ticks (T-234)", () => {
  it("draws each mark at its share of the card", () => {
    expect(layoutTicks([mark("stop", 800, 40)], CARD, BAR)).toEqual([
      { kind: "stop", top: 200, height: 10, target: "stop@800" },
    ]);
  });

  it("keeps a short mark 3px tall, and a heading a hairline", () => {
    const ticks = layoutTicks(
      [mark("stop", 400, 4), mark("heading", 1200, 40)],
      CARD,
      BAR,
    );
    expect(ticks.map(({ kind, height }) => [kind, height])).toEqual([
      ["stop", 3],
      ["heading", 1],
    ]);
  });

  it("joins two of a kind closer than a pixel, pointing where the first did", () => {
    // 100 → 25..28 on the bar, 114 → 28.5..31.5: half a pixel apart.
    const ticks = layoutTicks(
      [mark("stop", 114, 4, "second"), mark("stop", 100, 4, "first")],
      CARD,
      BAR,
    );
    expect(ticks).toEqual([
      { kind: "stop", top: 25, height: 6.5, target: "first" },
    ]);
  });

  it("keeps two of a kind a pixel or more apart", () => {
    // 100 → 25..28 on the bar, 116 → 29..32: a pixel apart.
    const ticks = layoutTicks(
      [mark("stop", 100, 4), mark("stop", 116, 4)],
      CARD,
      BAR,
    );
    expect(ticks.map((tick) => tick.target)).toEqual(["stop@100", "stop@116"]);
  });

  it("never joins two of different kinds", () => {
    const ticks = layoutTicks(
      [mark("stop", 100, 4), mark("del", 100, 4), mark("comment", 102, 4)],
      CARD,
      BAR,
    );
    expect(ticks.map((tick) => tick.kind).sort()).toEqual([
      "comment",
      "del",
      "stop",
    ]);
  });

  it("maps the bar back onto the card and the card onto the bar alike", () => {
    for (const y of [0, 37, 250, 499.5, BAR]) {
      const down = stripToDocument(y, CARD, BAR);
      expect(documentToStrip(down, CARD, BAR)).toBeCloseTo(y, 9);
    }
    expect(stripToDocument(125, CARD, BAR)).toBe(500);
    expect(documentToStrip(500, CARD, BAR)).toBe(125);
  });
});
