import type { Label } from "@todou/shared";
import {
  hexToOklch,
  parseHex,
  relativeLuminance,
  toHex,
  toSrgb,
} from "@/lib/project-tint.ts";
import type { ThemeKind } from "@/lib/theme.ts";

// Canonicalization is the server's rule now (T-136) — re-exported rather
// than reimplemented so the picker's preview cannot drift from what a
// create actually stores.
export { canonicalizeLabelName } from "@todou/shared";

/**
 * Split a structured label name at the first colon. A leading colon is not a
 * prefix (":oops" stays whole) — hence > 0, not >= 0.
 */
export function splitLabelName(name: string): {
  prefix: string | null;
  value: string;
} {
  const i = name.indexOf(":");
  if (i > 0) return { prefix: name.slice(0, i + 1), value: name.slice(i + 1) };
  return { prefix: null, value: name };
}

/** Preset swatches offered in the color popover (statuses and labels). */
export const PRESET_COLORS = [
  "#6b7280",
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#0ea5e9",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

/*
 * How far a tinted chip's text may sit from the theme's own end of the
 * lightness scale: at most this light on a light theme, at least this light
 * on a dark one. Measured outside the repository with apca-w3 0.1.9: these
 * are the values at which every theme, on every surface a chip is drawn on,
 * gives the presets and a 216-colour cube at least APCA Lc 60, the floor for
 * non-body text. Gruvbox Light's checked issue row and Nord's highlighted
 * menu row are what hold them there. The same values give no less than
 * 4.77:1 by WCAG 2, and the test holds WCAG's 4.5:1, as APCA's licence keeps
 * its code out of this repository.
 */
const LIGHT_THEME_INK_MAX = 0.32;
const DARK_THEME_INK_MIN = 0.88;

/**
 * The text colour of a tinted chip: the label's own hue and chroma, its
 * OKLCH lightness moved to the side the theme reads, with chroma given up
 * where that lightness has no sRGB colour of the full chroma. A colour
 * already on that side is used as it is, and one that is not `#rrggbb` too.
 */
export function labelInk(color: string, kind: ThemeKind): string {
  const lch = hexToOklch(color);
  if (lch === null) return color;
  const l =
    kind === "light"
      ? Math.min(lch.l, LIGHT_THEME_INK_MAX)
      : Math.max(lch.l, DARK_THEME_INK_MIN);
  if (l === lch.l) return color;
  return toHex(toSrgb(l, lch.c, lch.h));
}

/*
 * A solid chip writes in white on a fill darker than this relative
 * luminance, in black otherwise. For a given fill APCA rates one of black
 * and white higher the lighter the fill and the other lower, so taking the
 * one it reads better is a single luminance boundary. Found outside the
 * repository with apca-w3 0.1.9: across every third value of each channel,
 * 0.36 disagrees with APCA on 0.39% of colours, all of them fills where
 * black and white read within Lc 1.4 of each other, and agrees on every
 * preset. Only the boundary is kept here, not APCA's code.
 */
const SOLID_WHITE_TEXT_BELOW = 0.36;

/**
 * The text colour of a solid chip: white or black, the same in every theme.
 * A colour that is not `#rrggbb` is returned as it is.
 */
export function solidLabelText(color: string): string {
  const rgb = parseHex(color);
  if (rgb === null) return color;
  return relativeLuminance(rgb) < SOLID_WHITE_TEXT_BELOW
    ? "#ffffff"
    : "#000000";
}

/**
 * Near-duplicate comparison key. Stripping *all* whitespace (not just
 * collapsing it) is what makes "area: web" collide with "area:web".
 */
export function labelNearKey(input: string): string {
  return input.toLowerCase().replace(/\s+/g, "");
}

/**
 * Deterministic default color for an on-the-fly label: the same name always
 * hashes to the same preset, so a retried create doesn't flicker colors.
 */
export function labelColorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return PRESET_COLORS[h % PRESET_COLORS.length] as string;
}

export type LabelGroups<T extends Label> = {
  groups: Array<{ prefix: string; labels: T[] }>;
  plain: T[];
};

/**
 * Group labels by their name prefix for the "`area:` text + value badges"
 * rendering. Input order is preserved (the API sorts by name), so groups
 * come out in alphabetical first-appearance order.
 */
export function groupLabelsByPrefix<T extends Label>(
  labels: T[],
): LabelGroups<T> {
  const groups = new Map<string, T[]>();
  const plain: T[] = [];
  for (const label of labels) {
    const { prefix } = splitLabelName(label.name);
    if (prefix === null) {
      plain.push(label);
      continue;
    }
    const bucket = groups.get(prefix);
    if (bucket) bucket.push(label);
    else groups.set(prefix, [label]);
  }
  return {
    groups: [...groups].map(([prefix, ls]) => ({ prefix, labels: ls })),
    plain,
  };
}
