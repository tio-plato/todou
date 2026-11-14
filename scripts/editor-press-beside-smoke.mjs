#!/usr/bin/env node
/**
 * Real-browser regression for a press on the blank page beside an editor,
 * which Chromium turned into a caret inside it and so focused it.
 * Usage: node scripts/editor-press-beside-smoke.mjs [--keep] [--help]
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
const HELP = `editor-press-beside-smoke — a press beside an editor leaves it alone

Usage: node scripts/editor-press-beside-smoke.mjs [--keep] [--help]

Seeds a card long enough to scroll and, with real mouse and touch input,
presses the blank page level with an editor: left of the content column and
under the side column, beside the comment box at the page end, and left of the
new-card description. Whatever the box holds (nothing, a draft, a selected
draft, focus), no press may focus it, and a press beside a focused empty box
must fold it as a press anywhere else outside does. On a 390px touch phone a
tap in the outer half of the margin beside the folded box must not focus it
either; nearer the box, Chromium's touch adjustment moves the tap onto the
box, as it would onto a <textarea>.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
Exit codes: 0 pass, 1 assertion, 2 infrastructure error.
`;

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1 };
const COMMENT = "Write a comment";
const DESCRIPTION = "Description";
const DRAFT = "draft text here";

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
  const slug = "editor-press-beside-smoke";
  await call("POST", "/projects", { slug, name: "Beside", description: "" });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Blank page beside the comment box",
    body: "Body text of the card.\n\nSecond paragraph.",
  });
  for (let i = 1; i <= 5; i++) {
    await call("POST", `/projects/${slug}/issues/${issue.number}/comments`, {
      body: `Comment ${i}\n\n${"A line long enough to wrap somewhere. ".repeat(6)}`,
    });
  }
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  const issueUrl = `${stack.webUrl}/projects/${slug}/issues/${issue.number}`;
  return {
    cookie,
    issueUrl,
    newIssueUrl: `${stack.webUrl}/projects/${slug}/issues/new`,
  };
}

/** The editor labelled `label`, read back from the rendered DOM. */
function readEditor(label) {
  const content = document.querySelector(`[aria-label="${label}"]`);
  const editor = content.closest(".cm-editor");
  return {
    focused: editor.contains(document.activeElement),
    folded: editor.closest("[data-collapsed]") !== null,
    selection: String(getSelection()),
  };
}

/**
 * Two blank points level with the editor labelled `label`: halfway between
 * the window edge and the content, and halfway between the editor's box and
 * the far edge of `<main>` (under the card page's side column). On a phone
 * `<main>` is the content, so the margins beside the box are used instead,
 * a quarter of the way in from the window edge: a tap nearer the box is moved
 * onto it by touch adjustment and is a tap on the box. `line` aims at the first line of text rather than the
 * editor's middle, where a tall empty description has nothing level with it.
 */
function besidePoints(label, line, phone) {
  const content = document.querySelector(`[aria-label="${label}"]`);
  const editor = content.closest(".cm-editor");
  const box = content
    .closest('[data-slot="markdown-editor"]')
    .getBoundingClientRect();
  const main = document.querySelector("main").getBoundingClientRect();
  const row = (
    line ? content.querySelector(".cm-line") : editor
  ).getBoundingClientRect();
  const y = Math.round(row.top + row.height / 2);
  const points = phone
    ? [
        ["left", box.left / 4],
        ["right", window.innerWidth - (window.innerWidth - box.right) / 4],
      ]
    : [
        ["left", main.left / 2],
        ["right", (box.right + main.right) / 2],
      ];
  return points.map(([side, x]) => {
    const under = document.elementFromPoint(Math.round(x), y);
    return {
      side,
      x: Math.round(x),
      y,
      blank:
        under !== null &&
        !content.closest('[data-slot="markdown-editor"]').contains(under),
    };
  });
}

function blurAll() {
  document.activeElement?.blur();
  getSelection()?.removeAllRanges();
}

function focusEditor(label) {
  document.querySelector(`[aria-label="${label}"]`).focus();
}

function input(page) {
  const mouse = (type, x, y) =>
    page.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  const touch = (type, points) =>
    page.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });
  return {
    click: async ({ x, y }) => {
      await mouse("mouseMoved", x, y);
      await mouse("mousePressed", x, y);
      await mouse("mouseReleased", x, y);
    },
    tap: async ({ x, y }) => {
      await touch("touchStart", [[x, y]]);
      await touch("touchEnd", []);
    },
    type: async (label, text) => {
      await evaluate(page, focusEditor, label);
      await sleep(100);
      await page.send("Input.insertText", { text });
      await sleep(200);
    },
    selectAll: async () => {
      await page.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 2,
        commands: ["selectAll"],
      });
      await page.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      await sleep(200);
    },
  };
}

async function openPage(context, fixture, url, viewport, ready) {
  const equals = fixture.cookie.indexOf("=");
  const page = await context.newPage({
    viewport,
    cookie: {
      name: fixture.cookie.slice(0, equals),
      value: fixture.cookie.slice(equals + 1),
      url,
    },
  });
  if (viewport.mobile)
    await page.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
  await page.navigate(url);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await evaluate(page, ready)) {
      await sleep(1000);
      return page;
    }
    await sleep(200);
  }
  await page.close();
  throw new Error(`${url} never finished rendering`);
}

const cardReady = () =>
  document.querySelector('[aria-label="Write a comment"]') !== null &&
  document.body.innerText.includes("Comment 5");
const newIssueReady = () =>
  document.querySelector('[aria-label="Description"]') !== null;

