import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { evaluate } from "../lib/browser-cdp.mjs";

// Below 640px (Tailwind `sm`) the rendered spec gives up its right gutter and
// the annotation chips ride on the card's border; from 640px up the gutter,
// the chips in it and the popover opening to their left stay as they were.
const VIEWPORTS = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 639, height: 844 },
  { width: 640, height: 800 },
  { width: 1280, height: 800 },
];
const SM = 640;
const GUTTER = 40;
const EPSILON = 0.5;
const CHIPS = 2;
const PATH = "design.md";
const FAULT_CSS =
  '[aria-label$="on this block"] { right: 0 !important; translate: none !important; }';

const narrow = (width) => width < SM;

function failure(name, detail, width) {
  return { name, detail, ...(width ? { width } : {}) };
}

function documentBody() {
  return [
    "# Annotation gutter fixture",
    "",
    "The rendered spec view keeps this paragraph long enough to wrap across several lines on the narrowest phone screen, so that the right edge of its text shows where the column really ends rather than where one short line happens to stop.",
    "",
    "A second annotated paragraph puts another chip at a different height, and like the first it runs on well past a single line, so that its right edge is also set by the width of the column it sits in.",
    "",
  ].join("\n");
}

/** One project, one card, one spec file with two annotated paragraphs. */
export async function seedSpecChipFixture(serverPort) {
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
  const slug = `spec-gutter-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  await call("POST", "/projects", {
    slug,
    name: `Spec chip gutter ${slug}`,
    description: "",
  });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Rendered spec with two annotated paragraphs",
    body: "",
  });
  const spec = `/projects/${slug}/issues/${issue.number}/spec`;
  const body = documentBody();
  const pushed = await call("POST", `${spec}/push`, {
    files: [{ path: PATH, body }],
    message: "Gutter fixture",
  });
  const lines = body.split("\n");
  const paragraphs = lines.flatMap((line, i) =>
    line.length > 80 ? [i + 1] : [],
  );
  if (paragraphs.length !== CHIPS)
    throw new Error(`fixture has ${paragraphs.length} long paragraphs`);
  await call("POST", `${spec}/reviews`, {
    version: pushed.version,
    verdict: "comment",
    comments: paragraphs.map((line, i) => ({
      anchor: {
        path: PATH,
        version: pushed.version,
        line_start: line,
        line_end: line,
      },
      body: `Annotation ${i + 1} on the gutter fixture.`,
    })),
  });
  return {
    slug,
    number: issue.number,
    cookie,
    url: `/projects/${slug}/issues/${issue.number}/spec?file=${PATH}`,
  };
}

function probeSource(fault) {
  return `(() => {
    const fault = ${JSON.stringify(fault)};
    const round = value => Number.isFinite(value) ? Number(value.toFixed(3)) : null;
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { left: round(rect.left), right: round(rect.right), top: round(rect.top), bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height) };
    };
    const parts = () => {
      const container = document.querySelector('[data-testid="annotated-markdown"]');
      return {
        container,
        card: container?.parentElement ?? null,
        body: container?.querySelector('.markdown-body') ?? null,
        chips: container ? [...container.querySelectorAll('[aria-label$="on this block"]')] : [],
      };
    };
    const sized = element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const ready = () => {
      const { container, body, chips } = parts();
      return !!container && !!body && chips.length === ${CHIPS} && [container, body, ...chips].every(sized);
    };
    const measure = () => {
      const { container, card, body, chips } = parts();
      if (!container) return { found: false };
      const cardStyle = card ? getComputedStyle(card) : null;
      return {
        found: true,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        card: card ? {
          ...box(card),
          borderRight: Number.parseFloat(cardStyle.borderRightWidth) || 0,
          inner: round(card.getBoundingClientRect().right - (Number.parseFloat(cardStyle.borderRightWidth) || 0) - (Number.parseFloat(cardStyle.paddingRight) || 0)),
        } : null,
        body: body ? box(body) : null,
        chips: chips.map(chip => {
          const style = getComputedStyle(chip);
          return { label: chip.getAttribute('aria-label'), ...box(chip), css: { right: style.right, translate: style.translate } };
        }),
        faultMarker: !!document.querySelector('style[data-spec-chip-gutter-fault]'),
      };
    };
    const chipCenter = index => {
      const chip = parts().chips[index];
      if (!chip) return null;
      chip.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = chip.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, chip: box(chip) };
    };
    const popover = () => {
      const content = document.querySelector('[data-radix-popper-content-wrapper] > *');
      return content && sized(content) ? box(content) : null;
    };
    const open = () => !!document.querySelector('[data-radix-popper-content-wrapper]');
    const inject = () => {
      if (!fault || !document.head || document.querySelector('style[data-spec-chip-gutter-fault]')) return;
      const style = document.createElement('style');
      style.dataset.specChipGutterFault = 'chip-back-over-text';
      style.textContent = ${JSON.stringify(FAULT_CSS)};
      document.head.append(style);
    };
    if (fault) { new MutationObserver(inject).observe(document, { childList: true, subtree: true }); inject(); }
    window.__specChipGutter = { ready, measure, chipCenter, popover, open };
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

