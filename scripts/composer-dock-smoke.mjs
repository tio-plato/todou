#!/usr/bin/env node
/**
 * Real-browser regression for the folded comment composer at the page end
 * (T-532, T-538), for opening a card on the comment box rather than on the
 * page end, the second time from the list too, with its timeline cached, for
 * the scroll-to-bottom button showing on a scroll down and only then, and for
 * the New messages pill staying above whatever floats at the bottom,
 * clickable, however tall the composer grows, and landing on the first comment
 * that arrived, and for following a new comment only from the end of the
 * conversation.
 * Usage: node scripts/composer-dock-smoke.mjs [--keep] [--help]
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
const HELP = `composer-dock-smoke — the folded composer at and away from the page end

Usage: node scripts/composer-dock-smoke.mjs [--keep] [--help]

Seeds a card long enough to scroll, opens it on a 390px touch phone and on a
1280px desktop, and scrolls with CDP touch input. On the phone the folded
composer must be the one-line box while the page is at its end and the
floating Comment button anywhere above; the swap must not move the page or
flip back and forth, must not break the bottom landing on open (T-527), and
anchors must still land clear of the dock (T-519). Opening the card must put
the comment box on the viewport's bottom edge, with the phone's sidebar below
the viewport rather than the box a sidebar's height above it, and so must
opening it from the list again, with its timeline already cached. On a second,
long card the scroll-to-bottom button must stay hidden through the landing,
scrolling up and an anchor jump, show centred above the floating layer on a
scroll down, hide on a scroll up, land on the box when clicked, take no room
in the column, drop its slide under reduced motion, and stay hidden in the
sidebar of a short phone, where a comment arriving shows New messages
pointing up at it instead. Arriving comments are posted by another account,
since the reader's own never raise New messages. With the reader scrolled
away and a comment arriving, the New messages pill must stay above the
folded dock or Comment button, the opened box, a tall draft and a simulated
keyboard, and take the click at its centre; with two arriving, it lands on
the first of them, or on the comment box when they are too short to bring
the first any higher.
A comment arriving is followed only from the end of the conversation: a
reader half a screen up, one the page grew away from with no scroll, one
sending their own comment from up there, and one moved off the end with no
input stay where they are, while one at the end typing a reply is followed;
a comment longer than the screen arriving then is shown from its top, a
short one at the end.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
Exit codes: 0 pass, 1 assertion, 2 infrastructure error.
`;

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1 };
/** Short enough that the sidebar alone fills it at the page end. */
const SHORT = { width: 390, height: 400, deviceScaleFactor: 2, mobile: true };

