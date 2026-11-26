import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { evaluate } from "../lib/browser-cdp.mjs";

// An annotation chip shows how many notes its block has. Below 640px (Tailwind
// `sm`) it is a round 24px badge on the card's border for any count up to 99;
// from 640px up, chips whose counts have as many digits are equally wide.
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];
const SM = 640;
const COUNTS = [1, 2, 8, 12, 99];
const ROUND_EPSILON = 0.5;
const DIGIT_EPSILON = 0.05;
const PATH = "design.md";
// By slot, not by screen-reader name: the name's wording differs between
// branches that carry this case.
const CHIP = '[data-testid="annotated-markdown"] [data-slot="popover-trigger"]';
const FAULT_CSS = `${CHIP} { padding-left: 6px !important; padding-right: 6px !important; font-variant-numeric: normal !important; }`;

const narrow = (width) => width < SM;

function failure(name, detail, width, count) {
  return {
    name,
    detail,
    ...(width ? { width } : {}),
    ...(count ? { count } : {}),
  };
}

function documentBody() {
  const lines = ["# Annotation chip width fixture", ""];
  for (const count of COUNTS)
    lines.push(
      `This paragraph carries ${count} of the fixture's notes. It runs on long enough to wrap across several lines even in the widest desktop column, so that its chip sits at a height of its own, well clear of the chips beside the paragraphs above and below it.`,
      "",
    );
  return lines.join("\n");
}

