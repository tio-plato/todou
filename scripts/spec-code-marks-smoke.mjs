#!/usr/bin/env node
/**
 * Real-browser colours of a code block whose column note is painted: in the
 * rendered comparison, once the characters a comment or a draft covers are
 * painted inside a fence (CSS Custom Highlight API), a fence that is wholly
 * new, changed only in its info string, or drawn as a line diff must look as
 * the same kind of fence does with a whole-line note on it: the same wash in
 * the strip between its bar and its code, and the same bar.
 * Usage: node scripts/spec-code-marks-smoke.mjs [--keep] [--help]
 * Requires the same installed dependencies, Node 24+, flock and CHROMIUM
 * (default /usr/bin/chromium) as the other browser smokes.
 * Exit: 0 every case as expected; 1 an assertion; 2 infrastructure failure.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  browserColorTools,
  colorsEqual,
} from "./browser/diff-colors-color.mjs";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELP = `spec-code-marks-smoke — a painted column note keeps a fence's diff colours

Usage: node scripts/spec-code-marks-smoke.mjs [--keep] [--help]

Pushes two versions of a spec whose code blocks are new, changed only in
their info string, or drawn as a line diff, puts a comment or a draft on one
line of each — on a word of it or on the whole line — and opens the rendered
comparison. Each block whose column note is painted must show the background
and the left bar of the same kind of block carrying a whole-line note.

A reference check keeps those whole-line blocks coloured themselves, so two
blocks that both lost their colour do not pass as equal.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
Exit codes: 0 pass, 1 assertion, 2 infrastructure error.
`;

const PATH = "plan.md";
const VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1 };
const READY_MS = 30_000;
const STABLE_READS = 4;

/**
 * Every block is three lines, `const <name>1 = 1;` and so on, and is known by
 * that name. `new` exists only in the viewed version, `info` changes its
 * info string alone, `diff` changes the value on its second line. A note sits
 * on that second line: on its `<name>2` (columns) or on all of it.
 */
const BLOCKS = [
  { name: "infoPlain", kind: "info" },
  { name: "infoCol", kind: "info", note: "comment", columns: true },
  { name: "infoWhole", kind: "info", note: "comment" },
  { name: "diffCol", kind: "diff", note: "comment", columns: true },
  { name: "diffWhole", kind: "diff", note: "comment" },
  { name: "newPlain", kind: "new" },
  { name: "newCol", kind: "new", note: "comment", columns: true },
  { name: "newWhole", kind: "new", note: "comment" },
  { name: "newColDraft", kind: "new", note: "draft", columns: true },
  { name: "newWholeDraft", kind: "new", note: "draft" },
];

/** A column-noted block and the whole-line block it must look like. */
const PAIRS = [
  {
    name: "new-comment",
    column: "newCol",
    whole: "newWhole",
    state: ["spec-ins-block"],
    note: "comment",
  },
  {
    name: "new-draft",
    column: "newColDraft",
    whole: "newWholeDraft",
    state: ["spec-ins-block"],
    note: "draft",
  },
  {
    name: "info-comment",
    column: "infoCol",
    whole: "infoWhole",
    state: ["spec-changed"],
    absent: ["spec-fence-diff"],
    note: "comment",
  },
  {
    name: "diff-comment",
    column: "diffCol",
    whole: "diffWhole",
    state: ["spec-changed", "spec-fence-diff"],
    note: "comment",
  },
];

function fence(block, baseline) {
  const lang = block.kind === "info" && baseline ? "ts" : "js";
  const value = (n) => (block.kind === "diff" && !baseline && n === 2 ? 22 : n);
  return [
    `\`\`\`${lang}`,
    ...[1, 2, 3].map((n) => `const ${block.name}${n} = ${value(n)};`),
    "```",
    "",
  ];
}

/** Changed blocks follow a paragraph both versions keep; new ones come last. */
function document_(baseline) {
  const lines = ["# Code notes", ""];
  for (const block of BLOCKS.filter((b) => b.kind !== "new"))
    lines.push(`Before ${block.name}.`, "", ...fence(block, baseline));
  lines.push("New blocks follow.", "");
  if (!baseline)
    for (const block of BLOCKS.filter((b) => b.kind === "new"))
      lines.push(`Before ${block.name}.`, "", ...fence(block, baseline));
  lines.push("End.", "");
  return lines;
}

