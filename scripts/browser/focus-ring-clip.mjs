import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { evaluate } from "../lib/browser-cdp.mjs";

const EPSILON = 0.5;
const READY_MS = 30_000;
const PROJECT_NAME = "Focus ring clipping";
const NOTES_LINK = "notes first link";
const LONG_LINK = "long first link";
const SEGMENT =
  "div.inline-flex.overflow-hidden.rounded-md.border > :is(a, button)";
const SIDEBAR_FAULT =
  "aside:has([data-sidebar-section]) { margin: 0 !important; padding: 0 !important; }";
const COVERAGE = new Set([
  "focus-ring-target-missing",
  "focus-ring-root-missing",
  "focus-ring-scroll-not-observed",
  "focus-ring-sidebar-scrolls",
  "fault-injection-not-confirmed",
]);

function failure(name, detail, row) {
  return { name, detail, ...(row === undefined ? {} : { row }) };
}

async function seedFixture(serverPort) {
  const base = `http://127.0.0.1:${serverPort}/api`;
  let cookie = "";
  const call = async (method, path, body) => {
    const form = body instanceof FormData;
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(form ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined || form ? body : JSON.stringify(body),
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
  const viewer = await call("GET", "/me");
  const slug = `layout-ring-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const project = `/projects/${slug}`;
  await call("POST", "/projects", {
    slug,
    name: PROJECT_NAME,
    description: "",
  });
  const statuses = await call("GET", `${project}/statuses`);
  const todo = statuses.find((status) => status.name === "Todo");
  if (!todo) throw new Error("canonical Todo status is missing");
  const card = (title) =>
    call("POST", `${project}/issues`, { title, body: "", status_id: todo.id });
  const upload = (number, filename, text) => {
    const form = new FormData();
    form.set("file", new File([text], filename, { type: "text/markdown" }));
    form.set("issue_number", String(number));
    return call("POST", `${project}/attachments`, form);
  };
  const label = await call("POST", `${project}/labels`, {
    name: "area:web",
    color: "#3b82f6",
  });
  const agent = await call("POST", "/agents", {
    login: `ring-agent-${randomUUID().slice(0, 6)}`,
    display_name: "Ring Agent",
  });
  await call("PUT", `${project}/members/${agent.id}`, { role: "writer" });

  // Every sidebar section is filled, but the twenty spec files live on their
  // own card: the sidebar lists the latest spec's files and would outgrow a
  // 900px viewport, leaving no sidebar that rests without scrolling.
  const sidebar = await card("Every sidebar section filled");
  const specCard = await card("Twenty spec files");
  const blocker = await card("Blocker card");
  const blocked = await card("Blocked card");
  // Enough cards in one column that the board column has to scroll.
  for (let index = 1; index <= 24; index += 1)
    await card(`Filler card ${String(index).padStart(2, "0")}`);

  const issue = `${project}/issues/${sidebar.number}`;
  await call("PATCH", issue, {
    label_ids: [label.id],
    assignee_ids: [viewer.id],
  });
  await call("POST", `${issue}/blocked-by`, { ref: `#${blocker.number}` });
  await call("POST", `${issue}/blocks`, { ref: `#${blocked.number}` });
  await call("PATCH", `${issue}/metadata`, {
    entries: [{ namespace: "ci", key: "run", value: "42" }],
  });
  await call("POST", `${issue}/spec/push`, {
    files: [{ path: "plan.md", body: "# Plan\n\nText.\n" }],
    message: "v1",
  });
  await upload(
    sidebar.number,
    "notes.md",
    `[${NOTES_LINK}](https://example.com/notes) opens the notes.\n\nA second paragraph.\n`,
  );
  const long = await upload(
    sidebar.number,
    "long.md",
    `[${LONG_LINK}](https://example.com/long) heads a long document.\n\n${Array.from(
      { length: 40 },
      (_, index) =>
        `Paragraph ${index + 1} is filler that keeps the document long.`,
    ).join("\n\n")}\n`,
  );
  const patch = ["x", "y", "z"]
    .map(
      (name) =>
        `--- a/${name}.ts\n+++ b/${name}.ts\n@@ -1 +1 @@\n-const ${name} = 1;\n+const ${name} = 2;`,
    )
    .join("\n");
  await call("POST", `${issue}/comments`, {
    body: `\`\`\`diff\n${patch}\n\`\`\`\n`,
  });
  await call("POST", `${issue}/comments`, { body: `![](${long.url})` });
  const asked = await call("POST", `${issue}/comments`, {
    body: "One question.",
    component: {
      type: "questions",
      questions: [
        {
          question: "Keep the ring?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    },
  });
  await call("POST", `${issue}/comments/${asked.id}/answers`, {
    answers: [{ key: "q1", selected: [0] }],
  });
  // A comment after the answer keeps that event a row of its own.
  await call("POST", `${issue}/comments`, { body: "The answer stands." });

  // v2 changes one file of twenty, so the source compare folds nineteen.
  const spec = `${project}/issues/${specCard.number}/spec`;
  const files = Array.from({ length: 20 }, (_, index) => ({
    path: `docs/part-${String(index).padStart(2, "0")}.md`,
    body: `# Part ${index}\n\nLine three.\n\nLine five.\n`,
  }));
  await call("POST", `${spec}/push`, { files, message: "v1" });
  files[0] = { ...files[0], body: `${files[0].body}\nAdded in v2.\n` };
  await call("POST", `${spec}/push`, { files, message: "v2" });
  await call("POST", `${spec}/reviews`, {
    version: 2,
    verdict: "comment",
    comments: [
      {
        anchor: { path: files[0].path, version: 2, line_start: 3, line_end: 3 },
        body: "An annotation on one line.",
      },
    ],
  });
  return {
    slug,
    cookie,
    login: viewer.login,
    sidebar: sidebar.number,
    spec: specCard.number,
  };
}

/** Each page state the walk visits; `must` names controls it has to reach. */
function rowsFor(fixture) {
  const project = `/projects/${fixture.slug}`;
  const sidebarCard = `${project}/issues/${fixture.sidebar}`;
  const specCard = `${project}/issues/${fixture.spec}`;
  const sidebar = [
    { label: "Notifying", selector: "aside button", text: "Notifying" },
    {
      label: "Edit labels",
      selector: 'aside button[aria-label="Edit labels"]',
    },
    {
      label: "More actions",
      selector: 'aside button[aria-label="More actions"]',
    },
  ];
  const segments = (labels) =>
    labels.map((text) => ({ label: text, selector: SEGMENT, text }));
  return [
    {
      id: "1",
      path: sidebarCard,
      width: 1440,
      height: 900,
      must: [
        ...sidebar,
        { label: "header List", selector: "header a", text: "List" },
        {
          label: "answered 1 question",
          selector: "a",
          text: "answered 1 question",
        },
        {
          label: "Show full document",
          selector: "button",
          text: "Show full document",
        },
      ],
      still: "Notifying",
    },
    {
      id: "2",
      path: sidebarCard,
      width: 1280,
      height: 520,
      must: sidebar,
      scrolls: "Notifying",
    },
    {
      id: "3",
      path: sidebarCard,
      width: 1280,
      height: 900,
      open: { selector: "button", text: "3 files", via: "Enter" },
      must: [
        { label: "first file row", selector: "li > button", pick: "first" },
        { label: "last file row", selector: "li > button", pick: "last" },
      ],
    },
    {
      id: "4",
      path: sidebarCard,
      width: 1280,
      height: 900,
      open: { selector: "aside a", text: "notes.md", via: "Enter" },
      must: [{ label: "notes link", selector: "a", text: NOTES_LINK }],
    },
    {
      id: "5",
      path: sidebarCard,
      width: 1280,
      height: 900,
      open: { selector: "button", text: "Show full document", via: "click" },
      must: [{ label: "document link", selector: "a", text: LONG_LINK }],
    },
    {
      id: "6",
      path: `${specCard}/spec`,
      width: 1280,
      height: 520,
      must: [
        {
          label: "first rail file",
          selector: "aside:has(+ main) a[href]",
          pick: "first",
        },
        {
          label: "last rail file",
          selector: "aside:has(+ main) a[href]",
          pick: "last",
        },
      ],
      scrolls: "first rail file",
    },
    {
      id: "7",
      path: `${specCard}/spec?compare=1&view=source`,
      width: 1280,
      height: 900,
      must: [
        {
          label: "unchanged file toggle",
          selector: "button[aria-expanded]",
          text: "show file",
        },
      ],
    },
    {
      id: "8",
      path: specCard,
      width: 1280,
      height: 900,
      must: [
        {
          label: "annotation context",
          selector: 'button[title="expand surrounding context"]',
        },
      ],
    },
    {
      id: "9",
      path: `${project}/board`,
      width: 1280,
      height: 600,
      must: [
        {
          label: "last Todo card",
          selector: '[data-testid="column-Todo"] [data-return-id]',
          pick: "last",
        },
        { label: "card meta button", selector: "[data-card-meta] button" },
      ],
      scrolls: "last Todo card",
    },
    {
      id: "10",
      path: project,
      width: 1280,
      height: 900,
      must: segments(["Open", "Closed", "All"]),
    },
    {
      id: "11",
      path: `${project}/settings`,
      width: 700,
      height: 900,
      must: [
        {
          label: "first settings tab",
          selector: '[class~="@container"] nav a',
          pick: "first",
        },
        {
          label: "last settings tab",
          selector: '[class~="@container"] nav a',
          pick: "last",
        },
      ],
    },
    {
      id: "12a",
      path: "/settings/agents",
      width: 1280,
      height: 900,
      must: segments(["Active", "Deactivated"]),
    },
    {
      id: "12b",
      path: "/settings/tokens",
      width: 1280,
      height: 900,
      must: segments(["User", "Agents", "All"]),
    },
    {
      id: "13",
      path: `/users/${fixture.login}`,
      width: 700,
      height: 900,
      must: [
        {
          label: "project row",
          selector: "ul.overflow-hidden a",
          text: PROJECT_NAME,
        },
        {
          label: "calendar day",
          selector: '[data-activity-scroll] button[tabindex="0"]',
        },
      ],
    },
    {
      id: "14",
      path: `${project}/search?q=Filler`,
      width: 1280,
      height: 900,
      must: [
        {
          label: "first group title",
          selector: "ul.space-y-4 > li > a",
          pick: "first",
        },
        {
          label: "last group last row",
          selector: "ul.space-y-4 > li:last-child a",
          pick: "last",
        },
      ],
    },
  ];
}

/**
 * Installed before the app loads. Measures a focused control's ring from its
 * computed style and compares it with the padding box of every ancestor that
 * clips it; with `fault`, strips the issue sidebar's allowance first.
 */
function installProbe(fault, faultCss, epsilon) {
  const FOCUSABLE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';
  const round = (value) => Number(value.toFixed(2));
  const shown = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      element.getClientRects().length > 0 &&
      style.visibility !== "hidden" &&
      // sr-only controls are clipped to nothing; no ring of theirs is seen.
      style.clip === "auto" &&
      rect.width > 1 &&
      rect.height > 1
    );
  };
  const tabbable = (element) =>
    !element.disabled &&
    element.tabIndex >= 0 &&
    !element.closest('[inert], [aria-hidden="true"]') &&
    shown(element);
  const text = (element) =>
    (element.getAttribute("aria-label") || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  const describe = (element) => ({
    tag: element.tagName.toLowerCase(),
    text: text(element).slice(0, 60),
    className: (element.getAttribute("class") || "").slice(0, 200),
  });
  const transparent = (color) =>
    color === "transparent" ||
    /rgba\([^)]*,\s*0\)$/.test(color) ||
    /\/\s*0\)$/.test(color);
  // The reach of the focus indicator beyond the border box: the widest
  // outward shadow, or the outline's width plus its (possibly negative)
  // offset, whichever is larger.
  const ring = (element) => {
    const style = getComputedStyle(element);
    let reach = Number.NEGATIVE_INFINITY;
    let drawn = false;
    if (style.boxShadow !== "none") {
      for (const part of style.boxShadow.split(/,(?![^(]*\))/)) {
        if (/\binset\b/.test(part)) continue;
        const color =
          part.match(/[a-z-]+\([^)]*\)|#[0-9a-f]+|\btransparent\b/i)?.[0] ?? "";
        if (transparent(color)) continue;
        const [x = 0, y = 0, blur = 0, spread = 0] = [
          ...part.replace(color, "").matchAll(/(-?[\d.]+)px/g),
        ].map((match) => Number(match[1]));
        if (blur <= 0 && spread <= 0 && x === 0 && y === 0) continue;
        drawn = true;
        reach = Math.max(
          reach,
          Math.max(Math.abs(x), Math.abs(y)) + blur + spread,
        );
      }
    }
    const outline = Number.parseFloat(style.outlineWidth) || 0;
    if (style.outlineStyle !== "none" && outline > 0) {
      drawn = true;
      reach = Math.max(
        reach,
        outline + (Number.parseFloat(style.outlineOffset) || 0),
      );
    }
    return { drawn, reach: drawn ? round(reach) : 0 };
  };
  const scrolls = (value) => value === "auto" || value === "scroll";
  const clips = (value) => value !== "visible";
  // Ancestors that can hold an absolutely or fixed positioned descendant.
  const holdsFixed = (style) =>
    style.transform !== "none" ||
    style.perspective !== "none" ||
    style.filter !== "none" ||
    style.backdropFilter !== "none" ||
    /paint|layout|strict|content/.test(style.contain) ||
    /transform|perspective|filter/.test(style.willChange) ||
    (style.containerType !== "normal" && style.containerType !== "");
  // Every ancestor whose overflow clips this element: an out-of-flow box
  // escapes the ancestors between it and its containing block.
  const clippers = (element) => {
    const found = [];
    let position = getComputedStyle(element).position;
    for (
      let ancestor = element.parentElement;
      ancestor && ancestor !== document.body;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor);
      const contains =
        position === "fixed"
          ? holdsFixed(style)
          : position === "absolute"
            ? style.position !== "static" || holdsFixed(style)
            : true;
      if (!contains) continue;
      position = style.position;
      if (clips(style.overflowX) || clips(style.overflowY))
        found.push({ ancestor, style });
    }
    return found;
  };
  const measure = (element) => {
    const { drawn, reach } = ring(element);
    const box = element.getBoundingClientRect();
    const cut = [];
    const hidden = [];
    for (const { ancestor, style } of clippers(element)) {
      const rect = ancestor.getBoundingClientRect();
      const margin =
        style.overflowX === "clip" || style.overflowY === "clip"
          ? Math.max(
              0,
              Number.parseFloat(
                style.overflowClipMargin.match(/-?[\d.]+px/g)?.at(-1) ?? "0",
              ),
            )
          : 0;
      const left = rect.left + ancestor.clientLeft;
      const top = rect.top + ancestor.clientTop;
      const edges = {
        left: left - (style.overflowX === "clip" ? margin : 0),
        right:
          left +
          ancestor.clientWidth +
          (style.overflowX === "clip" ? margin : 0),
        top: top - (style.overflowY === "clip" ? margin : 0),
        bottom:
          top +
          ancestor.clientHeight +
          (style.overflowY === "clip" ? margin : 0),
      };
      // Wholly outside is scrolled away, not clipped.
      if (
        box.right <= edges.left ||
        box.left >= edges.right ||
        box.bottom <= edges.top ||
        box.top >= edges.bottom
      )
        continue;
      // How far each side of the box itself lies past the clip edge.
      const past = {};
      if (clips(style.overflowX)) {
        past.left = edges.left - box.left;
        past.right = box.right - edges.right;
      }
      if (clips(style.overflowY)) {
        past.top = edges.top - box.top;
        past.bottom = box.bottom - edges.bottom;
      }
      // A control partly out of view is where focus scrolling left it (a
      // wide control may stay partly hidden in Chromium), not a ring that
      // has no room: noted, and not measured against this ancestor.
      const out = Object.entries(past).filter(([, amount]) => amount > epsilon);
      if (out.length) {
        hidden.push({
          sides: Object.fromEntries(
            out.map(([side, amount]) => [side, round(amount)]),
          ),
          clipper: describe(ancestor),
        });
        continue;
      }
      for (const [side, amount] of Object.entries(past)) {
        if (amount + reach > epsilon)
          cut.push({
            side,
            by: round(amount + reach),
            clipper: describe(ancestor),
          });
      }
    }
    return {
      ...describe(element),
      must: element.dataset.focusRingMust ?? null,
      focusVisible: element.matches(":focus-visible"),
      drawn,
      reach,
      box: {
        left: round(box.left),
        top: round(box.top),
        right: round(box.right),
        bottom: round(box.bottom),
      },
      cut,
      hidden,
    };
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  let items = [];
  let region = null;
  let regionTop = 0;
  const probe = {
    /** Every control a descriptor names, as the pick narrows it. */
    find(descriptor, rootSelector) {
      const root = rootSelector
        ? document.querySelector(rootSelector)
        : document.body;
      if (!root) return [];
      const matches = [...root.querySelectorAll(descriptor.selector)].filter(
        (element) =>
          shown(element) &&
          (!descriptor.text || text(element).includes(descriptor.text)),
      );
      if (descriptor.pick === "last") return matches.slice(-1);
      if (descriptor.pick === "all") return matches;
      return matches.slice(0, 1);
    },
    mark(descriptors, rootSelector) {
      const missing = [];
      for (const descriptor of descriptors) {
        const [element] = probe.find(descriptor, rootSelector);
        if (element) element.dataset.focusRingMust = descriptor.label;
        else missing.push(descriptor.label);
      }
      return missing;
    },
    /** Remember the scroll container around a marked control. */
    watch(label) {
      const marked = document.querySelector(
        `[data-focus-ring-must="${CSS.escape(label)}"]`,
      );
      region = null;
      for (let node = marked?.parentElement; node; node = node.parentElement) {
        if (scrolls(getComputedStyle(node).overflowY)) {
          region = node;
          break;
        }
      }
      regionTop = region?.scrollTop ?? 0;
      return region
        ? {
            ...describe(region),
            scrollHeight: region.scrollHeight,
            clientHeight: region.clientHeight,
          }
        : null;
    },
    regionTop: () => regionTop,
    /** Open the overlay a row walks, then name it as the walk's root. */
    root() {
      const roots = [
        ...document.querySelectorAll(
          '[role="dialog"], [data-slot="popover-content"]',
        ),
      ].filter(shown);
      const root = roots.at(-1);
      if (!root) return null;
      root.dataset.focusRingRoot = "";
      return "[data-focus-ring-root]";
    },
    list(rootSelector) {
      const root = rootSelector
        ? document.querySelector(rootSelector)
        : document.body;
      items = root
        ? [...root.querySelectorAll(FOCUSABLE)].filter(tabbable)
        : [];
      return items.length;
    },
    async check(index) {
      const element = items[index];
      if (!element?.isConnected || !tabbable(element)) return null;
      element.focus({ focusVisible: true });
      if (document.activeElement !== element)
        return {
          ...describe(element),
          must: element.dataset.focusRingMust ?? null,
          skipped: "not focused",
        };
      // The ring of a `transition-all` control grows in over ~150ms; reading
      // it before the transition ends measures a fraction of a pixel.
      const running = element
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().endTime !==
            Number.POSITIVE_INFINITY,
        );
      await Promise.race([
        Promise.all(
          running.map((animation) => animation.finished.catch(() => {})),
        ),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      await frame();
      await frame();
      if (region) regionTop = Math.max(regionTop, region.scrollTop);
      return measure(element);
    },
    faulted() {
      const aside = document
        .querySelector("[data-sidebar-section]")
        ?.closest("aside");
      if (!aside || !document.querySelector("style[data-focus-ring-fault]"))
        return false;
      const style = getComputedStyle(aside);
      return [
        style.paddingLeft,
        style.paddingRight,
        style.paddingBottom,
        style.marginLeft,
        style.marginRight,
      ].every((value) => value === "0px");
    },
  };
  window.__focusRingClip = probe;
  if (fault) {
    const inject = () => {
      if (
        !document.head ||
        document.querySelector("style[data-focus-ring-fault]")
      )
        return;
      const style = document.createElement("style");
      style.dataset.focusRingFault = "remove-sidebar-allowance";
      style.textContent = faultCss;
      document.head.append(style);
    };
    new MutationObserver(inject).observe(document, {
      childList: true,
      subtree: true,
    });
    inject();
  }
}

async function waitFor(page, fn, ...args) {
  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline) {
    if (await evaluate(page, fn, ...args).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}

async function press(page, key, code, keyCode, text) {
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
  });
}

/** Open the row's overlay by Enter on its trigger, or by a click. */
async function openOverlay(page, open) {
  const ready = await waitFor(
    page,
    (descriptor) => window.__focusRingClip.find(descriptor).length > 0,
    open,
  );
  if (!ready) return null;
  const done = await evaluate(
    page,
    (descriptor, click) => {
      const [element] = window.__focusRingClip.find(descriptor);
      if (!element) return false;
      if (click) element.click();
      else element.focus({ focusVisible: true });
      return click || document.activeElement === element;
    },
    open,
    open.via === "click",
  );
  if (!done) return null;
  if (open.via === "Enter") await press(page, "Enter", "Enter", 13, "\r");
  let root = null;
  const deadline = Date.now() + READY_MS;
  while (!root && Date.now() < deadline) {
    root = await evaluate(page, () => window.__focusRingClip.root());
    if (!root) await sleep(150);
  }
  if (root) await sleep(400);
  return root;
}

async function walkRow({ context, stack, fixture, fault, row }) {
  const failures = [];
  const page = await context.newPage({
    viewport: {
      width: row.width,
      height: row.height,
      deviceScaleFactor: 1,
      mobile: false,
    },
    cookie: fixture.cookie,
    scripts: [
      `(${installProbe.toString()})(${JSON.stringify(fault)}, ${JSON.stringify(SIDEBAR_FAULT)}, ${EPSILON})`,
    ],
  });
  const result = {
    id: row.id,
    path: row.path,
    viewport: `${row.width}x${row.height}`,
  };
  try {
    await page.navigate(`http://127.0.0.1:${stack.webPort}${row.path}`);
    await waitFor(
      page,
      () => !!window.__focusRingClip && document.readyState === "complete",
    );
    let rootSelector = null;
    if (row.open) {
      rootSelector = await openOverlay(page, row.open);
      if (!rootSelector) {
        failures.push(
          failure(
            "focus-ring-root-missing",
            `could not open the overlay from ${JSON.stringify(row.open)}`,
            row.id,
          ),
        );
        return { ...result, failures };
      }
    }
    await waitFor(
      page,
      (descriptors, root) =>
        descriptors.every(
          (descriptor) => window.__focusRingClip.find(descriptor, root).length,
        ),
      row.must,
      rootSelector,
    );
    await evaluate(page, () => document.fonts.ready.then(() => true));
    await sleep(500);
    const missing = await evaluate(
      page,
      (descriptors, root) => window.__focusRingClip.mark(descriptors, root),
      row.must,
      rootSelector,
    );
    for (const label of missing)
      failures.push(
        failure("focus-ring-target-missing", `${label} did not render`, row.id),
      );
    const watched = row.still ?? row.scrolls;
    if (watched) {
      result.region = await evaluate(
        page,
        (label) => window.__focusRingClip.watch(label),
        watched,
      );
      if (!result.region)
        failures.push(
          failure(
            "focus-ring-scroll-not-observed",
            `no scroll container around ${watched}`,
            row.id,
          ),
        );
      else if (
        row.still &&
        result.region.scrollHeight > result.region.clientHeight
      )
        failures.push(
          failure(
            "focus-ring-sidebar-scrolls",
            `the container around ${watched} scrolls (${result.region.scrollHeight} > ${result.region.clientHeight}); its resting bottom edge goes unmeasured`,
            row.id,
          ),
        );
    }
    if (fault)
      result.faulted = await evaluate(page, () =>
        window.__focusRingClip.faulted(),
      );
    // A keystroke puts the page in keyboard modality, so focus() draws the
    // ring a Tab would.
    await press(page, "Shift", "ShiftLeft", 16);
    const count = await evaluate(
      page,
      (root) => window.__focusRingClip.list(root),
      rootSelector,
    );
    const controls = [];
    for (let index = 0; index < count; index += 1) {
      const control = await evaluate(
        page,
        (at) => window.__focusRingClip.check(at),
        index,
      );
      if (control) controls.push(control);
    }
    result.controls = controls;
    for (const control of controls) {
      for (const cut of control.cut ?? [])
        failures.push(
          failure(
            "focus-ring-clipped",
            `${control.tag} "${control.text}" ring (${control.reach}px) cut ${cut.by}px on the ${cut.side} by ${cut.clipper.tag}.${cut.clipper.className}`,
            row.id,
          ),
        );
    }
    for (const descriptor of row.must) {
      if (missing.includes(descriptor.label)) continue;
      const reached = controls.find(
        (control) => control.must === descriptor.label,
      );
      if (!reached?.focusVisible || !reached.drawn)
        failures.push(
          failure(
            "focus-ring-target-missing",
            `${descriptor.label}: ${reached ? `focusVisible=${reached.focusVisible} drawn=${reached.drawn}${reached.skipped ? ` (${reached.skipped})` : ""}` : "never focused"}`,
            row.id,
          ),
        );
    }
    if (row.scrolls && result.region) {
      result.regionTop = await evaluate(page, () =>
        window.__focusRingClip.regionTop(),
      );
      if (!(result.regionTop > 0))
        failures.push(
          failure(
            "focus-ring-scroll-not-observed",
            `the container around ${row.scrolls} never scrolled during the walk`,
            row.id,
          ),
        );
    }
    if (failures.length) {
      const shot = await page.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      result.screenshot = `focus-ring-clip-${fault ? "fault" : "clean"}-row-${row.id}.png`;
      writeFileSync(
        join(stack.dir, result.screenshot),
        Buffer.from(shot.data, "base64"),
      );
    }
    return { ...result, failures };
  } finally {
    await page.close();
  }
}

async function runPass({ browser, stack, fixture, fault, label, rows }) {
  const context = await browser.newContext();
  try {
    const walked = [];
    for (const row of rows) {
      walked.push(await walkRow({ context, stack, fixture, fault, row }));
    }
    const failures = walked.flatMap((row) => row.failures);
    const mutationConfirmed = fault
      ? walked.every((row) => row.faulted === true)
      : undefined;
    if (fault && !mutationConfirmed)
      failures.push(
        failure(
          "fault-injection-not-confirmed",
          "the sidebar kept a margin or padding under the injected style",
        ),
      );
    const result = {
      name: `focus-ring-clip:${label}`,
      fixture: { slug: fixture.slug },
      mutationConfirmed,
      failures,
      rows: walked,
    };
    if (failures.length)
      writeFileSync(
        join(stack.dir, `focus-ring-clip-${label}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    return result;
  } finally {
    await context.close();
  }
}

export async function runFocusRingClip(options) {
  const fixture = await seedFixture(options.stack.serverPort);
  const rows = rowsFor(fixture);
  if (!options.selfTest) {
    return {
      name: "focus-ring-clip",
      passes: [
        await runPass({
          ...options,
          fixture,
          fault: false,
          label: "clean",
          rows,
        }),
      ],
    };
  }
  // The fault only touches the issue sidebar, so the fault and restored
  // passes walk that one row; the baseline walks every row.
  const sidebarRow = rows.filter((row) => row.id === "1");
  const baseline = await runPass({
    ...options,
    fixture,
    fault: false,
    label: "baseline",
    rows,
  });
  const fault = await runPass({
    ...options,
    fixture,
    fault: true,
    label: "fault",
    rows: sidebarRow,
  });
  const restored = await runPass({
    ...options,
    fixture,
    fault: false,
    label: "restored",
    rows: sidebarRow,
  });
  const coverage = (pass) =>
    pass.failures.some((item) => COVERAGE.has(item.name));
  const notifying = (side) =>
    fault.failures.some(
      (item) =>
        item.name === "focus-ring-clipped" &&
        item.detail.includes('"Notifying"') &&
        item.detail.includes(`on the ${side} by aside`),
    );
  const failures = [];
  if (baseline.failures.length)
    failures.push(
      failure(
        "self-test-baseline-not-clean",
        `pre-existing failures cannot prove the injected fault: ${baseline.failures.map((item) => item.name).join(", ")}`,
      ),
    );
  if (coverage(baseline))
    failures.push(
      failure(
        "self-test-baseline-coverage",
        "baseline lacked a required control, overlay or scroll",
      ),
    );
  if (coverage(fault))
    failures.push(
      failure(
        "self-test-fault-coverage",
        "fault pass lacked a required control, overlay or scroll",
      ),
    );
  if (coverage(restored))
    failures.push(
      failure(
        "self-test-restoration-coverage",
        "restored pass lacked a required control, overlay or scroll",
      ),
    );
  if (!fault.mutationConfirmed)
    failures.push(
      failure("self-test-injection", "fault mutation was not confirmed"),
    );
  if (!notifying("left") || !notifying("right"))
    failures.push(
      failure(
        "self-test-new-targeted-failure",
        "removing the sidebar allowance did not clip Notifying on both sides",
      ),
    );
  if (restored.failures.length)
    failures.push(
      failure(
        "self-test-fresh-restoration",
        `fresh clean rerun failed: ${restored.failures.map((item) => item.name).join(", ")}`,
      ),
    );
  return {
    name: "focus-ring-clip",
    passes: [baseline, fault, restored],
    failures,
  };
}