async function seed(stack) {
  let cookie = "";
  const call = async (method, path, body, token = null) => {
    const response = await fetch(`${stack.serverUrl}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === null
          ? cookie
            ? { cookie }
            : {}
          : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie && token === null) cookie = setCookie.split(";", 1)[0];
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "/auth/login");
  const slug = "composer-dock-smoke";
  await call("POST", "/projects", { slug, name: "Dock", description: "" });
  // Someone else, for the comments that arrive while a page is open: the
  // reader's own never raise New messages, and the stack has one user.
  const other = await call("POST", "/agents", {
    login: "bot-one",
    display_name: "Bot One",
  });
  const { token } = await call("POST", `/agents/${other.id}/tokens`, {
    name: "composer-dock-smoke",
  });
  await call("POST", `/projects/${slug}/members`, {
    login: "bot-one",
    role: "writer",
  });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Long thread",
    body: "",
  });
  const ids = [];
  for (let i = 1; i <= 12; i++) {
    const result = await call(
      "POST",
      `/projects/${slug}/issues/${issue.number}/comments`,
      { body: `Comment ${i}\n\n${"A line long enough to wrap. ".repeat(8)}` },
    );
    ids.push((result.comment ?? result).id);
  }
  // Its own card, so the geometry the cases above measure stays as it was:
  // a body two screens long, for a button that has to show over it, and
  // labels enough that a short phone's sidebar fills the screen on its own.
  const labelIds = [];
  for (let i = 1; i <= 24; i++) {
    // Without a shared prefix: the sidebar keeps a prefix's labels on one
    // line, and 24 of them would widen the phone page past its viewport.
    const label = await call("POST", `/projects/${slug}/labels`, {
      name: `subsystem-${i}`,
    });
    labelIds.push(label.id);
  }
  const long = await call("POST", `/projects/${slug}/issues`, {
    title: "Long body",
    label_ids: labelIds,
    body: Array.from(
      { length: 16 },
      (_, i) =>
        `Paragraph ${i + 1}. ${"Words to fill the body out. ".repeat(10)}`,
    ).join("\n\n"),
  });
  const longIds = [];
  for (let i = 1; i <= 12; i++) {
    const result = await call(
      "POST",
      `/projects/${slug}/issues/${long.number}/comments`,
      { body: `Reply ${i}\n\n${"A line long enough to wrap. ".repeat(6)}` },
    );
    longIds.push((result.comment ?? result).id);
  }
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  return {
    cookie,
    listUrl: `${stack.webUrl}/projects/${slug}`,
    issueUrl: `${stack.webUrl}/projects/${slug}/issues/${issue.number}`,
    ids,
    long: {
      issueUrl: `${stack.webUrl}/projects/${slug}/issues/${long.number}`,
      ids: longIds,
      comment: (body) =>
        call(
          "POST",
          `/projects/${slug}/issues/${long.number}/comments`,
          { body },
          token,
        ),
    },
    comment: (body) =>
      call(
        "POST",
        `/projects/${slug}/issues/${issue.number}/comments`,
        { body },
        token,
      ),
  };
}

/** The dock as the page shows it, read back from the rendered DOM. */
function readState() {
  const editor = document.querySelector('[aria-label="Write a comment"]');
  if (!editor) return null;
  const dock = editor.closest(".sticky");
  const opener = document.querySelector("[data-composer-opener]");
  const box = editor.getBoundingClientRect();
  const openerRect = opener?.getBoundingClientRect();
  const doc = document.documentElement;
  // Where the dock's own slot in the flow begins: below the timeline and the
  // gap between them. On a phone the sidebar follows it, so the document end is not it.
  // Past the absolute end mark, and past the scroll-to-bottom layer: it is
  // sticky, and its box is where it is stuck, not its place in the flow.
  let before = dock.previousElementSibling;
  while (
    before &&
    (getComputedStyle(before).position === "absolute" ||
      before.matches("[data-scroll-to-bottom]"))
  )
    before = before.previousElementSibling;
  const slotTop =
    before.getBoundingClientRect().bottom +
    Math.max(
      Number.parseFloat(getComputedStyle(before).marginBottom),
      Number.parseFloat(getComputedStyle(dock).marginTop),
    );
  return {
    slotTop,
    innerHeight: window.innerHeight,
    boxShown: box.width > 100 && box.height > 20,
    openerShown: openerRect !== undefined && openerRect.width > 0,
    dockTop: dock.getBoundingClientRect().top,
    dockHeight: dock.getBoundingClientRect().height,
    dockBottom: dock.getBoundingClientRect().bottom,
    asideTop: document.querySelector("aside")?.getBoundingClientRect().top,
    scrollY: window.scrollY,
    maxScroll: doc.scrollHeight - window.innerHeight,
    paddingBottom: getComputedStyle(doc).scrollPaddingBottom,
    focusedInside: dock.contains(document.activeElement),
    actionsShown: dock.querySelector(".composer-actions-in") !== null,
    headerBottom: document.querySelector("header").getBoundingClientRect()
      .bottom,
  };
}

/**
 * The New messages pill against the layer that floats at the bottom: the dock
 * while it floats, the phone's Comment button while the folded dock waits at
 * the page end. Found by its name, which carries the count when it has one.
 */
function readPill() {
  const pill = [...document.querySelectorAll("button")].find((button) =>
    /^(New messages|\d+ new messages?)$/.test(
      button.getAttribute("aria-label") ?? button.textContent.trim(),
    ),
  );
  const dock = document
    .querySelector('[aria-label="Write a comment"]')
    .closest(".sticky");
  const opener = document.querySelector("[data-composer-opener]");
  const floats = getComputedStyle(dock).position !== "static";
  const dockRect = dock.getBoundingClientRect();
  const rect = pill?.getBoundingClientRect();
  const hit =
    rect &&
    document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
  return {
    shown: rect !== undefined && rect.height > 0,
    top: rect?.top ?? null,
    bottom: rect?.bottom ?? null,
    centre: rect ? rect.left + rect.width / 2 : null,
    hits: pill?.contains(hit) === true,
    floats,
    floatingTop: floats
      ? dockRect.top
      : (opener?.getBoundingClientRect().top ?? window.innerHeight),
    // Mounted while the box is folded at any width, hidden above sm, and
    // faded rather than removed while the box itself is on screen (T-585).
    openerShown:
      opener !== null &&
      opener.getBoundingClientRect().width > 0 &&
      opener.parentElement.dataset.state === "shown",
    dockTop: dockRect.top,
    dockHeight: dockRect.height,
    focusedInside: dock.contains(document.activeElement),
    actionsShown: dock.querySelector(".composer-actions-in") !== null,
    headerBottom: document.querySelector("header").getBoundingClientRect()
      .bottom,
    // From the end of the conversation, the column the dock ends, which is
    // what following new comments is measured against.
    fromEnd:
      dock.parentElement.getBoundingClientRect().bottom - window.innerHeight,
    innerHeight: window.innerHeight,
  };
}

/** Counts every swap between box and button from the moment it is armed. */
function armSwapCounter() {
  window.__swaps = 0;
  window.__swapObserver?.disconnect();
  let had = document.querySelector("[data-composer-opener]") !== null;
  window.__swapObserver = new MutationObserver(() => {
    const has = document.querySelector("[data-composer-opener]") !== null;
    if (has !== had) window.__swaps++;
    had = has;
  });
  window.__swapObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/** A signed-in page, touch-enabled on a phone, still blank. */
async function newPage(context, fixture, viewport, scripts = []) {
  const equals = fixture.cookie.indexOf("=");
  const page = await context.newPage({
    viewport,
    cookie: {
      name: fixture.cookie.slice(0, equals),
      value: fixture.cookie.slice(equals + 1),
      url: fixture.issueUrl,
    },
    scripts,
  });
  if (viewport.mobile)
    await page.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
  return page;
}

/** Whether the card rendered its last comment and had time to land. */
async function landed(page, fixture) {
  const deadline = Date.now() + 30_000;
  const last = `comment-${fixture.ids.at(-1)}`;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      page,
      (id) => document.getElementById(id) !== null,
      last,
    );
    // Long enough for the landing and its hold to finish placing the page.
    if (ready) {
      await sleep(1500);
      return true;
    }
    await sleep(200);
  }
  return false;
}

async function openCard(context, fixture, viewport, hash = "", scripts = []) {
  const page = await newPage(context, fixture, viewport, scripts);
  await page.navigate(`${fixture.issueUrl}${hash}`);
  if (await landed(page, fixture)) return page;
  await page.close();
  throw new Error("card never rendered its last comment");
}

function input(page) {
  const touch = (type, points) =>
    page.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });
  const mouse = (type, x, y, extra = {}) =>
    page.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  return {
    state: async (ms = 400) => {
      await sleep(ms);
      return evaluate(page, readState);
    },
    click: async (x, y) => {
      await mouse("mouseMoved", x, y);
      for (const type of ["mousePressed", "mouseReleased"])
        await mouse(type, x, y, { button: "left", clickCount: 1 });
    },
    wheel: (x, y, deltaY) => mouse("mouseWheel", x, y, { deltaX: 0, deltaY }),
    /** Lines typed into the focused editor, Enter between them. */
    type: async (lines) => {
      for (const [i, line] of lines.entries()) {
        if (i > 0)
          for (const type of ["keyDown", "keyUp"])
            await page.send("Input.dispatchKeyEvent", {
              type,
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
              ...(type === "keyDown" ? { text: "\r" } : {}),
            });
        await page.send("Input.insertText", { text: line });
      }
    },
    /** A finger moving by `dy` (positive drags down, so the page scrolls up). */
    swipe: async (x, y, dy) => {
      await touch("touchStart", [[x, y]]);
      for (let i = 1; i <= 20; i++) {
        await touch("touchMove", [[x, y + (dy * i) / 20]]);
        await sleep(16);
      }
      await touch("touchEnd", []);
    },
    tap: async (x, y) => {
      await touch("touchStart", [[x, y]]);
      await touch("touchEnd", []);
    },
  };
}

const atEnd = (s) => s.scrollY >= s.maxScroll - 1;
/** The comment box on the viewport's bottom edge, where a card opens. */
const boxAtBottom = (s) => Math.abs(s.dockBottom - s.innerHeight) <= 1;

async function phoneCases(page) {
  const io = input(page);
  const out = [];
  const check = (name, ok, detail) =>
    out.push({ name, ok: Boolean(ok), detail });

  const s0 = await io.state();
  check(
    "opens-at-end-with-box",
    boxAtBottom(s0) && s0.maxScroll > 1000 && s0.boxShown && !s0.openerShown,
    s0,
  );

  // Far enough that the dock's slot has left the screen.
  await io.swipe(PHONE.width / 2, 120, 700);
  const s1 = await io.state();
  check(
    "scrolled-up-shows-button",
    s1.slotTop > s1.innerHeight &&
      s1.openerShown &&
      !s1.boxShown &&
      s1.paddingBottom === `${s1.dockHeight}px`,
    s1,
  );

  await io.swipe(PHONE.width / 2, 800, -700);
  await io.swipe(PHONE.width / 2, 800, -700);
  const s2 = await io.state(800);
  check(
    "back-at-end-shows-box",
    atEnd(s2) &&
      s2.boxShown &&
      !s2.openerShown &&
      s2.paddingBottom === `${s2.dockHeight}px`,
    s2,
  );

  // Walk the slot's top edge across the viewport bottom a few px at a time,
  // and once more at the document end. Each stop has to swap at most once and
  // stay where it was put: a mark that moved with the dock's height would
  // swap, move itself back across the edge, and swap back.
  const stops = [];
  const offsets = [];
  for (let k = -120; k <= 60; k += 6) offsets.push(k);
  for (const k of [...offsets, "end"]) {
    const target = await evaluate(
      page,
      (offset) => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        if (offset === "end") {
          window.scrollTo(0, max);
          return window.scrollY;
        }
        const dock = document
          .querySelector('[aria-label="Write a comment"]')
          .closest(".sticky");
        let before = dock.previousElementSibling;
        while (
          before &&
          (getComputedStyle(before).position === "absolute" ||
            before.matches("[data-scroll-to-bottom]"))
        )
          before = before.previousElementSibling;
        const slotTop =
          before.getBoundingClientRect().bottom +
          Math.max(
            Number.parseFloat(getComputedStyle(before).marginBottom),
            Number.parseFloat(getComputedStyle(dock).marginTop),
          );
        window.scrollTo(
          0,
          window.scrollY + slotTop - window.innerHeight - offset,
        );
        return window.scrollY;
      },
      k,
    );
    await evaluate(page, armSwapCounter);
    await sleep(400);
    const after = await evaluate(page, () => ({
      swaps: window.__swaps,
      scrollY: window.scrollY,
      box: document.querySelector("[data-composer-opener]") === null,
    }));
    stops.push({ k, target, ...after });
  }
  check(
    "swap-does-not-loop-or-jump",
    stops.every((s) => s.swaps <= 1 && Math.abs(s.scrollY - s.target) <= 1) &&
      stops[0].box &&
      !stops.at(-2).box &&
      stops.at(-1).box,
    stops
      .map(
        (s) =>
          `${s.k}:${s.box ? "box" : "btn"}/${s.swaps}/${s.scrollY - s.target}`,
      )
      .join(" "),
  );

  await evaluate(page, () => window.scrollTo(0, 1e7));
  const s3 = await io.state();
  const editor = await evaluate(page, () => {
    const r = document
      .querySelector('[aria-label="Write a comment"]')
      .getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await io.tap(editor.x, editor.y);
  const s4 = await io.state();
  check(
    "tapping-box-opens-editor",
    s3.boxShown &&
      s4.focusedInside &&
      s4.actionsShown &&
      s4.paddingBottom === "0px",
    s4,
  );
  return out;
}

/**
 * An anchor lands centred in the strip the dock leaves free (T-519), or, near
 * the end, as far down as the page goes; either way clear of the dock.
 */
async function anchorCase(context, fixture, index) {
  const id = fixture.ids[index];
  const page = await openCard(context, fixture, PHONE, `#comment-${id}`);
  try {
    const s = await evaluate(page, readState);
    const rect = await evaluate(
      page,
      (anchor) => {
        const r = document.getElementById(anchor).getBoundingClientRect();
        const top = Number.parseFloat(
          getComputedStyle(document.documentElement).scrollPaddingTop,
        );
        return { top: r.top, bottom: r.bottom, paddingTop: top };
      },
      `comment-${id}`,
    );
    const centre = (rect.paddingTop + s.innerHeight - s.dockHeight) / 2;
    const centred = Math.abs((rect.top + rect.bottom) / 2 - centre) <= 2;
    return {
      name: `anchor-${index + 1}-clear-of-dock`,
      ok:
        (centred || atEnd(s)) &&
        rect.bottom <= s.dockTop + 1 &&
        rect.top >= s.headerBottom - 1,
      detail: { rect, centre, dockTop: s.dockTop, box: s.boxShown },
    };
  } finally {
    await page.close();
  }
}

/**
 * Opening the card lands on the end of the conversation, not of the document:
 * below it are the shell's footer and, on a phone, the sidebar, which a
 * landing at the document's end put between the box and the viewport's edge.
 */
async function landingCases(context, fixture, dir) {
  const out = [];
  for (const [viewport, label] of [
    [PHONE, "phone"],
    [DESKTOP, "desktop"],
  ]) {
    const page = await openCard(context, fixture, viewport);
    try {
      const s = await evaluate(page, readState);
      out.push({
        name: `landing-${label}-box-at-bottom`,
        ok:
          boxAtBottom(s) &&
          s.boxShown &&
          (!viewport.mobile || s.asideTop >= s.innerHeight),
        detail: s,
      });
    } finally {
      await page.close();
    }
  }
  out.push(await cachedLandingCase(context, fixture, dir));
  return out;
}

/**
 * Opened from the list a second time, the card's timeline is cached and lands
 * in the same render as the route's arrival, before the router scrolls the
 * page to the top for it. It has to end up where a first opening does.
 */
async function cachedLandingCase(context, fixture, dir) {
  const page = await newPage(context, fixture, PHONE);
  const io = input(page);
  const href = new URL(fixture.issueUrl).pathname;
  const openFromList = async () => {
    const deadline = Date.now() + 30_000;
    const centre = (path) => {
      // Not the card's own links to itself while it is still leaving.
      if (location.pathname === path) return null;
      const link = [...document.querySelectorAll("a[href]")].find(
        (a) => a.getAttribute("href") === path,
      );
      const r = link?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    };
    while (!(await evaluate(page, centre, href))) {
      if (Date.now() > deadline) throw new Error("list never showed the card");
      await sleep(200);
    }
    // The list settles before the row is where the tap goes.
    await sleep(800);
    const { x, y } = await evaluate(page, centre, href);
    await io.tap(x, y);
    if (!(await landed(page, fixture)))
      throw new Error("card never rendered its last comment");
  };
  try {
    await page.navigate(fixture.listUrl);
    await openFromList();
    // In-app, so the timeline stays in the query cache.
    await evaluate(page, () => history.back());
    await openFromList();
    const s = await evaluate(page, readState);
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      resolve(dir, "landing-phone-cached.png"),
      Buffer.from(shot.data, "base64"),
    );
    return {
      name: "landing-phone-cached",
      ok: boxAtBottom(s) && s.boxShown && s.asideTop >= s.innerHeight,
      detail: s,
    };
  } finally {
    await page.close();
  }
}

async function desktopCases(page) {
  const io = input(page);
  const s0 = await io.state();
  await evaluate(page, () => window.scrollBy(0, -400));
  const s1 = await io.state();
  return [
    {
      name: "desktop-box-everywhere",
      ok: s0.boxShown && !s0.openerShown && s1.boxShown && !s1.openerShown,
      detail: { end: s0, up: s1 },
    },
  ];
}

/**
 * Records every state the scroll-to-bottom layer goes through from the first
 * paint on, so a showing too brief to be caught by a reading still counts.
 */
function recordJumpStates() {
  window.__jumpStates = [];
  let last = null;
  const read = () => {
    const state =
      document.querySelector("[data-scroll-to-bottom]")?.dataset.state ?? null;
    if (state === last) return;
    last = state;
    if (state !== null) window.__jumpStates.push(state);
  };
  new MutationObserver(read).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-state"],
  });
}