/** One project, one card, one spec file whose paragraphs carry 1, 2, 8, 12 and 99 notes. */
export async function seedSpecChipWidthFixture(serverPort) {
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
  const slug = `spec-width-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  await call("POST", "/projects", {
    slug,
    name: `Spec chip width ${slug}`,
    description: "",
  });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Rendered spec with 1, 2, 8, 12 and 99 notes",
    body: "",
  });
  const spec = `/projects/${slug}/issues/${issue.number}/spec`;
  const body = documentBody();
  const pushed = await call("POST", `${spec}/push`, {
    files: [{ path: PATH, body }],
    message: "Chip width fixture",
  });
  const lines = body.split("\n");
  const paragraphs = lines.flatMap((line, i) =>
    line.length > 80 ? [i + 1] : [],
  );
  if (paragraphs.length !== COUNTS.length)
    throw new Error(`fixture has ${paragraphs.length} long paragraphs`);
  // One review per paragraph: a review takes at most 100 comments.
  for (const [index, line] of paragraphs.entries())
    await call("POST", `${spec}/reviews`, {
      version: pushed.version,
      verdict: "comment",
      comments: Array.from({ length: COUNTS[index] }, (_, note) => ({
        anchor: {
          path: PATH,
          version: pushed.version,
          line_start: line,
          line_end: line,
        },
        body: `Note ${note + 1} of ${COUNTS[index]} on the chip width fixture.`,
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
    const round = value => Number(value.toFixed(3));
    const chips = () => [...document.querySelectorAll(${JSON.stringify(CHIP)})];
    const sized = element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const ready = () => {
      const found = chips();
      return found.length === ${COUNTS.length} && found.every(sized);
    };
    const measure = () => ({
      faultMarker: !!document.querySelector('style[data-spec-chip-width-fault]'),
      chips: chips().map(chip => {
        const rect = chip.getBoundingClientRect();
        const style = getComputedStyle(chip);
        return {
          count: chip.textContent.trim(),
          width: round(rect.width),
          height: round(rect.height),
          css: { paddingLeft: style.paddingLeft, paddingRight: style.paddingRight, fontVariantNumeric: style.fontVariantNumeric },
        };
      }),
    });
    const inject = () => {
      if (!fault || !document.head || document.querySelector('style[data-spec-chip-width-fault]')) return;
      const style = document.createElement('style');
      style.dataset.specChipWidthFault = 'chip-padding-and-digits';
      style.textContent = ${JSON.stringify(FAULT_CSS)};
      document.head.append(style);
    };
    if (fault) { new MutationObserver(inject).observe(document, { childList: true, subtree: true }); inject(); }
    window.__specChipWidth = { ready, measure };
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

/**
 * Geist's digits are what this case measures. Without it the page falls back
 * to a face whose digits may all be equally wide anyway, so a missing Geist is
 * an error, not a reading.
 */
async function requireGeist(page, width) {
  const loaded = await evaluate(page, async () => {
    await document.fonts.ready;
    const face = [...document.fonts].some(
      (font) =>
        font.family.replace(/["']/g, "") === "Geist Variable" &&
        font.status === "loaded",
    );
    return face && document.fonts.check('12px "Geist Variable"', "0123456789");
  });
  if (!loaded) throw new Error(`Geist Variable did not load at ${width}px`);
}

/** The same reading three frames running: fonts and chip layout settled. */
async function stableMeasurement(page) {
  return await evaluate(page, async () => {
    const read = () => JSON.stringify(window.__specChipWidth.measure());
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    for (let tries = 0; tries < 30; tries += 1) {
      const first = read();
      await frame();
      const second = read();
      await frame();
      const third = read();
      if (first === second && second === third) return JSON.parse(third);
    }
    return null;
  });
}

function inspect(measurement, width) {
  const counts = measurement.chips
    .map((chip) => Number(chip.count))
    .sort((a, b) => a - b);
  if (counts.join() !== COUNTS.join())
    return [
      failure(
        "chip-missing",
        `expected chips ${COUNTS.join(", ")}, found ${measurement.chips.map((chip) => chip.count).join(", ") || "none"}`,
        width,
      ),
    ];
  const failures = [];
  if (narrow(width)) {
    for (const chip of measurement.chips)
      if (Math.abs(chip.width - chip.height) > ROUND_EPSILON)
        failures.push(
          failure(
            "badge-not-round",
            `chip ${chip.count} is ${chip.width}×${chip.height}`,
            width,
            chip.count,
          ),
        );
  } else {
    for (const digits of new Set(COUNTS.map((count) => String(count).length))) {
      const group = measurement.chips.filter(
        (chip) => chip.count.length === digits,
      );
      const widths = group.map((chip) => chip.width);
      if (Math.max(...widths) - Math.min(...widths) > DIGIT_EPSILON)
        failures.push({
          ...failure(
            "digit-widths-differ",
            `${digits}-digit chips are ${group.map((chip) => `${chip.count}: ${chip.width}`).join(", ")}`,
            width,
          ),
          digits,
        });
    }
  }
  return failures;
}

async function fullPageShot(page, file) {
  const size = await evaluate(page, () => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  const shot = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, ...size, scale: 1 },
  });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
}

/** The fixture's page with its chips laid out and Geist loaded. */
async function openChips({
  context,
  stack,
  fixture,
  fault,
  viewport,
  blockFonts = false,
}) {
  const page = await context.newPage({
    viewport: { ...viewport, deviceScaleFactor: 1 },
    cookie: fixture.cookie,
    scripts: [probeSource(fault)],
  });
  try {
    if (blockFonts)
      await page.send("Network.setBlockedURLs", { urls: ["*.woff2"] });
    await page.navigate(`http://127.0.0.1:${stack.webPort}${fixture.url}`);
    await waitFor(page, "rendered spec with its chips", () =>
      window.__specChipWidth?.ready(),
    );
    await requireGeist(page, viewport.width);
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

/** With no font file reachable, the case stops at the Geist gate. */
async function geistGateHolds({ browser, stack, fixture }) {
  const context = await browser.newContext();
  try {
    const page = await openChips({
      context,
      stack,
      fixture,
      fault: false,
      viewport: VIEWPORTS.at(-1),
      blockFonts: true,
    });
    await page.close().catch(() => {});
    return false;
  } catch (error) {
    return error.message.startsWith("Geist Variable did not load");
  } finally {
    await context.close();
  }
}

async function runPass({ browser, stack, fixture, fault, label }) {
  const context = await browser.newContext();
  const failures = [];
  const measurements = [];
  try {
    for (const viewport of VIEWPORTS) {
      const page = await openChips({
        context,
        stack,
        fixture,
        fault,
        viewport,
      });
      try {
        const measurement = await stableMeasurement(page);
        if (measurement === null)
          throw new Error(`chips did not settle at ${viewport.width}px`);
        measurements.push({ width: viewport.width, ...measurement });
        const found = inspect(measurement, viewport.width);
        failures.push(...found);
        if (found.length)
          await fullPageShot(
            page,
            join(stack.dir, `spec-chip-width-${label}-${viewport.width}.png`),
          );
      } finally {
        await page.close().catch(() => {});
      }
    }
    const injectionConfirmed =
      fault &&
      measurements.every(
        (m) =>
          m.faultMarker &&
          m.chips.length === COUNTS.length &&
          m.chips.every(
            (chip) =>
              chip.css.paddingLeft === "6px" &&
              chip.css.paddingRight === "6px" &&
              chip.css.fontVariantNumeric === "normal",
          ),
      );
    const result = {
      name: `spec-chip-width:${label}`,
      fixture: { slug: fixture.slug, number: fixture.number },
      injectionConfirmed,
      failures,
      measurements,
    };
    if (failures.length)
      writeFileSync(
        join(stack.dir, `spec-chip-width-${label}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    return result;
  } finally {
    await context.close();
  }
}

export async function runSpecChipWidth(options) {
  const fixture = await seedSpecChipWidthFixture(options.stack.serverPort);
  if (!options.selfTest) {
    return {
      name: "spec-chip-width",
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
  const gateHeld = await geistGateHolds({ ...options, fixture });
  // Six pixels a side, the desktop's padding, spill two digits out of the
  // badge; a single digit still fits.
  const caughtNarrow = VIEWPORTS.filter((viewport) =>
    narrow(viewport.width),
  ).every(({ width }) =>
    ["12", "99"].every((count) =>
      fault.failures.some(
        (item) =>
          item.name === "badge-not-round" &&
          item.width === width &&
          item.count === count,
      ),
    ),
  );
  // Proportional digits: 1 is narrower than 2 and 8, 12 than 99.
  const caughtWide = VIEWPORTS.filter(
    (viewport) => !narrow(viewport.width),
  ).every(({ width }) =>
    [1, 2].every((digits) =>
      fault.failures.some(
        (item) =>
          item.name === "digit-widths-differ" &&
          item.width === width &&
          item.digits === digits,
      ),
    ),
  );
  const problems = [
    baseline.failures.length &&
      `baseline not clean: ${baseline.failures.map((item) => `${item.name}:${item.width ?? "all"}`).join(", ")}`,
    !gateHeld &&
      "a page whose fonts were blocked was measured instead of stopping at the Geist gate",
    !fault.injectionConfirmed &&
      "the fault stylesheet did not take effect at every width",
    !caughtNarrow &&
      "the fault was not reported as badge-not-round for chips 12 and 99 at every narrow width",
    !caughtWide &&
      "the fault was not reported as digit-widths-differ for one- and two-digit chips at every wide width",
    restored.failures.length &&
      `restored not clean: ${restored.failures.map((item) => `${item.name}:${item.width ?? "all"}`).join(", ")}`,
  ].filter(Boolean);
  return {
    name: "spec-chip-width",
    passes: [baseline, fault, restored],
    failures: problems.length
      ? [failure("fault-injection-not-confirmed", problems.join("; "))]
      : [],
  };
}
