import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { evaluate } from "../lib/browser-cdp.mjs";

// The spec page's outline and change strip, where happy-dom cannot
// look: the strip's place on the card's border, its height once stuck and
// its scale while the page scrolls, where a click on it lands, its tooltip
// over an open comment popover, and the outline's landing on a folded
// heading and its current row at real positions.
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
const PATH = "design.md";
const EPSILON = 0.5;
const LANDING_SLOP = 2;
const READING_LINE = 0.3;
const FOLDED_HEADING = "Charlie";

/**
 * Faults the self-test injects, each into a fresh page, with the failure it
 * must be reported as.
 *
 * - `tick-scale`: the ticks drawn against the part of the card on screen
 *   rather than against the whole card, so they slide as the page scrolls.
 * - `tooltip-under-popover`: the tooltip below the popover layer.
 * - `fold-not-opened`: the outline's jump never reaches the fold's
 *   placeholder, so the heading it aims at has no box.
 * - `tooltip-catches-pointer`: the tooltip takes the pointer from what lies
 *   under it.
 */
const FAULTS = {
  "tick-scale": "ticks-move-on-scroll",
  "tooltip-under-popover": "tooltip-under-popover",
  "fold-not-opened": "folded-heading-landing",
  "tooltip-catches-pointer": "tooltip-catches-pointer",
};

/** The faults that are a stylesheet, and its rule. */
const FAULT_CSS = {
  "tooltip-under-popover":
    "[data-spec-strip-tooltip] { z-index: 40 !important; }",
  "tooltip-catches-pointer":
    "[data-spec-strip-tooltip] { pointer-events: auto !important; }",
};

function failure(name, detail, width) {
  return { name, detail, ...(width ? { width } : {}) };
}

/** A paragraph long enough to wrap over a few lines at every width. */
function paragraph(section, n) {
  return `${section} paragraph ${n} runs on for a while so that it wraps across several lines of the card, which gives the document the height of a real specification and the strip something to scale down.`;
}

function section(name, count, edit = {}) {
  const rows = [`## ${name}`, ""];
  for (let n = 1; n <= count; n += 1) {
    if (edit.drop === n) continue;
    rows.push(
      edit.reword === n
        ? `${paragraph(name, n)} Reworded in v2.`
        : paragraph(name, n),
      "",
    );
    if (edit.insertAfter === n)
      rows.push(
        `${name} gained this paragraph in v2, which is new in its entirety.`,
        "",
      );
  }
  return rows;
}

/**
 * Six sections, three of them changed: a paragraph reworded under Bravo, the
 * last paragraph of Delta removed right before Echo's heading, and one added
 * under Echo. Comparing them folds Charlie, which nothing touches.
 */
function documentBody(version) {
  const v2 = version === 2;
  return [
    "# Outline and strip fixture",
    "",
    paragraph("Intro", 1),
    "",
    ...section("Alpha", 6),
    ...section("Bravo", 6, v2 ? { reword: 3 } : {}),
    ...section(FOLDED_HEADING, 8),
    ...section("Delta", 7, v2 ? { drop: 7 } : {}),
    ...section("Echo", 6, v2 ? { insertAfter: 4 } : {}),
  ].join("\n");
}

const lineOf = (body, text) =>
  body.split("\n").findIndex((line) => line.startsWith(text)) + 1;

