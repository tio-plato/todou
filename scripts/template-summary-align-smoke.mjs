#!/usr/bin/env node
/**
 * Real-browser geometry for a template's summary line: the words of
 * `N statuses ·`, `N labels ·` and `Blocks clear at` share one baseline
 * wherever they share a line, though the status pill after the last of them
 * makes its part taller, in the template list of the New project dialog and
 * on the account's Templates page, at desktop and phone widths.
 * Usage: node scripts/template-summary-align-smoke.mjs [--keep] [--help]
 * Requires the same installed dependencies, Node 24+, flock and CHROMIUM
 * (default /usr/bin/chromium) as the other browser smokes.
 * Exit: 0 every case as expected; 1 an assertion; 2 infrastructure failure.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELP = `template-summary-align-smoke — a template summary's words on one baseline

Usage: node scripts/template-summary-align-smoke.mjs [--keep] [--help]

Opens the New project dialog's template list and the account's Templates page
at desktop and phone widths, and reads the text boxes of every summary's own
words (the pill's name aside). Words drawn on the same line must start at the
same height within 0.5px; they are drawn in one font size, so equal tops mean
one baseline. Basic blocks clear at a status, whose pill shares the line; the
seeded template has no line and no pill. At phone width the Templates page
puts "Blocks clear at" on a line of its own, so there only the dialog has a
pill beside other words.

Then a fault run centres the summary's parts on their middles, which sets the
words beside a pill higher than the others, and must turn every case whose
line holds a pill beside other words red, so a pass is evidence the tolerance
can fail.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
Exit codes: 0 pass, 1 assertion, 2 infrastructure error.
`;

const TOLERANCE = 0.5;
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1 };
// The width of the phone the misalignment was reported from.
const PHONE = { width: 402, height: 874, deviceScaleFactor: 3, mobile: true };

async function seed(stack) {
  let cookie = "";
  const call = async (method, path, body) => {
    const response = await fetch(`${stack.serverUrl}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "/auth/login");
  // Basic is built in and blocks clear at Shipped; this one has no line, so
  // its summary ends in words instead of a pill.
  await call("POST", "/me/project-templates", {
    name: "No line",
    body: {
      statuses: [
        {
          name: "Open",
          category: "open",
          color: "#9ca3af",
          chart_role: "remaining",
          is_default: true,
        },
        {
          name: "Closed",
          category: "closed",
          color: "#22c55e",
          chart_role: "completed",
        },
      ],
      labels: [],
    },
  });
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  return { cookie, webUrl: stack.webUrl };
}

const PLACES = {
  // ?new=1 opens the dialog on load.
  dialog: { path: "/projects?new=1", within: '[role="dialog"]' },
  settings: { path: "/settings/templates", within: "main" },
};

/**
 * Every summary inside `within`, by name: the innermost element holding a
 * whole summary, whatever its parts are drawn in. Null until both templates
 * show one and nothing in `within` is still animating (the dialog opens
 * from 95%).
 */
function measure(within, centre) {
  const scope = document.querySelector(within);
  if (!scope) return null;
  if (
    scope
      .getAnimations({ subtree: true })
      .some((a) => a.playState === "running") ||
    document.fonts.status !== "loaded"
  )
    return null;
  const whole = (el) => /^\d+ status.*Blocks clear at/.test(el.textContent);
  const roots = [...scope.querySelectorAll("*")].filter(
    (el) => whole(el) && ![...el.children].some(whole),
  );
  const out = {};
  for (const root of roots) {
    if (centre) root.style.alignItems = "center";
    const name =
      root.closest('[role="option"]')?.getAttribute("aria-label") ??
      root.closest("li")?.querySelector("a")?.textContent;
    const pill = root.querySelector(".rounded-full");
    const boxes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data.trim() || pill?.contains(node)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects())
        if (r.width > 0)
          boxes.push({ text: node.data.trim(), top: r.top, bottom: r.bottom });
    }
    // Boxes whose heights overlap are drawn on one line.
    const lines = [];
    for (const box of boxes) {
      const line = lines.find((l) => box.top < l.bottom && box.bottom > l.top);
      if (line) {
        line.boxes.push(box);
        line.bottom = Math.max(line.bottom, box.bottom);
      } else lines.push({ top: box.top, bottom: box.bottom, boxes: [box] });
    }
    const p = pill?.getBoundingClientRect();
    out[name] = lines.map((l) => ({
      tops: l.boxes.map((b) => [b.text, b.top]),
      pill: p !== undefined && p.top < l.bottom && p.bottom > l.top,
    }));
  }
  return out.Basic && out["No line"] ? out : null;
}