/** The scroll-to-bottom button against what floats below it and the column. */
function readJump() {
  const layer = document.querySelector("[data-scroll-to-bottom]");
  const button = layer?.querySelector("button");
  const rect = button?.getBoundingClientRect();
  const style = button ? getComputedStyle(button) : null;
  const hit =
    rect &&
    document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
  const dock = document
    .querySelector('[aria-label="Write a comment"]')
    .closest(".sticky");
  const opener = document.querySelector("[data-composer-opener]");
  const floats = getComputedStyle(dock).position !== "static";
  const column = layer?.parentElement.getBoundingClientRect();
  const list = document.querySelector('[data-testid="timeline-scroll"]');
  return {
    state: layer?.dataset.state ?? null,
    inert: layer?.hasAttribute("inert") ?? null,
    name: button
      ? (button.getAttribute("aria-label") ?? button.textContent.trim())
      : null,
    arrow:
      button
        ?.querySelector("svg")
        ?.getAttribute("class")
        ?.match(/lucide-arrow-(up|down)/)?.[1] ?? null,
    top: rect?.top ?? null,
    bottom: rect?.bottom ?? null,
    centre: rect ? rect.left + rect.width / 2 : null,
    opacity: style?.opacity ?? null,
    translate: style?.translate ?? null,
    hits: button?.contains(hit) === true,
    floatingTop: floats
      ? dock.getBoundingClientRect().top
      : (opener?.getBoundingClientRect().top ?? window.innerHeight),
    headerBottom: document.querySelector("header").getBoundingClientRect()
      .bottom,
    columnCentre: column ? column.left + column.width / 2 : null,
    listBottom: list.getBoundingClientRect().bottom,
    listEnd: list.lastElementChild.getBoundingClientRect().bottom,
    dockTop: dock.getBoundingClientRect().top,
    dockBottom: dock.getBoundingClientRect().bottom,
    innerHeight: window.innerHeight,
    scrollY: window.scrollY,
    maxScroll: document.documentElement.scrollHeight - window.innerHeight,
    states: window.__jumpStates.join(" "),
  };
}

