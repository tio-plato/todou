#!/usr/bin/env node
/**
 * Real-browser check that an outline button takes the ring colour as its
 * border when it gets keyboard focus, in every theme, dark ones included:
 * there the variant's own `dark:border-input` used to outrank the base
 * `focus-visible:border-ring`, because the `dark` variant added a class of
 * specificity and comes later in the stylesheet.
 * It also opens the spec page's Files popover with the mouse and leaves the
 * pointer on its outline trigger, which has to take the theme's --muted in
 * every theme: in dark ones `dark:hover:bg-input/50` used to win over
 * `aria-expanded:bg-muted`, at the same specificity and later in the
 * stylesheet. Chromium starts with a hover-capable mouse as its primary
 * pointer: headless, it matches no (hover: hover), which every `hover:` rule
 * sits inside.
 * Usage: node scripts/outline-focus-smoke.mjs [--keep] [--help]
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
const HELP = `outline-focus-smoke — keyboard focus colours an outline button's border

Usage: node scripts/outline-focus-smoke.mjs [--keep] [--help]

Opens a card page, then for every theme the app ships focuses the sidebar's
Notifying button (an outline button) the keyboard way and compares its border
colour with the theme's --ring. A case also checks that the theme it names is
the one applied, with .dark set exactly for the dark ones, and that the button
matches :focus-visible, so a run that never switched themes or never focused
the keyboard way cannot pass.

Then it opens the card's spec page 900 wide, opens the Files popover with a
mouse click and leaves the pointer on its trigger (an outline button). For
every theme the trigger's background must equal the theme's --muted while the
theme is applied and the trigger matches :hover. Chromium is started with
Blink settings that make its primary pointer a hover-capable mouse; without
them no hover: rule applies, so the run stops as an infrastructure error if
(hover: hover) does not match.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
Exit codes: 0 pass, 1 assertion, 2 infrastructure error.
`;

const VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1 };
// Below lg the spec toolbar moves the file list into the Files popover.
const SPEC_VIEWPORT = { width: 900, height: 900, deviceScaleFactor: 1 };
// Headless Chromium matches no (hover: hover), so no `hover:` rule would
// apply; these make its primary pointer a mouse that can hover.
const HOVER_MOUSE =
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4";

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
  const slug = "outline-focus";
  await call("POST", "/projects", { slug, name: "Outline", description: "" });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Keyboard focus on an outline button",
    body: "",
  });
  await call("POST", `/projects/${slug}/issues/${issue.number}/spec/push`, {
    message: "Outline popover fixture",
    files: [{ path: "plan.md", body: "# Plan\n\nA popover trigger to hover." }],
  });
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  const issueUrl = `${stack.webUrl}/projects/${slug}/issues/${issue.number}`;
  return { cookie, issueUrl, specUrl: `${issueUrl}/spec` };
}

/**
 * Installed in the page as `window.__notifying`: the mute menu's trigger.
 * Found by its text: `DropdownMenuTrigger asChild` replaces the button's
 * `data-slot`, so only `data-variant` is left of it.
 */
function notifying() {
  return [...document.querySelectorAll('button[data-variant="outline"]')].find(
    (b) => b.textContent.trim() === "Notifying",
  );
}

/** Installed in the page as `window.__files`: the Files popover's trigger. */
function filesTrigger() {
  return document.querySelector('[data-toolbar-slot="files"]');
}

