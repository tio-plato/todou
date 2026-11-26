#!/usr/bin/env node
/**
 * Real-browser geometry for the X that closes a title-bar dialog (T-562): in
 * the attachment viewer, the full-document view and the edit history, the
 * close button has to sit in the title bar's row — same vertical centre and
 * height as the controls beside it, and its right edge on the content edge.
 * A confirm's title, whose X is pinned to the corner instead, has to wrap
 * clear of it and inside the content edge, a long name included.
 * Usage: node scripts/dialog-close-align-smoke.mjs [--keep] [--help]
 * Requires the same installed dependencies, Node 24+, flock and CHROMIUM
 * (default /usr/bin/chromium) as the other browser smokes.
 * Exit: 0 every case as expected; 1 an assertion; 2 infrastructure failure.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELP = `dialog-close-align-smoke — the title-bar X lines up with its row

Usage: node scripts/dialog-close-align-smoke.mjs [--keep] [--help]

Opens the attachment viewer (fit and maximized), the full-document view and
the edit history at desktop and phone widths, and compares the close button's
box with the title bar's other control: vertical centre and height within
0.5px, right edge on the dialog's content edge within 0.5px.

Opens the delete confirm of two attachments with long names at both widths,
and both titles have to wrap: the one of short words must end every line
beside the close button left of it, and the one long word must break inside
the content edge, within 0.5px.

Then a fault run nudges the close button by 1px and must turn every centre
case red, so a pass is evidence the tolerance can fail.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
Exit codes: 0 pass, 1 assertion, 2 infrastructure error.
`;

const TOLERANCE = 0.5;
const DESKTOP = { width: 1440, height: 1000, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const FAULTS = {
  // Applied after load as a stylesheet; `translate` composes with the button's
  // own classes, so whatever the layout puts there moves 1px down.
  "close-nudged": `[data-slot="dialog-close"] { translate: 0 1px; }`,
};

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function seed(stack) {
  let cookie = "";
  const call = async (method, path, body, form) => {
    const response = await fetch(`${stack.serverUrl}/api${path}`, {
      method,
      headers: {
        ...(form ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(15_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "/auth/login");
  const slug = "dialog-close-align";
  await call("POST", "/projects", { slug, name: "Close", description: "" });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Title-bar dialogs",
    body: "",
  });
  const upload = async (name, bytes, type) => {
    const form = new FormData();
    form.append("file", new File([bytes], name, { type }));
    form.append("issue_number", String(issue.number));
    return call("POST", `/projects/${slug}/attachments`, undefined, form);
  };
  // Two, so the viewer's title bar carries ‹ n / m › as well.
  const sheet = await upload(
    "sheet.png",
    png(1200, 800, (x, y) => [(x * 7) & 255, (y * 3) & 255, (x ^ y) & 255]),
    "image/png",
  );
  await upload(
    "icon.png",
    png(48, 48, (x, y) => [x * 5, y * 5, 128]),
    "image/png",
  );
  const notes = await upload(
    "notes.md",
    Buffer.from("# Notes\n\nA document to open in full.\n"),
    "text/markdown",
  );
  // Names for the delete confirm's title, one per way it can go wrong. Words
  // of one letter, none of them wide, end the first line less than a letter
  // and a space short of the edge it wraps at, which is under the X unless
  // the header keeps clear of it.
  const breakable = await upload(
    "abcdefgh".repeat(10).split("").join(" ").slice(0, 79),
    Buffer.from("breakable\n"),
    "text/plain",
  );
  // No space or hyphen: only `overflow-wrap: anywhere` breaks it.
  const unbreakable = await upload(
    "abcdefghij".repeat(8),
    Buffer.from("unbreakable\n"),
    "text/plain",
  );
  // The second write is what gives the description an edit history.
  await call("PATCH", `/projects/${slug}/issues/${issue.number}`, {
    body: `![](${notes.url})\n\nbefore`,
  });
  await call("PATCH", `/projects/${slug}/issues/${issue.number}`, {
    body: `![](${notes.url})\n\nafter`,
  });
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  return {
    cookie,
    issueUrl: `${stack.webUrl}/projects/${slug}/issues/${issue.number}`,
    image: sheet.filename,
    document: notes.filename,
    breakable: breakable.filename,
    unbreakable: unbreakable.filename,
  };
}

/** The delete confirm of the attachment named `file`, from its row's trash. */
function openDelete(_image, _document, file) {
  const button = document.querySelector(`button[aria-label="delete ${file}"]`);
  button?.click();
  return button !== null;
}