/** One step of the reader's own scrolling: a wheel notch, or a short swipe. */
function nudge(io, viewport, direction) {
  const x = viewport.width / 2;
  const y = viewport.height / 2;
  if (!viewport.mobile) return io.wheel(x, y, 100 * direction);
  // A finger moving up drags the page down.
  return io.swipe(x, y + 40 * direction, -80 * direction);
}

/**
 * The scroll-to-bottom button shows on the reader's scroll down and on
 * nothing else, sits centred in the column above whatever floats at the
 * bottom, hides on a scroll up, and lands on the box when clicked.
 */
async function jumpCases(context, card, viewport, label, dir) {
  const page = await openCard(context, card, viewport, "", [
    `(${recordJumpStates})()`,
  ]);
  const io = input(page);
  const out = [];
  const read = () => evaluate(page, readJump);
  const check = (name, ok, detail) =>
    out.push({ name: `jump-${label}-${name}`, ok: Boolean(ok), detail });
  const placed = (j) =>
    j.hits &&
    Math.abs(j.floatingTop - 12 - j.bottom) <= 1 &&
    j.top >= j.headerBottom &&
    Math.abs(j.centre - j.columnCentre) <= 1 &&
    j.opacity === "1" &&
    ["none", "0px"].includes(j.translate);
  try {
    const landed = await read();
    check(
      "landing",
      landed.state === "hidden" && !landed.states.includes("shown"),
      landed,
    );

    for (let i = 0; i < 40 && (await read()).scrollY > 0; i++) {
      if (viewport.mobile)
        await io.swipe(viewport.width / 2, 200, viewport.height / 2);
      else await io.wheel(viewport.width / 2, viewport.height / 2, -600);
      await sleep(200);
    }
    await sleep(400);
    const top = await read();
    check(
      "up",
      top.scrollY === 0 &&
        top.state === "hidden" &&
        !top.states.includes("shown"),
      top,
    );

    await nudge(io, viewport, 1);
    await sleep(400);
    const down = await read();
    check(
      "down",
      down.state === "shown" &&
        down.name === "Scroll to bottom" &&
        placed(down),
      down,
    );
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      resolve(dir, `jump-${label}-down.png`),
      Buffer.from(shot.data, "base64"),
    );

    await nudge(io, viewport, -1);
    await sleep(400);
    const up = await read();
    check(
      "up-hides",
      up.state === "hidden" && up.inert && !up.hits && up.opacity === "0",
      up,
    );

    if (!viewport.mobile) {
      const moving = up.translate;
      await page.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      // The slide's own transition plays the change out first.
      await sleep(400);
      const still = (await read()).translate;
      await page.send("Emulation.setEmulatedMedia", { features: [] });
      check("reduced-motion", moving === "0px 8px" && still === "none", {
        moving,
        still,
      });
    }

    await nudge(io, viewport, 1);
    await sleep(400);
    const before = await read();
    const x = before.centre ?? 0;
    const y = ((before.top ?? 0) + (before.bottom ?? 0)) / 2;
    if (viewport.mobile) await io.tap(x, y);
    else await io.click(x, y);
    await sleep(400);
    const clicked = await read();
    check(
      "click",
      before.state === "shown" &&
        Math.abs(clicked.dockBottom - clicked.innerHeight) <= 1 &&
        clicked.state === "hidden",
      { before, clicked },
    );
    if (!viewport.mobile) {
      // At the end the dock is in its place in the flow: the list's gap to it
      // is the column's own, with nothing added by the layer between them.
      check("gap", Math.abs(clicked.dockTop - clicked.listBottom - 16) <= 0.5, {
        gap: clicked.dockTop - clicked.listBottom,
      });
    }

    await evaluate(
      page,
      (id) => {
        window.__jumpStates = [];
        window.location.hash = `#comment-${id}`;
      },
      card.ids[1],
    );
    await sleep(1500);
    const anchored = await read();
    await nudge(io, viewport, 1);
    await sleep(400);
    const after = await read();
    check(
      "anchor",
      anchored.scrollY < clicked.scrollY - 500 &&
        anchored.state === "hidden" &&
        !anchored.states.includes("shown") &&
        after.state === "shown",
      { anchored, after },
    );
  } finally {
    await page.close();
  }
  return out;
}