/** One project and card, two versions, a comment open, one resolved. */
export async function seedSpecOutlineFixture(serverPort) {
  const base = `http://127.0.0.1:${serverPort}/api`;
  let cookie = "";
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    if (!response.ok)
      throw new Error(
        `${method} ${path} -> ${response.status} ${await response.text()}`,
      );
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "/auth/login");
  const slug = `spec-outline-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  await call("POST", "/projects", {
    slug,
    name: `Spec outline ${slug}`,
    description: "",
  });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Rendered spec with an outline and a change strip",
    body: "",
  });
  const spec = `/projects/${slug}/issues/${issue.number}/spec`;
  await call("POST", `${spec}/push`, {
    files: [{ path: PATH, body: documentBody(1) }],
    message: "v1",
  });
  const body = documentBody(2);
  const pushed = await call("POST", `${spec}/push`, {
    files: [{ path: PATH, body }],
    message: "v2",
  });
  const anchor = (text) => {
    const line = lineOf(body, text);
    if (line < 1) throw new Error(`fixture has no line ${text}`);
    return {
      path: PATH,
      version: pushed.version,
      line_start: line,
      line_end: line,
    };
  };
  const review = await call("POST", `${spec}/reviews`, {
    version: pushed.version,
    verdict: "comment",
    comments: [
      { anchor: anchor("Alpha paragraph 2"), body: "An open comment." },
      {
        anchor: anchor(`${FOLDED_HEADING} paragraph 2`),
        body: "A resolved one.",
      },
    ],
  });
  await call("POST", `${spec}/comments/resolve`, {
    comment_ids: [review.comment_ids[1]],
  });
  const draft = {
    id: "smoke-draft",
    anchor: { ...anchor("Echo paragraph 1"), col_start: null, col_end: null },
    quote: "",
    body: "A draft of the reader's own.",
  };
  return {
    slug,
    number: issue.number,
    cookie,
    draftKey: `todou-spec-review:${slug}:${issue.number}`,
    drafts: [draft],
    url: `/projects/${slug}/issues/${issue.number}/spec?file=${PATH}`,
  };
}

/**
 * `count` file-level drafts, a few lines each, which stand in the File
 * comments box above the card.
 */
function fileDrafts(path, version, count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `file-draft-${i + 1}`,
    anchor: {
      path,
      version,
      line_start: null,
      line_end: null,
      col_start: null,
      col_end: null,
    },
    quote: "",
    body: [1, 2, 3, 4]
      .map((line) => `File comment ${i + 1}, line ${line}.`)
      .join("\n"),
  }));
}

/**
 * Before the app loads: the reader's draft and any `extraDrafts`, and whether
 * folding is on.
 */
function setupSource(fixture, fold, extraDrafts = []) {
  return `(() => {
    try {
      localStorage.setItem(${JSON.stringify(fixture.draftKey)}, ${JSON.stringify(JSON.stringify([...fixture.drafts, ...extraDrafts]))});
      localStorage.setItem("todou-spec-fold", ${JSON.stringify(fold ? "on" : "off")});
    } catch {}
  })()`;
}

/** The fault's page-side half; see FAULTS. */
function faultSource(fault) {
  if (FAULT_CSS[fault]) {
    return `(() => {
      const inject = () => {
        if (!document.head || document.querySelector("style[data-spec-outline-fault]")) return;
        const style = document.createElement("style");
        style.dataset.specOutlineFault = "";
        style.textContent = ${JSON.stringify(FAULT_CSS[fault])};
        document.head.append(style);
      };
      new MutationObserver(inject).observe(document, { childList: true, subtree: true });
      inject();
    })()`;
  }
  if (fault === "fold-not-opened") {
    return `(() => {
      window.__specOutlineFault = 0;
      document.addEventListener("click", (event) => {
        if (event.isTrusted || !(event.target instanceof Element)) return;
        if (!event.target.closest(".spec-fold")) return;
        event.stopImmediatePropagation();
        window.__specOutlineFault += 1;
      }, true);
    })()`;
  }
  if (fault === "tick-scale") {
    return `(() => {
      window.__specOutlineFault = 0;
      const base = new WeakMap();
      const rescale = () => {
        const strip = document.querySelector("[data-spec-strip]");
        const card = strip?.parentElement;
        const bar = strip?.firstElementChild;
        if (!card || !bar) return;
        const rect = card.getBoundingClientRect();
        const toolbar = Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
        const shown = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, toolbar);
        const height = bar.getBoundingClientRect().height;
        if (!(shown > 0) || !(height > 0)) return;
        for (const tick of bar.querySelectorAll("[data-kind]")) {
          if (!base.has(tick)) base.set(tick, Number.parseFloat(tick.style.top) || 0);
          tick.style.top = (base.get(tick) * shown) / height + "px";
        }
        window.__specOutlineFault += 1;
      };
      addEventListener("scroll", () => requestAnimationFrame(() => requestAnimationFrame(rescale)), { passive: true });
    })()`;
  }
  return "";
}

/** Page-side helpers, installed on every page as `window.__specOutline`. */
function probeSource() {
  return `(() => {
    const round = (value) => Number.isFinite(value) ? Number(value.toFixed(2)) : null;
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: round(rect.left), right: round(rect.right), top: round(rect.top), bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height) };
    };
    const doc = () => document.querySelector('[data-testid="annotated-markdown"]');
    const strip = () => document.querySelector("[data-spec-strip]");
    const bar = () => strip()?.firstElementChild ?? null;
    const card = () => doc()?.parentElement ?? null;
    const usable = () => {
      const style = getComputedStyle(document.documentElement);
      const top = Number.parseFloat(style.scrollPaddingTop) || 0;
      const bottom = Number.parseFloat(style.scrollPaddingBottom) || 0;
      return { top, height: innerHeight - top - bottom };
    };
    const end = () => Math.max(0, document.documentElement.scrollHeight - innerHeight);
    /** What ↓ steps over: the outermost changed blocks, in order. */
    const stops = () => {
      const kept = [];
      for (const el of doc()?.querySelectorAll(".spec-changed, .spec-ins-block") ?? []) {
        if (kept.at(-1)?.contains(el)) continue;
        kept.push(el);
      }
      return kept;
    };
    const deletions = () => [...(doc()?.querySelectorAll(".spec-del-block, .spec-del-structure, .spec-del-row, .spec-del-cell, .spec-del") ?? [])]
      .filter((el) => !stops().some((stop) => stop.contains(el)))
      .filter((el, i, all) => !all.slice(0, i).some((outer) => outer.contains(el)));
    const ready = () => {
      const s = strip(), c = card(), b = bar();
      return !!s && !!c && !!b && b.getBoundingClientRect().height > 0 &&
        b.querySelectorAll("[data-stop-index]").length > 0 &&
        !!document.querySelector('[aria-label$="on this block"]') &&
        !!document.querySelector("[data-spec-outline]");
    };
    const ticks = () => {
      const b = bar();
      if (!b) return [];
      const top = b.getBoundingClientRect().top;
      return [...b.querySelectorAll("[data-kind]")].map((tick) => {
        const rect = tick.getBoundingClientRect();
        return { kind: tick.dataset.kind, stop: tick.dataset.stopIndex ?? null, top: round(rect.top - top), height: round(rect.height), center: round(rect.top + rect.height / 2) };
      });
    };
    const layout = () => {
      const c = card(), s = strip(), b = bar();
      if (!c || !s || !b) return { found: false };
      const style = getComputedStyle(c);
      const counter = document.querySelector('[data-toolbar-slot="change-count"]')?.textContent ?? "";
      return {
        found: true,
        card: { ...box(c), borderRight: Number.parseFloat(style.borderRightWidth) || 0, borderRightColor: style.borderRightColor },
        strip: box(s),
        bar: box(b),
        counter,
        ticks: ticks(),
        deletions: deletions().map((el) => {
          const rect = el.getBoundingClientRect();
          const cardRect = c.getBoundingClientRect();
          return round(((rect.top - cardRect.top) / cardRect.height) * b.getBoundingClientRect().height);
        }),
      };
    };
    /** The bar and the toolbar it stops below, against the window's height. */
    const band = () => {
      const b = bar(), toolbar = document.querySelector("div[data-header-follow]");
      return b && toolbar ? { bar: box(b), toolbar: box(toolbar), innerHeight } : null;
    };
    /** The File comments box above the card, while it is there. */
    const fileComments = () => [...document.querySelectorAll("main h3")]
      .find((el) => el.textContent.trim() === "File comments")?.parentElement ?? null;
    /** Discards every draft in the File comments box; how many it pressed. */
    const discardFileComments = () => {
      const buttons = [...(fileComments()?.querySelectorAll("button") ?? [])]
        .filter((el) => el.textContent.trim() === "Discard");
      for (const button of buttons) button.click();
      return buttons.length;
    };
    const settle = async () => {
      let last = null, same = 0;
      for (let frames = 0; frames < 600 && same < 6; frames += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        same = scrollY === last ? same + 1 : 0;
        last = scrollY;
      }
      return scrollY;
    };
    /** Where ↓ would leave the page for stop i: the app's own resting rule. */
    const restingFor = (i) => {
      const el = stops()[i];
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const block = { top: rect.top + scrollY, height: rect.height };
      const u = usable();
      const resting = u.height <= 0 || block.height > u.height
        ? block.top - u.top
        : block.top + block.height / 2 - (u.top + u.height / 2);
      return Math.min(Math.max(0, resting), end());
    };
    const chip = () => document.querySelector('[aria-label$="on this block"]');
    const chipCenter = () => {
      const c = chip();
      if (!c) return null;
      c.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = c.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, chip: box(c) };
    };
    const popover = () => {
      const content = document.querySelector("[data-radix-popper-content-wrapper] > *");
      return content ? box(content) : null;
    };
    const tooltip = () => {
      const tip = document.querySelector("[data-spec-strip-tooltip]");
      return tip ? { ...box(tip), zIndex: getComputedStyle(tip).zIndex } : null;
    };
    /**
     * What is on top at a point. With probe set, an element the pointer passes
     * through, such as the tooltip, takes part for this one question.
     */
    const hits = (x, y, selector, probe = false) => {
      const target = document.querySelector(selector);
      const before = target?.style.pointerEvents;
      if (probe && target) target.style.pointerEvents = "auto";
      const hit = document.elementFromPoint(x, y);
      if (probe && target) target.style.pointerEvents = before ?? "";
      return { hit: hit ? hit.tagName.toLowerCase() + "." + (hit.getAttribute("class") ?? "").split(" ").slice(0, 3).join(".") : null, inside: !!hit && !!target && target.contains(hit) };
    };
    /** Outline rows, by the heading they name. */
    const rows = () => [...document.querySelectorAll("[data-spec-outline] > button")];
    const row = (name) => rows().find((el) => el.getAttribute("title") === name) ?? null;
    const rowCenter = (name) => {
      const r = row(name);
      if (!r) return null;
      r.scrollIntoView({ block: "nearest", behavior: "instant" });
      const rect = r.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const current = () => rows().filter((el) => el.getAttribute("aria-current") === "location").map((el) => el.getAttribute("title"));
    /**
     * A rendered heading by its text, and what stands for it on screen: itself,
     * or the fold placeholder that the folded run holding it follows.
     */
    const headingEl = (name) => [...(doc()?.querySelectorAll("h1, h2") ?? [])].find((el) => el.textContent.trim() === name) ?? null;
    const standIn = (el) => {
      const top = [...doc().querySelector(".markdown-body")?.children ?? []].find((child) => child.contains(el));
      if (!top?.classList.contains("spec-folded")) return el;
      for (let at = top.previousElementSibling; at; at = at.previousElementSibling) {
        if (at.classList.contains("spec-fold")) return at;
      }
      return null;
    };
    const folded = (name) => {
      const el = headingEl(name);
      return !!el && standIn(el) !== el;
    };
    const headingTop = (name) => {
      const el = headingEl(name);
      return el ? { top: round(el.getBoundingClientRect().top), height: round(el.getBoundingClientRect().height), usableTop: round(usable().top), scrollY: round(scrollY), end: round(end()) } : null;
    };
    /** The row the reading line says is current, worked out from the page. */
    const expectedCurrent = () => {
      const u = usable();
      const line = u.top + ${READING_LINE} * u.height;
      const atBottom = scrollY >= end() - 1;
      let pick = rows()[0]?.getAttribute("title") ?? null;
      for (const r of rows()) {
        const name = r.getAttribute("title");
        const el = headingEl(name);
        const shown = el ? standIn(el) : null;
        if (!shown) continue;
        const top = shown.getBoundingClientRect().top;
        if (top <= line || (atBottom && top < u.top + u.height)) pick = name;
      }
      return pick;
    };
    window.__specOutline = { ready, layout, ticks, band, fileCommentsShown: () => fileComments() !== null, discardFileComments, settle, restingFor, end, chipCenter, popover, tooltip, hits, rowCenter, current, expectedCurrent, folded, headingTop, stops: () => stops().length };
  })()`;
}

async function waitFor(page, what, fn, budgetMs = 30_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await evaluate(page, fn);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(80);
  }
}

const settle = (page) => evaluate(page, () => window.__specOutline.settle());

async function mouseMove(page, x, y) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

async function mouseClick(page, x, y) {
  const send = (type, extra = {}) =>
    page.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  await send("mouseMoved");
  await send("mousePressed", { button: "left", buttons: 1, clickCount: 1 });
  await send("mouseReleased", { button: "left", buttons: 0, clickCount: 1 });
}

async function pressEscape(page) {
  for (const type of ["rawKeyDown", "keyUp"])
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
}

async function openPage({
  context,
  stack,
  fixture,
  fault,
  viewport,
  fold,
  extraDrafts = [],
}) {
  const page = await context.newPage({
    viewport: { ...viewport, deviceScaleFactor: 1 },
    cookie: fixture.cookie,
    scripts: [
      setupSource(fixture, fold, extraDrafts),
      probeSource(),
      faultSource(fault),
    ].filter(Boolean),
  });
  await page.navigate(`http://127.0.0.1:${stack.webPort}${fixture.url}`);
  await waitFor(page, "the strip, the outline and a chip", () =>
    window.__specOutline?.ready(),
  );
  await evaluate(page, () => document.fonts.ready.then(() => true));
  await settle(page);
  return page;
}