function anchor(lines, version, block) {
  const text = `const ${block.name}2 =`;
  const index = lines.findIndex((line) => line.startsWith(text));
  if (index < 0) throw new Error(`fixture lacks ${text}`);
  const word = `${block.name}2`;
  const column = lines[index].indexOf(word) + 1;
  return {
    path: PATH,
    version,
    line_start: index + 1,
    line_end: index + 1,
    col_start: block.columns ? column : null,
    col_end: block.columns ? column + word.length - 1 : null,
  };
}

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
    if (!response.ok)
      throw new Error(
        `${method} ${path}: ${response.status} ${await response.text()}`,
      );
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "/auth/login");
  const slug = "spec-code-marks";
  await call("POST", "/projects", { slug, name: "Marks", description: "" });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Painted code notes",
    body: "",
  });
  const spec = `/projects/${slug}/issues/${issue.number}/spec`;
  await call("POST", `${spec}/push`, {
    message: "v1",
    files: [{ path: PATH, body: document_(true).join("\n") }],
  });
  const lines = document_(false);
  const { version } = await call("POST", `${spec}/push`, {
    message: "v2",
    files: [{ path: PATH, body: lines.join("\n") }],
  });
  await call("POST", `${spec}/reviews`, {
    version,
    verdict: "comment",
    comments: BLOCKS.filter((b) => b.note === "comment").map((block) => {
      const { col_start, col_end, ...rest } = anchor(lines, version, block);
      return {
        anchor: block.columns ? { ...rest, col_start, col_end } : rest,
        body: `${block.name}: comment`,
      };
    }),
  });
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  // Drafts live in the browser alone; spec-drafts.ts reads them from here.
  const drafts = BLOCKS.filter((b) => b.note === "draft").map((block) => ({
    id: `draft-${block.name}`,
    anchor: anchor(lines, version, block),
    quote: "",
    body: `${block.name}: draft`,
  }));
  return {
    cookie,
    url: `${stack.webUrl}${spec}?file=${PATH}&v=${version}&compare=1&view=rendered`,
    draftsKey: `todou-spec-review:${slug}:${issue.number}`,
    drafts,
  };
}

/** Classes and normalized colours of every fence, by the name it holds. */
function measure() {
  const tools = window.__diffColors;
  const root = document.querySelector('[data-testid="annotated-markdown"]');
  if (!tools || !root) return null;
  const blocks = {};
  for (const fence of root.querySelectorAll(".markdown-fence")) {
    const rows = [
      ...(fence
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelectorAll("[data-line]") ?? []),
    ];
    const first = rows
      .map((row) => row.textContent)
      .find((text) => text.includes("const "));
    const name = first && /const (\w+?)\d/.exec(first)?.[1];
    if (!name) continue;
    const style = getComputedStyle(fence);
    blocks[name] = {
      classes: [...fence.classList]
        .filter((c) => c !== "markdown-fence")
        .sort(),
      rows: rows.length,
      background: tools.normalize(style.backgroundColor),
      border: tools.normalize(style.borderLeftColor),
    };
  }
  return blocks;
}

/** What each pair's blocks must wear for the comparison to mean anything. */
function preconditions(blocks) {
  const failed = [];
  const wears = (name, present, absent = []) => {
    const classes = blocks[name]?.classes ?? [];
    if (
      !present.every((c) => classes.includes(c)) ||
      absent.some((c) => classes.includes(c))
    )
      failed.push(`${name} [${classes.join(" ")}]`);
  };
  for (const pair of PAIRS) {
    const mark = `spec-mark-${pair.note}-block`;
    const whole = [
      "spec-annotated",
      ...(pair.note === "draft" ? ["spec-annotated-draft"] : []),
    ];
    // A column block that also wore the whole-line note, or the other way
    // round, would compare two blocks of one sort and pass for nothing.
    wears(
      pair.column,
      [...pair.state, mark, "spec-code-painted"],
      [...(pair.absent ?? []), "spec-annotated"],
    );
    wears(
      pair.whole,
      [...pair.state, ...whole, "spec-code-painted"],
      [
        ...(pair.absent ?? []),
        "spec-mark-comment-block",
        "spec-mark-draft-block",
      ],
    );
  }
  return failed;
}