/**
 * In a phone's sidebar, below the comment box, the end of the conversation is
 * above the viewport: scrolling there neither shows the button nor leaves it
 * showing at the column's foot, out of sight but in reach of Tab.
 */
async function shortCases(context, card) {
  const page = await openCard(context, card, SHORT, "", [
    `(${recordJumpStates})()`,
  ]);
  const io = input(page);
  const out = [];
  const read = () => evaluate(page, readJump);
  const check = (name, ok, detail) =>
    out.push({ name: `jump-short-${name}`, ok: Boolean(ok), detail });
  const toEnd = () =>
    evaluate(page, () => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      window.__jumpStates = [];
    });
  try {
    await toEnd();
    await sleep(400);
    const end = await read();
    const readings = [end];
    await io.swipe(SHORT.width / 2, 150, 80);
    await sleep(400);
    readings.push(await read());
    await io.swipe(SHORT.width / 2, 250, -80);
    await sleep(400);
    readings.push(await read());
    check(
      "sidebar",
      readings.every((j) => j.listEnd < 0 && j.state === "hidden" && j.inert) &&
        !readings.at(-1).states.includes("shown"),
      readings,
    );

    await toEnd();
    await sleep(400);
    await evaluate(page, () => window.scrollTo(0, 0));
    await sleep(400);
    const jumped = await read();
    await io.swipe(SHORT.width / 2, 250, -80);
    await sleep(400);
    const down = await read();
    check(
      "jump-up",
      jumped.scrollY === 0 &&
        jumped.state === "hidden" &&
        down.state === "shown",
      { jumped, down },
    );

    await io.tap(down.centre ?? 0, ((down.top ?? 0) + (down.bottom ?? 0)) / 2);
    await sleep(400);
    const clicked = await read();
    check(
      "click",
      Math.abs(clicked.dockBottom - clicked.innerHeight) <= 1 &&
        clicked.state === "hidden" &&
        clicked.inert,
      clicked,
    );

    // Down to the page's end with real input, which also lets go of the
    // click's own hold: past the comment box, not only past the list's end,
    // where a box still on screen is the end a new comment is followed to.
    for (let i = 0; i < 8; i++) {
      const at = await read();
      if (at.scrollY >= at.maxScroll - 1) break;
      await io.swipe(SHORT.width / 2, 300, -200);
      await sleep(300);
    }
    await sleep(400);
    const before = await read();
    const result = await card.comment("Arrives above a reader in the sidebar");
    const id = (result.comment ?? result).id;
    const deadline = Date.now() + 10_000;
    while ((await read()).state !== "shown" && Date.now() < deadline)
      await sleep(200);
    // Past its slide in.
    await sleep(400);
    const above = await read();
    check(
      "new-above",
      before.dockBottom < 0 &&
        above.listEnd < 0 &&
        above.state === "shown" &&
        above.name === "1 new message" &&
        above.arrow === "up" &&
        above.hits &&
        Math.abs(above.floatingTop - 12 - above.bottom) <= 1 &&
        above.top >= 0,
      { before, above },
    );
    await io.tap(
      above.centre ?? 0,
      ((above.top ?? 0) + (above.bottom ?? 0)) / 2,
    );
    await sleep(600);
    const back = await evaluate(
      page,
      (comment) => ({
        top:
          document.getElementById(comment)?.getBoundingClientRect().top ?? null,
        paddingTop: Number.parseFloat(
          getComputedStyle(document.documentElement).scrollPaddingTop,
        ),
        innerHeight: window.innerHeight,
        state:
          document.querySelector("[data-scroll-to-bottom]")?.dataset.state ??
          null,
      }),
      `comment-${id}`,
    );
    check(
      "new-above-click",
      back.top !== null &&
        back.top >= back.paddingTop - 1 &&
        back.top < back.innerHeight &&
        back.state === "hidden",
      back,
    );
  } finally {
    await page.close();
  }
  return out;
}