async function read(browser, fixture, viewport, place, centre) {
  const context = await browser.newContext();
  try {
    const url = fixture.webUrl + PLACES[place].path;
    const equals = fixture.cookie.indexOf("=");
    const page = await context.newPage({
      viewport,
      cookie: {
        name: fixture.cookie.slice(0, equals),
        value: fixture.cookie.slice(equals + 1),
        url,
      },
    });
    await page.navigate(url);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await sleep(200);
      const lines = await evaluate(
        page,
        measure,
        PLACES[place].within,
        centre,
      ).catch(() => null);
      if (lines) return lines;
    }
    throw new Error(`${place} never showed both summaries`);
  } finally {
    await context.close();
  }
}

function cases(label, summaries) {
  return Object.entries(summaries).flatMap(([name, lines]) =>
    lines.map((line, index) => {
      const tops = line.tops.map(([, top]) => top);
      const spread = Math.max(...tops) - Math.min(...tops);
      return {
        name: `${label}:${name}:line${index + 1}`,
        pill: line.pill,
        ok: spread <= TOLERANCE,
        detail: { spread, tops: line.tops },
      };
    }),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--keep", "--help"].includes(arg))) {
    console.error("Unknown argument. Try --help.");
    return 2;
  }
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const keep = args.includes("--keep");
  let stack;
  let exitCode = 0;
  const runs = [];
  const record = (name, results, requiredRed = []) => {
    const red = results.filter((c) => !c.ok).map((c) => c.name);
    const pass =
      requiredRed.length === 0
        ? red.length === 0
        : requiredRed.every((n) => red.includes(n));
    runs.push({
      name,
      status: pass ? "pass" : "fail",
      requiredRed,
      red,
      cases: results,
    });
    console.log(`RUN ${JSON.stringify({ name, pass, requiredRed, red })}`);
    for (const c of results)
      console.log(
        `  ${c.ok ? "ok  " : "RED "} ${c.name} ${JSON.stringify(c.detail)}`,
      );
    if (!pass) exitCode = Math.max(exitCode, 1);
  };

  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "template-summary-align-smoke-",
      keep,
    });
    const fixture = await seed(stack);
    const browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
    stack.addCleanup(() => browser.close());
    const sweep = async (centre) => {
      const results = [];
      for (const [label, viewport] of [
        ["desktop", DESKTOP],
        ["phone", PHONE],
      ]) {
        for (const place of Object.keys(PLACES)) {
          const summaries = await read(
            browser,
            fixture,
            viewport,
            place,
            centre,
          );
          results.push(...cases(`${label}:${place}`, summaries));
        }
      }
      return results;
    };
    const layout = await sweep(false);
    // A line where the pill sits beside other words is what the run exists
    // for; a place without one proves nothing. At phone width the Templates
    // page breaks before "Blocks clear at", so there it can come from the
    // desktop width alone.
    const shared = layout.filter((c) => c.pill && c.detail.tops.length > 1);
    for (const place of Object.keys(PLACES))
      if (!shared.some((c) => c.name.split(":")[1] === place))
        throw new Error(
          `no line in ${place} holds the pill beside other words`,
        );
    record("layout", layout);
    record(
      "fault-centred",
      await sweep(true),
      shared.map((c) => c.name),
    );
  } catch (error) {
    exitCode = 2;
    runs.push({
      name: "runner-error",
      status: "fail",
      error: error.stack ?? String(error),
    });
    console.error(`template-summary-align-smoke: ${error.stack ?? error}`);
  } finally {
    if (stack) {
      if (exitCode !== 0 && !keep) {
        stack.keep = {
          remove: ["attachments", "chrome", "db"],
          message: `kept failure artifacts: ${stack.dir}`,
        };
      }
      try {
        await stack.cleanup();
      } catch (error) {
        exitCode = 2;
        runs.push({
          name: "cleanup-error",
          status: "fail",
          error: error.stack ?? String(error),
        });
      }
    }
  }
  const report = {
    name: "template-summary-align-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    runs,
  };
  console.log(`REPORT ${JSON.stringify({ status: report.status, exitCode })}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "template-summary-align-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