/** The same reading three frames running: fonts, chip layout and popper settled. */
async function stableBox(page, method) {
  return await evaluate(
    page,
    async (name) => {
      await document.fonts.ready;
      const read = () => JSON.stringify(window.__specChipGutter[name]());
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      for (let tries = 0; tries < 30; tries += 1) {
        const first = read();
        await frame();
        const second = read();
        await frame();
        const third = read();
        if (first !== "null" && first === second && second === third)
          return JSON.parse(third);
      }
      return null;
    },
    method,
  );
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

function inspectLayout(measurement, width) {
  const failures = [];
  if (!measurement.found || !measurement.body)
    return [failure("markdown-missing", "rendered spec not found", width)];
  if (!measurement.card || measurement.card.borderRight <= 0)
    return [
      failure(
        "card-missing",
        "the rendered spec's parent is not the bordered card",
        width,
      ),
    ];
  if (measurement.chips.length !== CHIPS)
    return [
      failure(
        "chip-missing",
        `expected ${CHIPS} chips, found ${measurement.chips.length}`,
        width,
      ),
    ];
  const { body, card, chips } = measurement;
  if (measurement.scrollWidth > measurement.clientWidth)
    failures.push(
      failure(
        "horizontal-overflow",
        `scrollWidth ${measurement.scrollWidth} > clientWidth ${measurement.clientWidth}`,
        width,
      ),
    );
  for (const [index, chip] of chips.entries()) {
    if (chip.left < body.right - EPSILON)
      failures.push(
        failure(
          "chip-over-text",
          `chip ${index} left ${chip.left} < text right ${body.right}`,
          width,
        ),
      );
  }
  if (narrow(width)) {
    if (body.right < card.inner - EPSILON)
      failures.push(
        failure(
          "text-short-of-card",
          `text right ${body.right} < card inner edge ${card.inner}`,
          width,
        ),
      );
  } else if (body.right > card.inner - GUTTER + EPSILON) {
    failures.push(
      failure(
        "desktop-gutter-lost",
        `text right ${body.right} > card inner edge ${card.inner} - ${GUTTER}`,
        width,
      ),
    );
  }
  return failures;
}

function inspectPopover(popover, chip, clientWidth, width, index) {
  const failures = [];
  if (popover.left < -EPSILON || popover.right > clientWidth + EPSILON)
    failures.push(
      failure(
        "popover-off-screen",
        `chip ${index} popover spans ${popover.left}..${popover.right}, viewport 0..${clientWidth}`,
        width,
      ),
    );
  if (!narrow(width) && popover.right > chip.left + EPSILON)
    failures.push(
      failure(
        "desktop-popover-side",
        `chip ${index} popover right ${popover.right} > chip left ${chip.left}`,
        width,
      ),
    );
  return failures;
}

async function measureViewport({ context, stack, fixture, fault, viewport }) {
  const page = await context.newPage({
    viewport: { ...viewport, deviceScaleFactor: 1 },
    cookie: fixture.cookie,
    scripts: [probeSource(fault)],
  });
  try {
    await page.navigate(`http://127.0.0.1:${stack.webPort}${fixture.url}`);
    await waitFor(page, "rendered spec with its chips", () =>
      window.__specChipGutter?.ready(),
    );
    const measurement = await stableBox(page, "measure");
    if (measurement === null)
      throw new Error(`layout did not settle at ${viewport.width}px`);
    const failures = inspectLayout(measurement, viewport.width);
    const popovers = [];
    if (measurement.chips?.length === CHIPS && measurement.card) {
      for (let index = 0; index < CHIPS; index += 1) {
        const target = await evaluate(
          page,
          (i) => window.__specChipGutter.chipCenter(i),
          index,
        );
        await mouseClick(page, target.x, target.y);
        const popover = await stableBox(page, "popover");
        if (popover === null) {
          failures.push(
            failure(
              "popover-missing",
              `chip ${index} opened no popover`,
              viewport.width,
            ),
          );
          continue;
        }
        popovers.push({ index, chip: target.chip, popover });
        failures.push(
          ...inspectPopover(
            popover,
            target.chip,
            measurement.clientWidth,
            viewport.width,
            index,
          ),
        );
        await pressEscape(page);
        await waitFor(
          page,
          "the popover to unmount",
          () => !window.__specChipGutter.open(),
          5_000,
        );
      }
    }
    return {
      measurement: { width: viewport.width, ...measurement, popovers },
      failures,
      page,
    };
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

async function runPass({ browser, stack, fixture, fault, label }) {
  const context = await browser.newContext();
  const failures = [];
  const measurements = [];
  try {
    for (const viewport of VIEWPORTS) {
      const result = await measureViewport({
        context,
        stack,
        fixture,
        fault,
        viewport,
      });
      measurements.push(result.measurement);
      failures.push(...result.failures);
      if (result.failures.length) {
        const shot = await result.page.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        writeFileSync(
          join(stack.dir, `spec-chip-gutter-${label}-${viewport.width}.png`),
          Buffer.from(shot.data, "base64"),
        );
      }
      await result.page.close();
    }
    const narrowMeasurements = measurements.filter((m) => narrow(m.width));
    const injectionConfirmed =
      fault &&
      narrowMeasurements.every(
        (m) =>
          m.faultMarker &&
          m.chips?.length === CHIPS &&
          m.chips.every(
            (chip) => chip.css.right === "0px" && chip.css.translate === "none",
          ),
      );
    const result = {
      name: `spec-chip-gutter:${label}`,
      fixture: { slug: fixture.slug, number: fixture.number },
      injectionConfirmed,
      failures,
      measurements,
    };
    if (failures.length)
      writeFileSync(
        join(stack.dir, `spec-chip-gutter-${label}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    return result;
  } finally {
    await context.close();
  }
}

export async function runSpecChipGutter(options) {
  const fixture = await seedSpecChipFixture(options.stack.serverPort);
  if (!options.selfTest) {
    return {
      name: "spec-chip-gutter",
      passes: [
        await runPass({ ...options, fixture, fault: false, label: "clean" }),
      ],
    };
  }
  const baseline = await runPass({
    ...options,
    fixture,
    fault: false,
    label: "baseline",
  });
  const fault = await runPass({
    ...options,
    fixture,
    fault: true,
    label: "fault",
  });
  const restored = await runPass({
    ...options,
    fixture,
    fault: false,
    label: "restored",
  });
  const caught = VIEWPORTS.filter((viewport) => narrow(viewport.width)).every(
    ({ width }) =>
      fault.failures.some(
        (item) => item.name === "chip-over-text" && item.width === width,
      ),
  );
  const problems = [
    baseline.failures.length &&
      `baseline not clean: ${baseline.failures.map((item) => `${item.name}:${item.width ?? "all"}`).join(", ")}`,
    !fault.injectionConfirmed &&
      "the fault stylesheet did not take effect at every narrow width",
    !caught &&
      "the fault was not reported as chip-over-text at every narrow width",
    restored.failures.length &&
      `restored not clean: ${restored.failures.map((item) => `${item.name}:${item.width ?? "all"}`).join(", ")}`,
  ].filter(Boolean);
  return {
    name: "spec-chip-gutter",
    passes: [baseline, fault, restored],
    failures: problems.length
      ? [failure("fault-injection-not-confirmed", problems.join("; "))]
      : [],
  };
}