/**
 * Scroll up with real input, more than a screen from the end, so that new
 * comments are announced rather than followed.
 */
async function scrollAway(page, io, viewport) {
  for (let i = 0; i < 8; i++) {
    const p = await evaluate(page, readPill);
    // New comments are followed only at the end of the conversation.
    if (p.fromEnd > p.innerHeight) return;
    if (viewport.mobile) await io.swipe(viewport.width / 2, 120, 700);
    else await io.wheel(viewport.width / 2, viewport.height / 2, -600);
    await sleep(400);
  }
}

/**
 * With two comments arriving while the reader is away, New messages lands on
 * the first of them under the header, not at the end past both. Two short
 * ones leave too little below the first for that: it lands on the comment box
 * then, as the arrow does, with the first in view above it.
 */
async function firstNewCase(context, fixture, viewport, label, size) {
  const page = await openCard(context, fixture, viewport);
  try {
    const io = input(page);
    await scrollAway(page, io, viewport);
    const arrived = [];
    for (const which of ["first", "second"]) {
      const text = `Arrives ${which} while the ${label} reader is away`;
      const result = await fixture.comment(
        size === "short"
          ? text
          : `${text}\n\n${"A line long enough to wrap. ".repeat(6)}\n\n`.repeat(
              4,
            ),
      );
      arrived.push((result.comment ?? result).id);
    }
    const deadline = Date.now() + 10_000;
    let at = await evaluate(page, readPill);
    while (Date.now() < deadline) {
      const seen = await evaluate(
        page,
        (id) => document.getElementById(`comment-${id}`) !== null,
        arrived[1],
      );
      if (at.shown && seen) break;
      await sleep(200);
      at = await evaluate(page, readPill);
    }
    // Read before the click: a phone's header slides away once the page
    // moves, taking its share of the padding with it, while what the landing
    // placed stays where it was put.
    const paddingTop = await evaluate(page, () =>
      Number.parseFloat(
        getComputedStyle(document.documentElement).scrollPaddingTop,
      ),
    );
    const y = (at.top + at.bottom) / 2;
    if (viewport.mobile) await io.tap(at.centre, y);
    else await io.click(at.centre, y);
    await sleep(600);
    const landed = await evaluate(
      page,
      (ids) => {
        const top = (id) =>
          document.getElementById(`comment-${id}`)?.getBoundingClientRect()
            .top ?? null;
        const dock = document
          .querySelector('[aria-label="Write a comment"]')
          .closest(".sticky");
        return {
          first: top(ids[0]),
          second: top(ids[1]),
          // The end of the conversation: the column the dock ends.
          columnBottom: dock.parentElement.getBoundingClientRect().bottom,
          innerHeight: window.innerHeight,
          state:
            document.querySelector("[data-scroll-to-bottom]")?.dataset.state ??
            null,
        };
      },
      arrived,
    );
    const below = (top) => (top === null ? null : top - paddingTop);
    return {
      name: `pill-${label}-first-new${size === "short" ? "-short" : ""}`,
      ok:
        landed.state === "hidden" &&
        (size === "short"
          ? Math.abs(landed.columnBottom - landed.innerHeight) <= 1 &&
            below(landed.first) >= -1 &&
            landed.first < landed.innerHeight
          : // A half pixel either way at a device pixel ratio of 2.
            below(landed.first) >= -1 &&
            below(landed.first) <= 2 &&
            Math.abs(below(landed.second)) > 2),
      detail: { pill: at, paddingTop, ...landed },
    };
  } finally {
    await page.close();
  }
}

/**
 * The New messages pill sits above whatever floats at the bottom, below the
 * header, and takes the click at its centre, through every height the dock
 * goes through. Scrolls with real input: the bottom landing's hold lets go
 * only on the reader's first input, and until then the arriving comment
 * would pull the page back down instead of raising the pill.
 */
async function pillCases(page, fixture, viewport, label, dir) {
  const io = input(page);
  const out = [];
  const pill = () => evaluate(page, readPill);
  await scrollAway(page, io, viewport);
  await fixture.comment(`Arrives while the ${label} reader is away`);
  const deadline = Date.now() + 10_000;
  while (!(await pill()).shown && Date.now() < deadline) await sleep(200);

  const check = async (name, extra, detail) => {
    const p = await pill();
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      resolve(dir, `pill-${label}-${name}.png`),
      Buffer.from(shot.data, "base64"),
    );
    out.push({
      name: `pill-${label}-${name}`,
      ok: Boolean(
        p.shown &&
          p.hits &&
          p.bottom <= p.floatingTop &&
          p.top >= p.headerBottom &&
          extra(p),
      ),
      detail: { ...p, ...detail },
    });
    return p;
  };

  await sleep(400);
  await check("folded", (p) =>
    viewport.mobile ? !p.floats && p.openerShown : p.floats && !p.actionsShown,
  );

  const target = await evaluate(
    page,
    (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    viewport.mobile
      ? "[data-composer-opener]"
      : '[aria-label="Write a comment"]',
  );
  if (viewport.mobile) await io.tap(target.x, target.y);
  else await io.click(target.x, target.y);
  await sleep(400);
  const focused = await check(
    "focused",
    (p) => p.focusedInside && p.actionsShown,
  );

  await io.type(Array.from({ length: 8 }, (_, i) => `Draft line ${i + 1}`));
  await sleep(400);
  const tall = await check(
    "tall-draft",
    (p) => p.dockHeight >= focused.dockHeight + 100,
    { grewBy: (await pill()).dockHeight - focused.dockHeight },
  );

  if (viewport.mobile) {
    // What an on-screen keyboard does to the page: the shell publishes the
    // strip it covers, and the floating layers rise above it.
    const previous = await evaluate(page, () => {
      const root = document.documentElement;
      const value = root.style.getPropertyValue("--vv-bottom");
      root.style.setProperty("--vv-bottom", "300px");
      return value;
    });
    await sleep(400);
    const rose = tall.dockTop - (await pill()).dockTop;
    await check("keyboard-inset", () => rose >= 290 && rose <= 310, { rose });
    await evaluate(
      page,
      (value) => {
        const root = document.documentElement;
        if (value) root.style.setProperty("--vv-bottom", value);
        else root.style.removeProperty("--vv-bottom");
      },
      previous,
    );
  }

  return out;
}