/**
 * Check 0, whatever stands above the card (`when` says what): at the top of
 * the page the strip is not under the toolbar, and once the toolbar has
 * stopped the whole strip is in the window.
 */
async function checkStripInWindow(page, width, when) {
  const failures = [];
  await evaluate(page, () => window.scrollTo(0, 0));
  await settle(page);
  const atTop = await evaluate(page, () => window.__specOutline.band());
  if (atTop === null)
    return [
      failure("spec-strip-missing", `${when}: no bar or no toolbar`, width),
    ];
  if (atTop.bar.top < atTop.toolbar.bottom - EPSILON)
    failures.push(
      failure(
        "strip-under-toolbar",
        `${when}: at the top of the page the bar starts at ${atTop.bar.top}, the toolbar ends at ${atTop.toolbar.bottom}`,
        width,
      ),
    );
  // How far the page scrolls before the toolbar stops.
  await evaluate(page, () =>
    window.scrollTo(0, window.__specOutline.end() / 2),
  );
  await settle(page);
  const stuck = await evaluate(page, () => window.__specOutline.band());
  if (stuck === null)
    return [
      ...failures,
      failure(
        "spec-strip-missing",
        `${when}: mid-page, no bar or no toolbar`,
        width,
      ),
    ];
  const travel = Math.max(0, atTop.toolbar.bottom - stuck.toolbar.bottom);
  await evaluate(page, (y) => window.scrollTo(0, y), Math.ceil(travel));
  await settle(page);
  const stopped = await evaluate(page, () => window.__specOutline.band());
  if (stopped === null)
    return [
      ...failures,
      failure(
        "spec-strip-missing",
        `${when}: scrolled ${Math.ceil(travel)}px, no bar or no toolbar`,
        width,
      ),
    ];
  if (
    stopped.bar.top < stopped.toolbar.bottom - EPSILON ||
    stopped.bar.bottom > stopped.innerHeight + EPSILON
  )
    failures.push(
      failure(
        "strip-below-window",
        `${when}: scrolled ${Math.ceil(travel)}px, the bar runs ${stopped.bar.top}–${stopped.bar.bottom} under a toolbar ending at ${stopped.toolbar.bottom}, in a window ${stopped.innerHeight}px tall`,
        width,
      ),
    );
  return failures;
}