/**
 * Each opener clicks its way to one dialog and names the title-bar control
 * the X is compared with. Clicked through the DOM: what is measured here is
 * where the dialog lays out, not how it was reached. A confirm has no such
 * control; it names the seeded file whose title it opens and its own cases.
 */
const DIALOGS = {
  viewer: {
    open: (image) => {
      const link = document.querySelector(`a[href$="/view/${image}"]`);
      link?.click();
      return link !== null;
    },
    neighbour: '[aria-label="maximize"]',
  },
  "viewer-maximized": {
    open: (image) => {
      const dialog = document.querySelector('[role="dialog"]');
      const button = dialog?.querySelector('[aria-label="maximize"]');
      if (button) {
        button.click();
        return true;
      }
      if (!dialog) document.querySelector(`a[href$="/view/${image}"]`)?.click();
      return false;
    },
    neighbour: '[aria-label="restore size"]',
  },
  document: {
    open: (_image, document_) => {
      const button = document.querySelector(
        `button[aria-label="expand ${document_}"]`,
      );
      button?.click();
      return button !== null;
    },
    neighbour: '[aria-label="maximize"]',
  },
  history: {
    open: () => {
      const rows = document.querySelectorAll(
        '[data-slot="popover-content"] button',
      );
      if (rows.length > 0) {
        rows[0].click();
        return true;
      }
      const mark = [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "(edited)",
      );
      mark?.click();
      return false;
    },
    neighbour: '[aria-label="wrap long lines"]',
  },
  "confirm-breakable": {
    open: openDelete,
    file: "breakable",
    cases: (name, box) => [
      wraps(name, box),
      {
        name: `${name}:clear-of-close`,
        ok: overlap(box).every(
          (line) => line.right - box.close.left <= TOLERANCE,
        ),
        detail: {
          dr: overlap(box).map((line) => line.right - box.close.left),
        },
      },
    ],
  },
  "confirm-unbreakable": {
    open: openDelete,
    file: "unbreakable",
    cases: (name, box) => [
      wraps(name, box),
      {
        name: `${name}:inside`,
        ok: box.lines.every(
          (line) => line.right - box.contentRight <= TOLERANCE,
        ),
        detail: { dr: box.lines.map((line) => line.right - box.contentRight) },
      },
    ],
  },
};

function measure(neighbourSelector) {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return null;
  // A confirm's Cancel is a dialog-close too, and comes first.
  const close = dialog.querySelector(
    '[data-slot="dialog-close"]:not([data-slot="dialog-footer"] *)',
  );
  const neighbour = neighbourSelector
    ? dialog.querySelector(neighbourSelector)
    : null;
  if (!close || (neighbourSelector && !neighbour)) return null;
  // The open animation scales from 95%, and the button transitions every
  // property; a box read mid-way through either is not the layout.
  if (
    dialog
      .getAnimations({ subtree: true })
      .some((a) => a.playState === "running")
  )
    return null;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      top: r.top,
      height: r.height,
      width: r.width,
      left: r.left,
      right: r.right,
    };
  };
  // The text's own boxes, one per line it wrapped onto: the title element is
  // as wide as its column, whatever the words in it reach.
  const title = dialog.querySelector('[data-slot="dialog-title"]');
  const range = document.createRange();
  if (title) range.selectNodeContents(title);
  const style = getComputedStyle(dialog);
  const frame = dialog.getBoundingClientRect();
  return {
    close: box(close),
    neighbour: neighbour && box(neighbour),
    lines: title
      ? [...range.getClientRects()].map((r) => ({
          top: r.top,
          bottom: r.bottom,
          right: r.right,
        }))
      : [],
    contentRight:
      frame.right -
      Number.parseFloat(style.borderRightWidth) -
      Number.parseFloat(style.paddingRight),
  };
}