/**
 * The reader's place, what New messages says, and where `arrived`, a comment
 * id, has come to rest.
 */
function readFollow(arrived) {
  const paddingTop = Number.parseFloat(
    getComputedStyle(document.documentElement).scrollPaddingTop,
  );
  // The comment at the top of what the reader sees.
  const reading = [...document.querySelectorAll('[id^="comment-"]')].find(
    (comment) => comment.getBoundingClientRect().bottom > paddingTop,
  );
  const dock = document
    .querySelector('[aria-label="Write a comment"]')
    .closest(".sticky");
  const layer = document.querySelector("[data-scroll-to-bottom]");
  const button = layer?.querySelector("button");
  // Its name carries the count when it has one.
  const name = button
    ? (button.getAttribute("aria-label") ?? button.textContent.trim())
    : null;
  const rect =
    arrived === undefined
      ? undefined
      : document.getElementById(`comment-${arrived}`)?.getBoundingClientRect();
  return {
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    paddingTop,
    readingId: reading?.id ?? null,
    readingTop: reading?.getBoundingClientRect().top ?? null,
    // The end of the conversation: the column the dock ends.
    endBottom: dock.parentElement.getBoundingClientRect().bottom,
    dockTop: dock.getBoundingClientRect().top,
    dockHeight: dock.getBoundingClientRect().height,
    pill:
      layer?.dataset.state === "shown" &&
      /^(New messages|\d+ new messages?)$/.test(name ?? ""),
    arrivedTop: rect?.top ?? null,
    arrivedBottom: rect?.bottom ?? null,
  };
}

/**
 * New comments are followed only from the end of the conversation:
 * a reader half a screen up, one the list grew away from with no scroll, one
 * sending their own comment from up there, and one the page was moved off the
 * end of with no input all stay where they are, while one at the end, typing
 * a reply, is followed: to the end for a short comment, to the top of one
 * longer than the screen. Someone else's comment arrives from another
 * account.
 */