/** Checks 1–6, on an unfolded document. */
async function checkStrip(page, width) {
  const failures = [];
  const layout = await evaluate(page, () => window.__specOutline.layout());
  if (!layout.found)
    return [failure("spec-strip-missing", "no strip on the card", width)];

  // 1. Centred on the card's right border, which it replaces.
  const borderCenter = layout.card.right - layout.card.borderRight / 2;
  const stripCenter = (layout.strip.left + layout.strip.right) / 2;
  if (Math.abs(stripCenter - borderCenter) > 1)
    failures.push(
      failure(
        "strip-off-border",
        `strip centre ${stripCenter}, border centre ${borderCenter}`,
        width,
      ),
    );
  if (layout.card.borderRightColor !== "rgba(0, 0, 0, 0)")
    failures.push(
      failure(
        "card-border-shows",
        `right border ${layout.card.borderRightColor}`,
        width,
      ),
    );

  // 2. One tick per stop ↓ counts, and one for the removal alone.
  const total = Number(layout.counter.split("/")[1]);
  const stopTicks = layout.ticks.filter((tick) => tick.stop !== null);
  const delTicks = layout.ticks.filter((tick) => tick.kind === "del");
  if (!(total > 0) || stopTicks.length !== total)
    failures.push(
      failure(
        "stop-ticks-miscounted",
        `${stopTicks.length} stop ticks, counter ${layout.counter}`,
        width,
      ),
    );
  if (layout.deletions.length !== 1)
    failures.push(
      failure(
        "fixture-deletions",
        `${layout.deletions.length} deletions in the document`,
        width,
      ),
    );
  else if (
    delTicks.length !== 1 ||
    Math.abs(delTicks[0].top - layout.deletions[0]) > 1
  )
    failures.push(
      failure(
        "deletion-tick",
        `del ticks ${JSON.stringify(delTicks)}, deletion at ${layout.deletions[0]}`,
        width,
      ),
    );

  // 3. A click on stop i's tick lands where ↓ lands on stop i.
  const stripX = stripCenter;
  for (const tick of stopTicks) {
    await evaluate(page, () => window.scrollTo(0, 0));
    await settle(page);
    const fresh = (
      await evaluate(page, () => window.__specOutline.ticks())
    ).find((t) => t.stop === tick.stop);
    await mouseClick(page, stripX, fresh.center);
    const scrollY = await settle(page);
    const expected = await evaluate(
      page,
      (i) => window.__specOutline.restingFor(i),
      Number(tick.stop),
    );
    if (expected === null || Math.abs(scrollY - expected) > LANDING_SLOP)
      failures.push(
        failure(
          "stop-click-landing",
          `tick ${tick.stop}: scrollY ${scrollY}, ↓ rests at ${expected}`,
          width,
        ),
      );
  }

  // 4. The ticks hold still on the bar from the top of the page to its end.
  await evaluate(page, () => window.scrollTo(0, 0));
  await settle(page);
  const atTop = await evaluate(page, () => window.__specOutline.ticks());
  const end = await evaluate(page, () => window.__specOutline.end());
  // Stuck mid-page, the bar runs from below the toolbar to as far above the
  // window's foot, as the file rail does.
  await evaluate(page, (y) => window.scrollTo(0, y), end / 2);
  await settle(page);
  const band = await evaluate(page, () => window.__specOutline.band());
  const above = band ? band.bar.top - band.toolbar.bottom : null;
  const below = band ? band.innerHeight - band.bar.bottom : null;
  if (band === null || Math.abs(above - below) > EPSILON)
    failures.push(
      failure(
        "strip-off-band",
        band === null
          ? "no bar or no toolbar"
          : `${above}px below the toolbar, ${below}px above the window's foot`,
        width,
      ),
    );
  await evaluate(page, () => window.scrollTo(0, window.__specOutline.end()));
  const bottomY = await settle(page);
  const atEnd = await evaluate(page, () => window.__specOutline.ticks());
  if (end < 200 || bottomY < end - 1)
    failures.push(
      failure(
        "real-scroll-not-observed",
        `end ${end}, reached ${bottomY}`,
        width,
      ),
    );
  const moved = atTop
    .map((tick, i) => [tick, atEnd[i]])
    .filter(
      ([a, b]) => !b || a.kind !== b.kind || Math.abs(a.top - b.top) > EPSILON,
    );
  if (atTop.length === 0 || moved.length > 0)
    failures.push(
      failure(
        "ticks-move-on-scroll",
        `${moved.length} of ${atTop.length} ticks moved: ${JSON.stringify(moved.slice(0, 3))}`,
        width,
      ),
    );

  // 5. Over an open popover, the strip's tooltip is the one on top, and it
  // goes when the pointer leaves the strip.
  const target = await evaluate(page, () => window.__specOutline.chipCenter());
  await settle(page);
  if (!target) {
    failures.push(failure("chip-missing", "no comment chip", width));
    return failures;
  }
  const chipAt = await evaluate(page, () => window.__specOutline.chipCenter());
  // 6. The chip is the chip's, not the strip's.
  const chipHit = await evaluate(
    page,
    ({ x, y }) =>
      window.__specOutline.hits(x, y, '[aria-label$="on this block"]'),
    chipAt,
  );
  if (!chipHit.inside)
    failures.push(
      failure("chip-covered", `at the chip's centre: ${chipHit.hit}`, width),
    );
  await mouseClick(page, chipAt.x, chipAt.y);
  const popover = await waitFor(
    page,
    "the chip's popover",
    () => window.__specOutline.popover(),
    5_000,
  );
  await mouseMove(page, stripX, chipAt.y);
  const tooltip = await waitFor(
    page,
    "the strip's tooltip",
    () => window.__specOutline.tooltip(),
    5_000,
  );
  const x = Math.max(tooltip.left, popover.left) + 4;
  const y = chipAt.y;
  const inBoth =
    x < Math.min(tooltip.right, popover.right) &&
    y > Math.max(tooltip.top, popover.top) &&
    y < Math.min(tooltip.bottom, popover.bottom);
  if (!inBoth) {
    failures.push(
      failure(
        "tooltip-popover-apart",
        `tooltip ${JSON.stringify(tooltip)}, popover ${JSON.stringify(popover)}`,
        width,
      ),
    );
  } else {
    // What the pointer reaches there is what lies under the tooltip.
    const through = await evaluate(
      page,
      ({ x, y }) =>
        window.__specOutline.hits(x, y, "[data-spec-strip-tooltip]"),
      { x, y },
    );
    if (through.inside)
      failures.push(
        failure(
          "tooltip-catches-pointer",
          `at ${x},${y}: ${through.hit}`,
          width,
        ),
      );
    // The tooltip lets the pointer through, so it is asked to stop it for
    // the one question: which of the two is painted on top.
    const hit = await evaluate(
      page,
      ({ x, y }) =>
        window.__specOutline.hits(x, y, "[data-spec-strip-tooltip]", true),
      { x, y },
    );
    if (!hit.inside)
      failures.push(
        failure("tooltip-under-popover", `at ${x},${y}: ${hit.hit}`, width),
      );
  }
  await mouseMove(page, 10, chipAt.y);
  await sleep(100);
  if (await evaluate(page, () => window.__specOutline.tooltip()))
    failures.push(
      failure(
        "tooltip-stays",
        "the tooltip outlived the pointer on the strip",
        width,
      ),
    );
  await pressEscape(page);
  return failures;
}

