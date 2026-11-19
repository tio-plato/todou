import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES } from "../src/lib/theme.ts";
import {
  AMBER,
  contrast,
  oklch,
  over,
  type Rgb,
  themeBlock,
  tokensFor,
  tokensOf,
  worstFirst,
} from "./theme-tokens.ts";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

const CARD = read("../src/components/timeline/questions-card.tsx");

const hex = (c: Rgb) =>
  `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

type Paint = { token: string; alpha: number } | null;

/**
 * The last `bg-`/`border-` utility that applies in the given state wins, which
 * is why these are walked in order rather than searched for. Only the palette
 * spellings this card uses are understood: an unrecognised one throws instead
 * of scoring as transparent, because a colour that silently measures as
 * "nothing painted" is indistinguishable from the bug being guarded here.
 */
function paint(classes: string[], property: string, hovered: boolean): Paint {
  const TOKENS: Record<string, string> = {
    foreground: "--foreground",
    primary: "--primary",
    destructive: "--destructive",
    muted: "--muted",
    card: "--card",
    accent: "--accent",
    secondary: "--secondary",
  };
  let found: Paint = null;
  for (const raw of classes) {
    const parts = raw.split(":");
    const utility = parts.pop() as string;
    if (parts.includes("hover") !== hovered) continue;
    if (!utility.startsWith(`${property}-`)) continue;
    const [name, alpha] = utility.slice(property.length + 1).split("/");
    if (name === "transparent") {
      found = null;
      continue;
    }
    const token = TOKENS[name];
    if (token === undefined) throw new Error(`unmapped colour utility: ${raw}`);
    found = { token, alpha: alpha === undefined ? 1 : Number(alpha) / 100 };
  }
  return found;
}

const ROW_TEMPLATE =
  /className=\{`([^`]*?)\$\{[\s\S]*?\?\s*"([^"]*)"\s*:\s*"([^"]*)"/g;
const ROWS = [...CARD.matchAll(ROW_TEMPLATE)]
  .filter((m) => m[1].includes("rounded-md border"))
  .map((m) => ({ base: m[1], marked: m[2], plain: m[3] }));

const classesOf = (base: string, branch: string) =>
  `${base} ${branch}`.trim().split(/\s+/);

function surfaces(tokens: Record<string, string>, classes: string[]) {
  const card = over(AMBER, oklch(tokens["--card"]), 0.05);
  const fill = (p: Paint) =>
    p === null ? card : over(oklch(tokens[p.token]), card, p.alpha);
  const hoverFill = paint(classes, "bg", true);
  return {
    card,
    rest: fill(paint(classes, "bg", false)),
    // A hover background replaces the resting one rather than stacking on it;
    // where the row declares none, hovering leaves the resting fill standing.
    hover:
      hoverFill === null ? fill(paint(classes, "bg", false)) : fill(hoverFill),
    // Composited over the card rather than over the row's own hover fill: the
    // real border paints on top of that fill, which pushes it further from the
    // neighbouring resting row, so measuring against the card under-reports.
    edge: (() => {
      const p = paint(classes, "border", true);
      return p === null ? null : fill(p);
    })(),
  };
}

const measured = THEMES.map((theme) => ({
  theme,
  tokens: tokensFor(theme.value, theme.kind),
}));

// The minima design.md measured, less a hair of rounding headroom. Raising a
// threshold above its measured value is how this test is meant to be proven
// capable of failing.
const MIN_EDGE = 1.9;
const MIN_STATE_FILL = 1.05;

describe("question row hover contrast", () => {
  it("reproduces the card face the customer screenshotted", () => {
    // Three independent sources agree on this pixel (design.md): the model
    // below, Chrome's own engine in the mockup, and the reported screenshot.
    // Every other number here rides on the same two formulas, so when one of
    // them is mistyped this is the assertion that says so.
    const light = measured.find(
      (m) => m.theme.value === "light",
    ) as (typeof measured)[number];
    const card = over(AMBER, oklch(light.tokens["--card"]), 0.05);
    expect(hex(card)).toBe("#fffaf2");
  });

  it("measures both rows the card actually renders", () => {
    // Nothing else in this file fails if the templates stop being found — the
    // per-theme loops would simply iterate over an empty set and pass.
    expect(ROWS).toHaveLength(2);
  });

  it("draws an unselected row's hover edge clear of the row beside it", () => {
    const failures = [];
    for (const { theme, tokens } of measured) {
      for (const row of ROWS) {
        const { card, edge } = surfaces(tokens, classesOf(row.base, row.plain));
        if (edge === null) {
          failures.push({
            theme: `${theme.value} (no hover border)`,
            ratio: 0,
          });
          continue;
        }
        failures.push({ theme: theme.value, ratio: contrast(edge, card) });
      }
    }
    expect(worstFirst(failures.filter((f) => f.ratio < MIN_EDGE))).toEqual([]);
  });

  it("deepens a selected or declined row's own fill on hover", () => {
    const rows = [];
    for (const { theme, tokens } of measured) {
      for (const row of ROWS) {
        const { rest, hover } = surfaces(
          tokens,
          classesOf(row.base, row.marked),
        );
        rows.push({ theme: theme.value, ratio: contrast(hover, rest) });
      }
    }
    expect(worstFirst(rows.filter((r) => r.ratio < MIN_STATE_FILL))).toEqual(
      [],
    );
  });

  it("has a token block for every theme, so a new one cannot go unmeasured", () => {
    const unmeasured = THEMES.filter(
      (t) =>
        themeBlock(t.value) === null &&
        t.value !== "light" &&
        t.value !== "dark",
    );
    expect(unmeasured.map((t) => t.value)).toEqual([]);
    // The two themes with no data-theme block of their own are the defaults,
    // and they are only measurable because these blocks carry the full palette.
    expect(tokensOf(":root")).toHaveProperty("--card");
    expect(tokensOf(".dark")).toHaveProperty("--card");
  });
});