async function followCases(context, fixture, viewport, label, dir) {
  const out = [];
  const h = viewport.height;
  const x = viewport.width / 2;
  const run = async (name, body) => {
    const page = await openCard(context, fixture, viewport);
    try {
      const { ok, detail } = await body(page, input(page), (arrived) =>
        evaluate(page, readFollow, arrived),
      );
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(
        resolve(dir, `follow-${label}-${name}.png`),
        Buffer.from(shot.data, "base64"),
      );
      out.push({ name: `follow-${label}-${name}`, ok: Boolean(ok), detail });
    } finally {
      await page.close();
    }
  };
  /** Someone else's comment, once it has rendered and had time to land. */
  const arrive = async (page, body) => {
    const result = await fixture.comment(body);
    const id = (result.comment ?? result).id;
    const deadline = Date.now() + 10_000;
    while (
      !(await evaluate(
        page,
        (comment) => document.getElementById(comment) !== null,
        `comment-${id}`,
      ))
    ) {
      if (Date.now() > deadline) throw new Error(`comment ${id} never showed`);
      await sleep(200);
    }
    await sleep(1200);
    return id;
  };
  /** Up by about `px`, with the reader's own input. */
  const scrollUp = async (io, px) => {
    if (viewport.mobile) {
      for (let left = px; left > 0; left -= 300) {
        await io.swipe(x, 200, Math.min(left, 300));
        await sleep(300);
      }
    } else await io.wheel(x, h / 2, -px);
    await sleep(800);
  };
  /**
   * The reader's own input at the end, which lets go of the opening's hold
   * and leaves the page there: a touch too short to scroll, or a wheel notch
   * up and back down.
   */
  const touchAtEnd = async (io) => {
    if (viewport.mobile) await io.swipe(x, h / 2, 1);
    else {
      await io.wheel(x, h / 2, -100);
      await sleep(400);
      await io.wheel(x, h / 2, 100);
    }
    await sleep(800);
  };
  const press = (io, at) =>
    viewport.mobile ? io.tap(at.x, at.y) : io.click(at.x, at.y);
  const centreOf = (page, selector) =>
    evaluate(
      page,
      (s) => {
        const r = document.querySelector(s).getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      },
      selector,
    );
  const kept = (before, after) =>
    Math.abs(after.scrollY - before.scrollY) <= 1 &&
    after.readingId === before.readingId &&
    Math.abs(after.readingTop - before.readingTop) <= 1;
  const atEndNow = (s) => Math.abs(s.endBottom - s.innerHeight) <= 1;

  await run("half-up", async (page, io, read) => {
    await scrollUp(io, h / 2);
    const before = await read();
    const id = await arrive(page, `Arrives below the ${label} reader`);
    const after = await read(id);
    return { ok: kept(before, after) && after.pill, detail: { before, after } };
  });

  // An image loading, a fold opened: the end moves away with no scroll. A
  // phone's static folded box is what its scroll anchoring holds on to, and
  // it keeps a reader at the end there; a desktop's sticky one is not.
  await run("grown", async (page, io, read) => {
    await touchAtEnd(io);
    await evaluate(
      page,
      (height) => {
        const comments = document.querySelectorAll('[id^="comment-"]');
        const block = document.createElement("div");
        block.style.height = `${height}px`;
        comments[comments.length - 1].append(block);
      },
      h * 1.5,
    );
    await sleep(600);
    const before = await read();
    const id = await arrive(page, `Arrives below a grown ${label} page`);
    const after = await read(id);
    const stayed = Math.abs(before.endBottom - before.innerHeight) <= 40;
    return {
      ok: stayed
        ? viewport.mobile && atEndNow(after)
        : kept(before, after) && after.pill,
      detail: { stayed, before, after },
    };
  });

  // The draft pushes the end down with no scroll, and the reader writing it
  // is still at the end.
  if (!viewport.mobile) {
    await run("typing", async (page, io, read) => {
      await touchAtEnd(io);
      await press(io, await centreOf(page, '[aria-label="Write a comment"]'));
      await sleep(400);
      const opened = await read();
      await io.type(Array.from({ length: 8 }, (_, i) => `Draft line ${i + 1}`));
      await sleep(400);
      const before = await read();
      const id = await arrive(page, `Arrives while the ${label} reader types`);
      const after = await read(id);
      return {
        ok:
          before.dockHeight >= opened.dockHeight + 100 &&
          after.arrivedTop >= 0 &&
          after.arrivedBottom <= after.dockTop + 1 &&
          !after.pill,
        detail: { grewBy: before.dockHeight - opened.dockHeight, after },
      };
    });
  }

  await run("own", async (page, io, read) => {
    await scrollUp(io, h / 2);
    await press(
      io,
      await centreOf(
        page,
        viewport.mobile
          ? "[data-composer-opener]"
          : '[aria-label="Write a comment"]',
      ),
    );
    await sleep(400);
    const text = `Sent from above the ${label} end`;
    await io.type([text]);
    await sleep(400);
    const before = await read();
    await press(
      io,
      await centreOf(page, '.composer-actions-in button[type="submit"]'),
    );
    const deadline = Date.now() + 10_000;
    const sent = (t) =>
      document.querySelector('[data-unit^="pending-"]') === null &&
      [...document.querySelectorAll('[id^="comment-"]')].some((comment) =>
        comment.textContent.includes(t),
      );
    while (!(await evaluate(page, sent, text))) {
      if (Date.now() > deadline) throw new Error("own comment never showed");
      await sleep(200);
    }
    await sleep(1200);
    const after = await read();
    // Whether New messages shows for it is not this case's to say.
    return { ok: kept(before, after), detail: { before, after } };
  });

  // iOS scrolling to the top at a tap on the status bar, find in page
  // scrolling to a match: the opening's landing hears no input from either.
  await run("moved-no-input", async (page, _io, read) => {
    await evaluate(page, (by) => window.scrollBy(0, -by), 2 * h);
    await sleep(600);
    const before = await read();
    const id = await arrive(page, `Arrives after the ${label} page moved`);
    const after = await read(id);
    return {
      ok: Math.abs(after.scrollY - before.scrollY) <= 1 && after.pill,
      detail: { before, after },
    };
  });

  // A comment longer than the screen, followed from the end, is shown from
  // its top, where New messages would put it, and held there: what comes
  // next is announced rather than followed off it.
  await run("long", async (page, io, read) => {
    await touchAtEnd(io);
    // Read before the landing: a phone's header slides away once the page
    // moves, taking its share of the padding with it.
    const before = await read();
    const id = await arrive(
      page,
      Array.from(
        { length: Math.ceil((3 * h) / 40) },
        (_, i) => `Long arrival, paragraph ${i + 1}.`,
      ).join("\n\n"),
    );
    const landed = await read(id);
    const next = await arrive(page, `Arrives after the long ${label} one`);
    const after = await read(next);
    return {
      ok:
        atEndNow(before) &&
        landed.arrivedBottom - landed.arrivedTop > 2 * h &&
        // A half pixel either way at a device pixel ratio of 2.
        landed.arrivedTop >= before.paddingTop - 1 &&
        landed.arrivedTop <= before.paddingTop + 2 &&
        Math.abs(after.scrollY - landed.scrollY) <= 1 &&
        after.pill,
      detail: { before, landed, after },
    };
  });

  // A short one is followed to the end, in view above the comment box.
  await run("short", async (page, io, read) => {
    await touchAtEnd(io);
    const before = await read();
    const id = await arrive(page, `Arrives short at the ${label} end`);
    const after = await read(id);
    return {
      ok:
        atEndNow(before) &&
        atEndNow(after) &&
        after.arrivedTop >= 0 &&
        after.arrivedBottom <= after.dockTop + 1 &&
        !after.pill,
      detail: { before, after },
    };
  });
  return out;
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
  const record = (name, cases) => {
    const red = cases.filter((c) => !c.ok).map((c) => c.name);
    runs.push({ name, status: red.length ? "fail" : "pass", red, cases });
    console.log(`RUN ${JSON.stringify({ name, pass: !red.length, red })}`);
    for (const c of cases)
      console.log(
        `  ${c.ok ? "ok  " : "RED "} ${c.name} ${JSON.stringify(c.detail)}`,
      );
    if (red.length) exitCode = Math.max(exitCode, 1);
  };

  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "composer-dock-smoke-",
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
      let page = await openCard(context, fixture, PHONE);
      try {
        record("phone", await phoneCases(page));
      } finally {
        await page.close();
      }
      record("phone-anchors", [
        await anchorCase(context, fixture, 5),
        await anchorCase(context, fixture, fixture.ids.length - 1),
      ]);
      page = await openCard(context, fixture, DESKTOP);
      try {
        record("desktop", await desktopCases(page));
      } finally {
        await page.close();
      }
      record("landing", await landingCases(context, fixture, stack.dir));
      const long = { ...fixture, ...fixture.long };
      const jumps = [];
      for (const [viewport, label] of [
        [PHONE, "phone"],
        [DESKTOP, "desktop"],
      ])
        jumps.push(
          ...(await jumpCases(context, long, viewport, label, stack.dir)),
        );
      jumps.push(...(await shortCases(context, long)));
      record("jump", jumps);
      // Last: each viewport posts a comment, and the anchors above count on
      // the seeded one being the card's last.
      const pills = [];
      for (const [viewport, label] of [
        [PHONE, "phone"],
        [DESKTOP, "desktop"],
      ]) {
        page = await openCard(context, fixture, viewport);
        try {
          pills.push(
            ...(await pillCases(page, fixture, viewport, label, stack.dir)),
          );
        } finally {
          await page.close();
        }
        for (const size of ["long", "short"])
          pills.push(
            await firstNewCase(context, fixture, viewport, label, size),
          );
      }
      record("pill", pills);
      // After the pills, so the geometry they measure is the seeded card's.
      const follows = [];
      for (const [viewport, label] of [
        [PHONE, "phone"],
        [DESKTOP, "desktop"],
      ])
        follows.push(
          ...(await followCases(context, fixture, viewport, label, stack.dir)),
        );
      record("follow", follows);
    } finally {
      await context.close();
    }
  } catch (error) {
    exitCode = 2;
    runs.push({
      name: "runner-error",
      status: "fail",
      error: error.stack ?? String(error),
    });
    console.error(`composer-dock-smoke: ${error.stack ?? error}`);
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
    name: "composer-dock-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    runs,
  };
  console.log(`REPORT ${JSON.stringify({ status: report.status, exitCode })}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "composer-dock-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