/** Checks 7–8, on the folded document. */
async function checkOutline(page, width) {
  const failures = [];
  // 7. A folded heading picked in the outline lands under the toolbar.
  if (
    !(await evaluate(
      page,
      (name) => window.__specOutline.folded(name),
      FOLDED_HEADING,
    ))
  )
    return [
      failure("fixture-not-folded", `${FOLDED_HEADING} is not folded`, width),
    ];
  const row = await evaluate(
    page,
    (name) => window.__specOutline.rowCenter(name),
    FOLDED_HEADING,
  );
  if (!row)
    return [
      failure("outline-row-missing", `no row for ${FOLDED_HEADING}`, width),
    ];
  await mouseClick(page, row.x, row.y);
  await sleep(100);
  await settle(page);
  const landed = await evaluate(
    page,
    (name) => window.__specOutline.headingTop(name),
    FOLDED_HEADING,
  );
  if (
    !landed ||
    landed.height <= 0 ||
    Math.abs(landed.top - landed.usableTop) > LANDING_SLOP
  )
    failures.push(
      failure("folded-heading-landing", JSON.stringify(landed), width),
    );

  // 8. Down the page, the current row is the last heading past the reading line.
  const end = await evaluate(page, () => window.__specOutline.end());
  for (const share of [0, 0.25, 0.5, 0.75, 1]) {
    await evaluate(page, (y) => window.scrollTo(0, y), Math.round(end * share));
    await settle(page);
    const [current, expected] = await evaluate(page, () => [
      window.__specOutline.current(),
      window.__specOutline.expectedCurrent(),
    ]);
    if (current.length !== 1 || current[0] !== expected)
      failures.push(
        failure(
          "current-row",
          `at ${Math.round(share * 100)}%: ${JSON.stringify(current)}, reading line says ${expected}`,
          width,
        ),
      );
  }
  return failures;
}