async function openDialog(context, fixture, viewport, fault, name) {
  const equals = fixture.cookie.indexOf("=");
  const page = await context.newPage({
    viewport,
    cookie: {
      name: fixture.cookie.slice(0, equals),
      value: fixture.cookie.slice(equals + 1),
      url: fixture.issueUrl,
    },
    scripts: [],
  });
  try {
    await page.navigate(fixture.issueUrl);
    const dialog = DIALOGS[name];
    const deadline = Date.now() + 30_000;
    let opened = false;
    while (Date.now() < deadline) {
      await sleep(200);
      if (!opened)
        opened = await evaluate(
          page,
          dialog.open,
          fixture.image,
          fixture.document,
          fixture[dialog.file],
        ).catch(() => false);
      if (!opened) continue;
      if (fault)
        await evaluate(
          page,
          (css) => {
            if (document.getElementById("smoke-fault")) return;
            const style = document.createElement("style");
            style.id = "smoke-fault";
            style.textContent = css;
            document.head.append(style);
          },
          FAULTS[fault],
        );
      const box = await evaluate(page, measure, dialog.neighbour).catch(
        () => null,
      );
      if (box) return { page, box };
    }
    throw new Error(`${name} dialog never showed its close button`);
  } catch (error) {
    await page.close();
    throw error;
  }
}

/**
 * The title's lines. A line's text can come back in more than one box, so
 * boxes on one line merge into one that reaches the furthest right.
 */
function titleLines(box) {
  const lines = [];
  for (const r of box.lines) {
    const line = lines.find((l) => Math.abs(l.top - r.top) <= TOLERANCE);
    if (line) line.right = Math.max(line.right, r.right);
    else lines.push({ ...r });
  }
  return lines;
}

/** One line proves nothing about where the title wraps. */
function wraps(name, box) {
  const lines = titleLines(box).length;
  return { name: `${name}:wraps`, ok: lines >= 2, detail: { lines } };
}

/** Lines that share some height with the X, the ones it can cover. */
function overlap(box) {
  const bottom = box.close.top + box.close.height;
  return titleLines(box).filter(
    (line) => line.top < bottom && line.bottom > box.close.top,
  );
}

function cases(name, box) {
  const centre = (b) => b.top + b.height / 2;
  const dy = centre(box.close) - centre(box.neighbour);
  const dh = box.close.height - box.neighbour.height;
  const dr = box.close.right - box.contentRight;
  return [
    {
      name: `${name}:centre`,
      ok: Math.abs(dy) <= TOLERANCE,
      detail: { dy },
    },
    {
      name: `${name}:height`,
      ok: Math.abs(dh) <= TOLERANCE,
      detail: { dh },
    },
    {
      name: `${name}:right-edge`,
      ok: Math.abs(dr) <= TOLERANCE,
      detail: { dr },
    },
  ];
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
      prefix: "dialog-close-align-smoke-",
      keep,
    });
    const fixture = await seed(stack);
    const browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
    stack.addCleanup(() => browser.close());
    const sweep = async (fault) => {
      const results = [];
      for (const [label, viewport] of [
        ["desktop", DESKTOP],
        ["phone", PHONE],
      ]) {
        for (const name of Object.keys(DIALOGS)) {
          const context = await browser.newContext();
          try {
            const { page, box } = await openDialog(
              context,
              fixture,
              viewport,
              fault,
              name,
            );
            await page.close();
            results.push(
              ...(DIALOGS[name].cases ?? cases)(`${label}:${name}`, box),
            );
          } finally {
            await context.close();
          }
        }
      }
      return results;
    };
    record("layout", await sweep(null));
    const nudged = await sweep("close-nudged");
    record(
      "fault-close-nudged",
      nudged,
      nudged.filter((c) => c.name.endsWith(":centre")).map((c) => c.name),
    );
  } catch (error) {
    exitCode = 2;
    runs.push({
      name: "runner-error",
      status: "fail",
      error: error.stack ?? String(error),
    });
    console.error(`dialog-close-align-smoke: ${error.stack ?? error}`);
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
    name: "dialog-close-align-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    runs,
  };
  console.log(`REPORT ${JSON.stringify({ status: report.status, exitCode })}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "dialog-close-align-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
