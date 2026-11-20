import { act, render } from "@testing-library/react";
import type { Label } from "@todou/shared";
import { afterEach, describe, expect, it } from "vitest";
import { LabelChips } from "../src/components/issue/label-chip.tsx";
import { PRESET_COLORS } from "../src/lib/labels.ts";
import { relativeLuminance } from "../src/lib/project-tint.ts";
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

/** The OS colour scheme happy-dom answers `prefers-color-scheme` from. */
const device = (
  window as unknown as {
    happyDOM: { settings: { device: { prefersColorScheme: string } } };
  }
).happyDOM.settings.device;

/** Switch the OS scheme; happy-dom re-evaluates media queries on resize. */
function setOsScheme(scheme: "light" | "dark") {
  device.prefersColorScheme = scheme;
  window.dispatchEvent(new Event("resize"));
}

afterEach(() => {
  setOsScheme("light");
  setThemePref("system");
  localStorage.clear();
});

/**
 * WCAG 2.2's floor for large text (success criterion 1.4.3) and for
 * non-text contrast (1.4.11). A chip's 12px text would need 4.5:1 under
 * 1.4.3; it is held to 3:1 by choice. Each theme's ink limit is set by APCA
 * instead, at Lc 50 for the presets on every surface, measured outside the
 * repository, and 3:1 is the WCAG floor every colour keeps under those
 * limits. APCA's licence keeps its code out of this repository, so this is
 * the part a test can hold.
 */
const MIN_TEXT_CONTRAST = 3;

/**
 * The surfaces a chip is actually drawn on, each translucent layer blended
 * over the one beneath at its exact alpha and rounded to 8-bit sRGB.
 * Browsers keep alpha in 8 bits and blend premultiplied, which can paint a
 * stack of layers one or two steps darker. With today's themes that takes
 * no colour here below 3:1 (measured outside the repository), and the APCA
 * floor, which it does move, is measured on the surfaces browsers paint
 * (see `labelInkLimit`). Every theme's
 * `--card` equals its `--popover`, and no chip sits on a card, so the card
 * is not listed on its own.
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
  it("keeps the text at 3:1 on every surface a chip sits on, in every theme", () => {
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

  it("follows the OS between light and dark under the system theme, while mounted", () => {
    setThemePref("system");
    setOsScheme("light");
    const label: Label = { id: 1, name: "black", color: "#000000" };
    const view = render(<LabelChips labels={[label]} />);
    const onBackground = (kind: "light" | "dark") => {
      const chip = view.getByTitle("black");
      const text = parsePaint(chip.style.color);
      const fill = parsePaint(chip.style.backgroundColor);
      const background = oklch(tokensFor(kind, kind)["--background"]);
      return contrast(text.rgb, over(fill.rgb, background, fill.alpha));
    };
    expect(onBackground("light")).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    act(() => setOsScheme("dark"));
    expect(onBackground("dark")).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    act(() => setOsScheme("light"));
    expect(onBackground("light")).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it("gives each theme its own ink and follows a switch between two themes of one kind", () => {
    const labels: Label[] = PRESET_COLORS.map((color, i) => ({
      id: i + 1,
      name: color,
      color,
    }));
    // Each pair goes from a theme with a clean surface to the strictest one of
    // its kind, so every preset's ink is darker after the switch on light
    // themes and lighter on dark ones.
    const switches = [
      { from: "light", to: "gruvbox-light", darker: true },
      { from: "dark", to: "nord", darker: false },
    ] as const;
    for (const { from, to, darker } of switches) {
      setThemePref(from);
      // Mounted across the switch: a chip that re-renders only when the
      // light/dark kind changes would keep the first theme's ink.
      const view = render(<LabelChips labels={labels} />);
      const inks = () => labels.map((l) => view.getByTitle(l.name).style.color);
      const before = inks();
      act(() => setThemePref(to));
      const after = inks();
      labels.forEach((label, i) => {
        const was = relativeLuminance(parsePaint(before[i]).rgb);
        const is = relativeLuminance(parsePaint(after[i]).rgb);
        const message = `${from} → ${to} ${label.color}: ${before[i]} → ${after[i]}`;
        if (darker) expect(is, message).toBeLessThan(was);
        else expect(is, message).toBeGreaterThan(was);
      });
      view.unmount();
    }
  });
});

describe("solid label chips", () => {
  // The ink APCA reads better on each fill, measured with apca-w3 outside
  // the repository: every preset, emerald and teal among them although
  // they sit just either side of the boundary, and the extremes.
  const WHITE_TEXT = [
    "#6b7280",
    "#ef4444",
    "#f97316",
    "#0ea5e9",
    "#3b82f6",
    "#8b5cf6",
    "#ec4899",
    "#000000",
  ];
  const BLACK_TEXT = [
    "#f59e0b",
    "#eab308",
    "#22c55e",
    "#10b981",
    "#14b8a6",
    "#a2eeef",
    "#ffffff",
  ];

  it("fills with the label colour and writes in white or black, whichever APCA reads better, in any theme", () => {
    const labels: Label[] = [...WHITE_TEXT, ...BLACK_TEXT].map((color, i) => ({
      id: i + 1,
      name: color,
      color,
      style: "solid",
    }));
    for (const theme of ["light", "dark"] as const) {
      setThemePref(theme);
      const view = render(<LabelChips labels={labels} />);
      for (const label of labels) {
        const chip = view.getByTitle(label.name);
        expect(chip.style.backgroundColor.toLowerCase()).toBe(label.color);
        expect(chip.style.borderColor.toLowerCase()).toBe(label.color);
        expect(chip.style.color.toLowerCase(), `${theme} ${label.color}`).toBe(
          WHITE_TEXT.includes(label.color) ? "#ffffff" : "#000000",
        );
      }
      view.unmount();
    }
  });

  it("draws a style it does not know as tinted", () => {
    const label = {
      id: 1,
      name: "future",
      color: "#ef4444",
      style: "outline",
    } as unknown as Label;
    const view = render(<LabelChips labels={[label]} />);
    const chip = view.getByTitle("future");
    expect(chip.style.backgroundColor.toLowerCase()).toBe("#ef444422");
    expect(chip.style.borderColor.toLowerCase()).toBe("#ef444455");
  });
});