async function runPass({ browser, stack, fixture, fault, label }) {
  const context = await browser.newContext();
  const failures = [];
  const measurements = [];
  let injected = 0;
  try {
    for (const viewport of VIEWPORTS) {
      for (const fold of [false, true]) {
        // The unfolded page opens with file comments above the card, and
        // goes on without them.
        const page = await openPage({
          context,
          stack,
          fixture,
          fault,
          viewport,
          fold,
          extraDrafts: fold
            ? []
            : fileDrafts(PATH, fixture.drafts[0].anchor.version, 3),
        });
        try {
          const found = [];
          if (fold) found.push(...(await checkOutline(page, viewport.width)));
          else {
            found.push(
              ...(await checkStripInWindow(
                page,
                viewport.width,
                "file comments",
              )),
            );
            const discarded = await evaluate(page, () =>
              window.__specOutline.discardFileComments(),
            );
            if (discarded !== 3)
              found.push(
                failure(
                  "fixture-file-comments",
                  `discarded ${discarded} file comments, not 3`,
                  viewport.width,
                ),
              );
            await waitFor(
              page,
              "the File comments box to go",
              () => !window.__specOutline.fileCommentsShown(),
              5_000,
            );
            found.push(
              ...(await checkStripInWindow(
                page,
                viewport.width,
                "file comments gone",
              )),
              ...(await checkStrip(page, viewport.width)),
            );
          }
          failures.push(...found);
          if (FAULT_CSS[fault])
            injected += (await evaluate(
              page,
              () => !!document.querySelector("style[data-spec-outline-fault]"),
            ))
              ? 1
              : 0;
          else if (fault)
            injected += await evaluate(
              page,
              () => window.__specOutlineFault ?? 0,
            );
          measurements.push({
            width: viewport.width,
            fold,
            failures: found.map((item) => item.name),
          });
          if (found.length) {
            const shot = await page.send("Page.captureScreenshot", {
              format: "png",
              captureBeyondViewport: false,
            });
            writeFileSync(
              join(
                stack.dir,
                `spec-outline-strip-${label}-${viewport.width}-${fold ? "fold" : "open"}.png`,
              ),
              Buffer.from(shot.data, "base64"),
            );
          }
        } finally {
          await page.close();
        }
      }
    }
    const result = {
      name: `spec-outline-strip:${label}`,
      fixture: { slug: fixture.slug, number: fixture.number },
      injectionConfirmed: fault ? injected > 0 : undefined,
      failures,
      measurements,
    };
    if (failures.length)
      writeFileSync(
        join(stack.dir, `spec-outline-strip-${label}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    return result;
  } finally {
    await context.close();
  }
}

export async function runSpecOutlineStrip(options) {
  const fixture = await seedSpecOutlineFixture(options.stack.serverPort);
  if (!options.selfTest) {
    return {
      name: "spec-outline-strip",
      passes: [
        await runPass({ ...options, fixture, fault: null, label: "clean" }),
      ],
    };
  }
  const baseline = await runPass({
    ...options,
    fixture,
    fault: null,
    label: "baseline",
  });
  const faults = [];
  for (const fault of Object.keys(FAULTS)) {
    faults.push(await runPass({ ...options, fixture, fault, label: fault }));
  }
  const restored = await runPass({
    ...options,
    fixture,
    fault: null,
    label: "restored",
  });
  const problems = [
    baseline.failures.length &&
      `baseline not clean: ${baseline.failures.map((item) => `${item.name}:${item.width ?? "all"}`).join(", ")}`,
    ...Object.entries(FAULTS).flatMap(([fault, expected], i) => {
      const pass = faults[i];
      return [
        !pass.injectionConfirmed && `${fault} did not take effect`,
        !VIEWPORTS.every(({ width }) =>
          pass.failures.some(
            (item) => item.name === expected && item.width === width,
          ),
        ) && `${fault} was not reported as ${expected} at every width`,
      ];
    }),
    restored.failures.length &&
      `restored not clean: ${restored.failures.map((item) => `${item.name}:${item.width ?? "all"}`).join(", ")}`,
  ].filter(Boolean);
  return {
    name: "spec-outline-strip",
    passes: [baseline, ...faults, restored],
    failures: problems.length
      ? [failure("fault-injection-not-confirmed", problems.join("; "))]
      : [],
  };
}
