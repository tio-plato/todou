import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * Theme colours the way the browser paints them, shared by the suites that
 * measure contrast against the real tokens: question rows in hover-contrast,
 * label chips in label-chip-contrast.
 */

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

export const STYLES = read("../src/styles.css");
// Resolved, not transcribed: a pasted amber would keep reporting the contrast
// of whatever Tailwind's palette held on the day somebody copied it, and the
// whole point of these numbers is that they track the real dependency.
const TAILWIND = readFileSync(
  createRequire(import.meta.url).resolve("tailwindcss/theme.css"),
  "utf8",
);

export type Rgb = [number, number, number];

/** CSS Color 4's Oklab matrices, then the sRGB transfer function. */
export function oklch(spec: string): Rgb {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(
    spec.trim(),
  );
  if (!m) throw new Error(`not a plain oklch() colour: ${spec}`);
  const lightness = m[2] === "%" ? Number(m[1]) / 100 : Number(m[1]);
  const chroma = Number(m[3]);
  const hue = (Number(m[4]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (v: number) => {
    const e = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, Math.round(e * 255)));
  };
  return [
    encode(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
    encode(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
    encode(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short),
  ];
}

export const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb => [
  Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
  Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
  Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
];

/** WCAG 2.x relative luminance and the (L1+0.05)/(L2+0.05) ratio. */
export function contrast(x: Rgb, y: Rgb): number {
  const luminance = (c: Rgb) => {
    const [r, g, b] = c.map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = luminance(x);
  const b = luminance(y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function tokensOf(selector: string): Record<string, string> | null {
  const head = `${selector} {`;
  const start = STYLES.indexOf(head);
  if (start < 0) return null;
  const body = STYLES.slice(start + head.length, STYLES.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    out[m[1]] = m[2].trim();
  return out;
}

export const themeBlock = (value: string) =>
  tokensOf(`:root[data-theme="${value}"]`);

export function tokensFor(value: string, kind: string): Record<string, string> {
  return {
    ...tokensOf(":root"),
    ...(kind === "dark" ? tokensOf(".dark") : {}),
    ...(themeBlock(value) ?? {}),
  };
}

export const AMBER = oklch(
  (/--color-amber-500:\s*([^;]+);/.exec(TAILWIND) as RegExpExecArray)[1].trim(),
);

export const worstFirst = (rows: { theme: string; ratio: number }[]) =>
  rows
    .sort((a, b) => a.ratio - b.ratio)
    .map((r) => `${r.theme} ${r.ratio.toFixed(2)}:1`);