const show = (color) =>
  color
    ? `rgb(${color
        .slice(0, 3)
        .map((v) => Math.round(v * 255))
        .join(" ")} / ${Number(color[3].toFixed(3))})`
    : "none";
const visible = (color) => Array.isArray(color) && color[3] > 0;

function checks(blocks) {
  const lines = [];
  for (const pair of PAIRS) {
    for (const property of ["background", "border"]) {
      const column = blocks[pair.column][property];
      const whole = blocks[pair.whole][property];
      lines.push({
        ok: colorsEqual(column, whole),
        name: `${pair.name}:${property}`,
        detail: `${pair.column}=${show(column)} ${pair.whole}=${show(whole)}`,
      });
    }
  }
  const reference = [
    ["newWhole", "background"],
    ["newPlain", "background"],
    ["infoWhole", "background"],
    ["infoPlain", "background"],
    ["diffWhole", "background"],
    ["diffWhole", "border"],
  ];
  const read = (name, property) => blocks[name][property];
  lines.push({
    ok:
      reference.every(([name, property]) => visible(read(name, property))) &&
      colorsEqual(
        read("newWhole", "background"),
        read("newPlain", "background"),
      ) &&
      colorsEqual(
        read("infoWhole", "background"),
        read("infoPlain", "background"),
      ),
    name: "reference",
    detail: reference
      .map(
        ([name, property]) =>
          `${name}.${property}=${show(read(name, property))}`,
      )
      .join(" "),
  });
  return lines;
}

async function readBlocks(browser, fixture) {
  const context = await browser.newContext();
  try {
    const equals = fixture.cookie.indexOf("=");
    const page = await context.newPage({
      viewport: VIEWPORT,
      cookie: {
        name: fixture.cookie.slice(0, equals),
        value: fixture.cookie.slice(equals + 1),
        url: fixture.url,
      },
      scripts: [
        `window.__diffColors = (${browserColorTools.toString()})();`,
        `localStorage.setItem(${JSON.stringify(fixture.draftsKey)}, ${JSON.stringify(JSON.stringify(fixture.drafts))});`,
        `localStorage.setItem("todou-theme", "github-light");`,
      ],
    });
    await page.navigate(fixture.url);
    const deadline = Date.now() + READY_MS;
    let last = null;
    let lastKey = "";
    let stable = 0;
    while (Date.now() < deadline) {
      await sleep(250);
      last = await evaluate(page, measure).catch((error) => ({
        error: String(error),
      }));
      const ready =
        last &&
        !last.error &&
        BLOCKS.every((b) => last[b.name]?.rows > 0) &&
        preconditions(last).length === 0;
      const key = JSON.stringify(last);
      stable = ready && key === lastKey ? stable + 1 : 0;
      lastKey = key;
      if (stable >= STABLE_READS) return last;
    }
    const missing =
      last && !last.error
        ? [
            ...BLOCKS.filter((b) => !(last[b.name]?.rows > 0)).map(
              (b) => `${b.name} not drawn`,
            ),
            ...preconditions(last).map((p) => `precondition: ${p}`),
          ]
        : [];
    throw new Error(
      `blocks never settled: ${missing.join("; ")}\nlast reading: ${JSON.stringify(last)}`,
    );
  } finally {
    await context.close();
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
  let results = [];
  let error = null;
  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "spec-code-marks-smoke-",
      keep,
    });
    const fixture = await seed(stack);
    const browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
    stack.addCleanup(() => browser.close());
    results = checks(await readBlocks(browser, fixture));
    for (const c of results)
      console.log(c.ok ? `ok ${c.name}` : `RED ${c.name} ${c.detail}`);
    if (results.some((c) => !c.ok)) exitCode = 1;
  } catch (caught) {
    exitCode = 2;
    error = caught.stack ?? String(caught);
    console.error(`spec-code-marks-smoke: ${error}`);
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
      } catch (caught) {
        exitCode = 2;
        error = caught.stack ?? String(caught);
        console.error(`spec-code-marks-smoke: cleanup: ${error}`);
      }
    }
  }
  const report = {
    name: "spec-code-marks-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    results,
    ...(error ? { error } : {}),
  };
  console.log(`REPORT ${JSON.stringify({ status: report.status, exitCode })}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "spec-code-marks-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
