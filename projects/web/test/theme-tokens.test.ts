import { describe, expect, it } from "vitest";
import { oklch } from "./theme-tokens.ts";

describe("theme tokens as the browser paints them", () => {
  it("clips a colour outside sRGB channel by channel, the way Chromium does", () => {
    // Each expected value was read back from a Chromium canvas filled with
    // that colour. Giving up chroma instead, as project icons do, would
    // read Solarized Light's popover as [255, 250, 235] and todou Light's
    // destructive red as [228, 0, 22]: colours no browser paints there.
    expect(oklch("oklch(0.985 0.028 92)")).toEqual([255, 250, 229]);
    expect(oklch("oklch(0.577 0.245 27.325)")).toEqual([231, 0, 11]);
  });
});
