import { render } from "@testing-library/react";
import type { Label } from "@todou/shared";
import { afterEach, describe, expect, it } from "vitest";
import { LabelChips } from "../src/components/issue/label-chip.tsx";
import { PRESET_COLORS } from "../src/lib/labels.ts";
import { setThemePref, THEMES } from "../src/lib/theme.ts";
import {
  AMBER,
  contrast,
  oklch,
  over,
  type Rgb,
  tokensFor,
  worstFirst,
} from "./theme-tokens.ts";

afterEach(() => {
  setThemePref("system");
  localStorage.clear();
});

/** WCAG 2.2 success criterion 1.4.3 (AA) for normal-size text. */
const MIN_TEXT_CONTRAST = 4.5;

/**
 * The surfaces a chip is actually drawn on, built the way the browser
 * composites them: each translucent layer over the one beneath, in 8-bit
 * sRGB. Every theme's `--card` equals its `--popover`, and no chip sits on
 * a card, so the card is not listed on its own.
 */
function surfaces(tokens: Record<string, string>): Record<string, Rgb> {
  const background = oklch(tokens["--background"]);
  const popover = oklch(tokens["--popover"]);
  const muted = oklch(tokens["--muted"]);
  const primary = oklch(tokens["--primary"]);
  return {
    // Issue rows, board cards, the issue sidebar and timeline, label settings.
    background,
    // The label picker, filter menus, search, completions, hover cards.
    popover,
    // The highlighted row of those menus.
    accent: oklch(tokens["--accent"]),
    // A hovered issue row (`hover:bg-muted/50`).
    "row hover": over(muted, background, 0.5),
    // A checked issue row (`bg-primary/10`).
    "row checked": over(primary, background, 0.1),
    // The open or new row in label settings (`bg-muted/45`).
    "label editor": over(muted, background, 0.45),
    // A hovered row in label settings (`hover:bg-muted/60`).
    "label settings hover": over(muted, background, 0.6),
    // The picker's "Similar label exists" notice (`bg-amber-500/10`).
    "similar label notice": over(AMBER, popover, 0.1),
    // A selected board card (`bg-primary/10`) in its column (`bg-muted/30`).
    "board card selected": over(primary, over(muted, background, 0.3), 0.1),
  };
}

const CUBE_STEPS = ["00", "33", "66", "99", "cc", "ff"];
const COLORS = [
  ...PRESET_COLORS,
  // Upper case on purpose: the server accepts either case.
  "#A2EEEF",
  ...CUBE_STEPS.flatMap((r) =>
    CUBE_STEPS.flatMap((g) => CUBE_STEPS.map((b) => `#${r}${g}${b}`)),
  ),
];

/**
 * An inline colour as the chip wrote it. Only the two spellings a chip
 * writes are understood: any other one throws rather than being guessed
 * at, because a colour this cannot read is a colour it cannot measure.
 */
function parsePaint(value: string): { rgb: Rgb; alpha: number } {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (!m) throw new Error(`not a #rrggbb or #rrggbbaa colour: "${value}"`);
  const rgb = [0, 2, 4].map((at) =>
    Number.parseInt(m[1].slice(at, at + 2), 16),
  ) as Rgb;
  return {
    rgb,
    alpha: m[2] === undefined ? 1 : Number.parseInt(m[2], 16) / 255,
  };
}

describe("tinted label chips", () => {
  it("keeps the text at 4.5:1 on every surface a chip sits on, in every theme", () => {
    expect(COLORS).toHaveLength(229);
    // No `style`: a label without one is drawn tinted, which this also holds.
    const labels: Label[] = COLORS.map((color, i) => ({
      id: i + 1,
      name: color,
      color,
    }));
    const failures = [];
    for (const theme of THEMES) {
      setThemePref(theme.value);
      const view = render(<LabelChips labels={labels} />);
      const under = surfaces(tokensFor(theme.value, theme.kind));
      for (const label of labels) {
        const chip = view.getByTitle(label.name);
        const text = parsePaint(chip.style.color);
        const fill = parsePaint(chip.style.backgroundColor);
        for (const [surface, rgb] of Object.entries(under)) {
          const ratio = contrast(text.rgb, over(fill.rgb, rgb, fill.alpha));
          if (ratio < MIN_TEXT_CONTRAST) {
            failures.push({
              theme: `${theme.value} / ${surface} / ${label.color}`,
              ratio,
            });
          }
        }
      }
      view.unmount();
    }
    expect(worstFirst(failures).slice(0, 10)).toEqual([]);
  });
});