async function measure(page, label, { line = false, phone = false } = {}) {
  await evaluate(page, () => window.scrollTo(0, 1e7));
  await sleep(300);
  const points = await evaluate(page, besidePoints, label, line, phone);
  const covered = points.filter((p) => !p.blank);
  if (covered.length > 0)
    throw new Error(
      `no blank page at ${JSON.stringify(covered)} beside ${label}`,
    );
  return points;
}

/**
 * Press beside the comment box `presses` times at each point, preparing the
 * box before each point, and read it back after every press.
 */
async function besideComment(page, { draft, prepare, presses, settle, sides }) {
  const io = input(page);
  if (draft) await io.type(COMMENT, draft);
  const detail = [];
  for (const side of sides) {
    await prepare(page, io);
    await sleep(500);
    const point = (await measure(page, COMMENT)).find((p) => p.side === side);
    const before = await evaluate(page, readEditor, COMMENT);
    const after = [];
    for (let i = 0; i < presses; i++) {
      await io.click(point);
      await sleep(settle);
      after.push(await evaluate(page, readEditor, COMMENT));
    }
    detail.push({ ...point, before, after });
  }
  return detail;
}

const SIDES = ["left", "right"];
const COMMENT_CASES = [
  {
    name: "beside-empty",
    draft: "",
    prepare: (page) => evaluate(page, blurAll),
    presses: 2,
    settle: 250,
    given: (s) => !s.focused && s.folded,
    expect: (s) => !s.focused,
  },
  {
    name: "beside-draft",
    draft: DRAFT,
    prepare: (page) => evaluate(page, blurAll),
    presses: 2,
    settle: 250,
    given: (s) => !s.focused,
    expect: (s) => !s.focused,
  },
  {
    // A selection over the draft takes a press to clear before the next can
    // place a caret, which is why the box used to focus every other press.
    name: "beside-selected-draft",
    draft: DRAFT,
    prepare: async (page, io) => {
      await evaluate(page, focusEditor, COMMENT);
      await sleep(100);
      await io.selectAll();
      await evaluate(page, () => document.activeElement?.blur());
    },
    presses: 2,
    settle: 250,
    given: (s) => !s.focused && s.selection === DRAFT,
    expect: (s) => !s.focused,
  },
  {
    // The press still takes focus away, so the empty box folds.
    name: "beside-focused-empty",
    draft: "",
    prepare: (page) => evaluate(page, focusEditor, COMMENT),
    presses: 1,
    settle: 500,
    given: (s) => s.focused && !s.folded,
    expect: (s) => !s.focused && s.folded,
  },
];

async function newIssueCase(page) {
  const io = input(page);
  await io.type(DESCRIPTION, DRAFT);
  await evaluate(page, blurAll);
  await sleep(500);
  const point = (await measure(page, DESCRIPTION, { line: true })).find(
    (p) => p.side === "left",
  );
  const after = [];
  for (let i = 0; i < 2; i++) {
    await io.click(point);
    await sleep(250);
    after.push(await evaluate(page, readEditor, DESCRIPTION));
  }
  return { ok: after.every((s) => !s.focused), detail: [{ ...point, after }] };
}

async function phoneCase(page) {
  const io = input(page);
  const detail = [];
  for (const side of SIDES) {
    await evaluate(page, blurAll);
    await sleep(500);
    const point = (await measure(page, COMMENT, { phone: true })).find(
      (p) => p.side === side,
    );
    const before = await evaluate(page, readEditor, COMMENT);
    await io.tap(point);
    await sleep(400);
    detail.push({
      ...point,
      before,
      after: [await evaluate(page, readEditor, COMMENT)],
    });
  }
  return {
    ok: detail.every((d) => d.after.every((s) => !s.focused)),
    detail,
  };
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
  const record = (name, ok, detail) => {
    cases.push({ name, ok, detail });
    console.log(`${ok ? "ok  " : "RED "} ${name} ${JSON.stringify(detail)}`);
    if (!ok) exitCode = Math.max(exitCode, 1);
  };
  const run = async (context, fixture, url, viewport, ready, body) => {
    const page = await openPage(context, fixture, url, viewport, ready);
    try {
      return await body(page);
    } finally {
      await page.close();
    }
  };

  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "editor-press-beside-smoke-",
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
      // `given` is the state the preparation must leave before the first
      // press; without it a case could pass on a box it never set up.
      for (const { name, given, expect, ...spec } of COMMENT_CASES) {
        const detail = await run(
          context,
          fixture,
          fixture.issueUrl,
          DESKTOP,
          cardReady,
          (page) => besideComment(page, { ...spec, sides: SIDES }),
        );
        record(
          name,
          detail.every((d) => given(d.before) && d.after.every(expect)),
          detail,
        );
      }
      const newIssue = await run(
        context,
        fixture,
        fixture.newIssueUrl,
        DESKTOP,
        newIssueReady,
        newIssueCase,
      );
      record("new-issue-beside", newIssue.ok, newIssue.detail);
      const phone = await run(
        context,
        fixture,
        fixture.issueUrl,
        PHONE,
        cardReady,
        phoneCase,
      );
      record("phone-tap-beside", phone.ok, phone.detail);
    } finally {
      await context.close();
    }
  } catch (error) {
    exitCode = 2;
    cases.push({
      name: "runner-error",
      ok: false,
      error: error.stack ?? String(error),
    });
    console.error(`editor-press-beside-smoke: ${error.stack ?? error}`);
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
    name: "editor-press-beside-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    cases,
  };
  console.log(`REPORT ${JSON.stringify({ status: report.status, exitCode })}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "editor-press-beside-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
