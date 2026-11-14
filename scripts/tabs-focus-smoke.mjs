#!/usr/bin/env node
/**
 * Real-browser check that a tab shows keyboard focus and only keyboard
 * focus: the metadata dialog, opened from the keyboard, hands focus to its
 * Browse tab, and that tab has to look different while it holds keyboard
 * focus from how it looks once focus has moved on, and from how it looks
 * focused by a mouse press. Computed styles, because happy-dom computes none
 * of Tailwind's CSS.
 * Usage: node scripts/tabs-focus-smoke.mjs [--keep] [--help]
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
const HELP = `tabs-focus-smoke — a tab with keyboard focus shows it

Usage: node scripts/tabs-focus-smoke.mjs [--keep] [--help]

Opens a card's metadata dialog with Enter on its Edit metadata button, reads
the Browse tab's look (box-shadow, background, colour, a drawn outline) while
it holds keyboard focus, presses Tab, and reads the same tab again; then
presses the mouse on it and reads it a third time. The keyboard look must
differ from both. Keys first: a mouse press before them would make the focus
Radix hands to the tab not count as :focus-visible.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
Exit codes: 0 pass, 1 assertion, 2 infrastructure error.
`;

const VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1 };

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
  const slug = "tabs-focus";
  await call("POST", "/projects", { slug, name: "Tabs", description: "" });
  // No metadata: an empty card still offers Edit metadata to a writer, and
  // its Browse panel holds an Add button for Tab to land on.
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Metadata tabs",
    body: "",
  });
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  return {
    cookie,
    issueUrl: `${stack.webUrl}/projects/${slug}/issues/${issue.number}`,
  };
}

/**
 * The Browse tab's look once it and the dialog have stopped animating, with
 * where focus is. An outline counts only when one is drawn: with
 * `outline-style: none` the width still changes with focus (1px focused, 3px
 * not) without anything on screen.
 */
async function look() {
  const tab = [...document.querySelectorAll('[role="tab"]')].find(
    (t) => t.textContent === "Browse",
  );
  const dialog = document.querySelector('[role="dialog"]');
  if (!tab || !dialog) return null;
  await Promise.all(
    [...tab.getAnimations(), ...dialog.getAnimations()].map((a) =>
      a.finished.catch(() => {}),
    ),
  );
  const s = getComputedStyle(tab);
  return {
    focused: document.activeElement === tab,
    focusVisible: tab.matches(":focus-visible"),
    style: {
      boxShadow: s.boxShadow,
      backgroundColor: s.backgroundColor,
      color: s.color,
      outline:
        s.outlineStyle === "none"
          ? "none"
          : `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
    },
  };
}

async function press(page, key, code, keyCode, text) {
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    ...(text ? { text } : {}),
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
  });
}

async function waitFor(page, fn, what) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await evaluate(page, fn).catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function mousePress(page, box) {
  for (const type of ["mousePressed", "mouseReleased"])
    await page.send("Input.dispatchMouseEvent", {
      type,
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
}

/** Keys of `a.style` whose value differs in `b.style`. */
const changed = (a, b) =>
  Object.keys(a.style).filter((k) => a.style[k] !== b.style[k]);

/**
 * Opens the dialog from the keyboard and reads the Browse tab three times:
 * with keyboard focus, after Tab moved focus on, and focused by the mouse.
 */
async function tabRing(context, fixture) {
  const equals = fixture.cookie.indexOf("=");
  const page = await context.newPage({
    viewport: VIEWPORT,
    cookie: {
      name: fixture.cookie.slice(0, equals),
      value: fixture.cookie.slice(equals + 1),
      url: fixture.issueUrl,
    },
  });
  try {
    await page.navigate(fixture.issueUrl);
    await waitFor(
      page,
      () => !!document.querySelector('button[aria-label="Edit metadata"]'),
      "the Edit metadata button",
    );
    await evaluate(page, () =>
      document.querySelector('button[aria-label="Edit metadata"]').focus(),
    );
    await press(page, "Enter", "Enter", 13, "\r");
    await waitFor(
      page,
      () => !!document.querySelector('[role="dialog"] [role="tablist"]'),
      "the metadata dialog's tabs",
    );
    const focused = await evaluate(page, look);
    if (!focused?.focused || !focused.focusVisible)
      throw new Error(
        `the Browse tab did not get keyboard focus: ${JSON.stringify(focused)}`,
      );
    await press(page, "Tab", "Tab", 9);
    const left = await evaluate(page, look);
    if (!left || left.focused)
      throw new Error(
        `Tab did not move focus off the Browse tab: ${JSON.stringify(left)}`,
      );
    const box = await evaluate(page, () => {
      const r = [...document.querySelectorAll('[role="tab"]')]
        .find((t) => t.textContent === "Browse")
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await mousePress(page, box);
    const clicked = await evaluate(page, look);
    if (!clicked?.focused || clicked.focusVisible)
      throw new Error(
        `a mouse press did not give the Browse tab mouse focus: ${JSON.stringify(clicked)}`,
      );
    const vsLeft = changed(focused, left);
    const vsClicked = changed(focused, clicked);
    return [
      {
        name: "tab-ring",
        ok: vsLeft.length > 0,
        detail: { changed: vsLeft, focused: focused.style, left: left.style },
      },
      {
        name: "tab-ring-keyboard-only",
        ok: vsClicked.length > 0,
        detail: {
          changed: vsClicked,
          focused: focused.style,
          clicked: clicked.style,
        },
      },
    ];
  } finally {
    await page.close();
  }
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
  const cases = [];
  let failure = null;

  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "tabs-focus-smoke-",
      keep,
    });
    const fixture = await seed(stack);
    const browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
    stack.addCleanup(() => browser.close());
    const context = await browser.newContext();
    try {
      cases.push(...(await tabRing(context, fixture)));
    } finally {
      await context.close();
    }
    for (const c of cases) {
      console.log(
        `  ${c.ok ? "ok  " : "RED "} ${c.name} ${JSON.stringify(c.detail)}`,
      );
      if (!c.ok) exitCode = 1;
    }
  } catch (error) {
    exitCode = 2;
    failure = error.stack ?? String(error);
    console.error(`tabs-focus-smoke: ${failure}`);
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
        failure = error.stack ?? String(error);
      }
    }
  }
  const report = {
    name: "tabs-focus-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    cases,
    ...(failure ? { error: failure } : {}),
  };
  console.log(`REPORT ${JSON.stringify({ status: report.status, exitCode })}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "tabs-focus-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