async function pressShift(page) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: "Shift",
      code: "ShiftLeft",
      windowsVirtualKeyCode: 16,
    });
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

  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "outline-focus-smoke-",
      keep,
    });
    const fixture = await seed(stack);
    const browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
      args: [HOVER_MOUSE],
    });
    stack.addCleanup(() => browser.close());
    const context = await browser.newContext();
    const equals = fixture.cookie.indexOf("=");
    const page = await context.newPage({
      viewport: VIEWPORT,
      cookie: {
        name: fixture.cookie.slice(0, equals),
        value: fixture.cookie.slice(equals + 1),
        url: fixture.issueUrl,
      },
      scripts: [`window.__notifying = ${notifying.toString()};`],
    });
    await page.navigate(fixture.issueUrl);
    const deadline = Date.now() + 30_000;
    const shown = () =>
      evaluate(page, () => window.__notifying() !== undefined).catch(
        () => false,
      );
    while (!(await shown())) {
      if (Date.now() > deadline)
        throw new Error("the Notifying button never showed");
      await sleep(200);
    }
    // Read from the app, so a theme added later is covered without an edit.
    const themes = await evaluate(page, async () => {
      const { THEMES } = await import("/src/lib/theme.ts");
      return THEMES.map((t) => ({ value: t.value, kind: t.kind }));
    });
    if (themes.length === 0) throw new Error("the app lists no themes");

    for (const { value: theme, kind } of themes) {
      await evaluate(
        page,
        async (theme) => {
          const { setThemePref } = await import("/src/lib/theme.ts");
          setThemePref(theme);
          window.__notifying().blur();
        },
        theme,
      );
      // A key press first, so the programmatic focus below counts as keyboard
      // focus and matches :focus-visible, as Tab would.
      await pressShift(page);
      const reading = await evaluate(page, async () => {
        const button = window.__notifying();
        button.focus();
        // `transition-all`: read mid-way and the colour is neither end's. A
        // transition cancelled and replaced while waiting settles as well, so
        // wait until none is left.
        for (let left = button.getAnimations(); left.length; ) {
          await Promise.allSettled(left.map((a) => a.finished));
          left = button.getAnimations();
        }
        const probe = document.createElement("div");
        probe.style.border = "1px solid var(--ring)";
        document.body.append(probe);
        const ring = getComputedStyle(probe).borderTopColor;
        probe.remove();
        return {
          dataTheme: document.documentElement.dataset.theme,
          dark: document.documentElement.classList.contains("dark"),
          focusVisible: button.matches(":focus-visible"),
          border: getComputedStyle(button).borderTopColor,
          ring,
        };
      });
      cases.push({
        name: `focus-border:${theme}`,
        // The theme, its kind (the `.dark` class every `dark:` class hangs on)
        // and keyboard focus all have to hold, or the border says nothing.
        ok:
          reading.dataTheme === theme &&
          reading.dark === (kind === "dark") &&
          reading.focusVisible &&
          reading.border === reading.ring,
        detail: reading,
      });
    }

    const specPage = await context.newPage({
      viewport: SPEC_VIEWPORT,
      cookie: {
        name: fixture.cookie.slice(0, equals),
        value: fixture.cookie.slice(equals + 1),
        url: fixture.specUrl,
      },
      scripts: [`window.__files = ${filesTrigger.toString()};`],
    });
    await specPage.navigate(fixture.specUrl);
    const filesDeadline = Date.now() + 30_000;
    const filesShown = () =>
      evaluate(specPage, () => window.__files() !== null).catch(() => false);
    while (!(await filesShown())) {
      if (Date.now() > filesDeadline)
        throw new Error("the Files button never showed");
      await sleep(200);
    }
    // Without it every `hover:` rule is off, and an open dark trigger is
    // --muted anyway: the cases below would pass on the unfixed code.
    if (!(await evaluate(specPage, () => matchMedia("(hover: hover)").matches)))
      throw new Error("(hover: hover) does not match; no hover: rule applies");
    // Opened once and left open, the pointer resting on the trigger: the
    // popover is not modal, so switching themes neither closes it nor moves
    // the pointer.
    const centre = await evaluate(specPage, () => {
      const box = window.__files().getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await specPage.send("Input.dispatchMouseEvent", {
        type,
        ...centre,
        button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
    }
    const openDeadline = Date.now() + 5_000;
    while (
      (await evaluate(specPage, () =>
        window.__files().getAttribute("aria-expanded"),
      )) !== "true"
    ) {
      if (Date.now() > openDeadline)
        throw new Error("the Files popover never opened");
      await sleep(100);
    }

    for (const { value: theme, kind } of themes) {
      const reading = await evaluate(
        specPage,
        async (theme) => {
          const { setThemePref } = await import("/src/lib/theme.ts");
          setThemePref(theme);
          const button = window.__files();
          for (let left = button.getAnimations(); left.length; ) {
            await Promise.allSettled(left.map((a) => a.finished));
            left = button.getAnimations();
          }
          const probe = document.createElement("div");
          probe.style.background = "var(--muted)";
          document.body.append(probe);
          const muted = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return {
            dataTheme: document.documentElement.dataset.theme,
            dark: document.documentElement.classList.contains("dark"),
            expanded: button.getAttribute("aria-expanded"),
            hover: button.matches(":hover"),
            background: getComputedStyle(button).backgroundColor,
            muted,
          };
        },
        theme,
      );
      cases.push({
        name: `open-hover-bg:${theme}`,
        // A pointer that left the trigger reads --muted in a dark theme too,
        // so :hover is checked each time; a popover that closed reads the
        // resting or hover colour, never --muted, in a dark theme.
        ok:
          reading.dataTheme === theme &&
          reading.dark === (kind === "dark") &&
          reading.hover &&
          reading.background === reading.muted,
        detail: reading,
      });
    }
    for (const c of cases)
      console.log(
        `  ${c.ok ? "ok  " : "RED "} ${c.name} ${JSON.stringify(c.detail)}`,
      );
    if (cases.some((c) => !c.ok)) exitCode = 1;
  } catch (error) {
    exitCode = 2;
    cases.push({
      name: "runner-error",
      ok: false,
      error: error.stack ?? String(error),
    });
    console.error(`outline-focus-smoke: ${error.stack ?? error}`);
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
        cases.push({
          name: "cleanup-error",
          ok: false,
          error: error.stack ?? String(error),
        });
      }
    }
  }
  const report = {
    name: "outline-focus-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    cases,
  };
  console.log(`REPORT ${JSON.stringify({ status: report.status, exitCode })}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "outline-focus-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
