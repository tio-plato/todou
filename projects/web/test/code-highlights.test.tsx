import { act, cleanup, waitFor } from "@testing-library/react";
import type { SpecCommentItem } from "@todou/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AnnotatedMarkdown,
  type DisplayedAnnotation,
} from "../src/components/spec/annotated-markdown.tsx";
import {
  announceCodeRendered,
  clearCodeHighlights,
  LINE_MARK_ATTR,
  markRows,
  setCodeHighlights,
} from "../src/lib/code-highlights.ts";
import { renderWithProviders } from "./render.tsx";

// pierre draws code in a shadow root happy-dom cannot lay out; the rows are
// built by hand below, inside the real stamped wrapper.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

/** A stand-in for the browser's `Highlight`: the ranges it was built from. */
class FakeHighlight {
  ranges: Range[];
  priority = 0;
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
  add(range: Range): this {
    this.ranges.push(range);
    return this;
  }
}

/** Give happy-dom the Custom Highlight API, and hand back its registry. */
function stubHighlights(): Map<string, FakeHighlight> {
  const registry = new Map<string, FakeHighlight>();
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal(
    "CSS",
    Object.assign(Object.create(globalThis.CSS), { highlights: registry }),
  );
  return registry;
}

// pierre's module defines `diffs-container`, and a patch fence loads it to
// parse. Defined mid-test, happy-dom upgrades the hosts drawn by hand below
// into elements with a fresh, empty shadow root, which no browser does; so
// it is defined before any host exists.
beforeAll(async () => {
  await import("@pierre/diffs");
});

afterEach(() => {
  // Unmounted first, while the API is still there to take the ranges back.
  cleanup();
  vi.unstubAllGlobals();
});

const ITEM: SpecCommentItem = {
  comment_id: 1,
  author: {
    id: 1,
    login: "bot-one",
    display_name: "Bot One",
    kind: "machine",
    avatar_url: null,
    owner: null,
  },
  created_at: "2026-01-06T00:00:00Z",
  body: "look here",
  anchor: {
    path: "plan.md",
    version: 1,
    line_start: 1,
    line_end: 1,
    col_start: null,
    col_end: null,
    quote: "",
  },
  resolved: null,
  outdated: false,
  current_line_start: null,
  current_line_end: null,
};

function onLine(
  kind: "comment" | "draft",
  line: number,
  colStart: number,
  colEnd: number,
): DisplayedAnnotation {
  const at = { start: line, end: line, colStart, colEnd };
  return kind === "comment"
    ? { key: `c${line}`, kind, item: ITEM, ...at }
    : {
        key: `d${line}`,
        kind,
        draft: {
          id: `d${line}`,
          anchor: {
            path: "plan.md",
            version: 1,
            line_start: line,
            line_end: line,
            col_start: colStart,
            col_end: colEnd,
          },
          quote: "",
          body: "staged",
        },
        ...at,
      };
}

/** The rendered document, its code wrappers waiting for their rows. */
async function renderDocument(
  body: string,
  annotations: DisplayedAnnotation[],
) {
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={body}
      annotations={annotations}
      onStage={() => {}}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
  );
  const wrappers = await waitFor(() => {
    const els = view.container.querySelectorAll("[data-loc-content-start]");
    if (els.length === 0) throw new Error("not rendered");
    return [...els];
  });
  return { view, wrappers };
}

/** Draw `rows` as pierre would inside `wrapper`, and say so. */
async function drawRows(wrapper: Element, rows: string): Promise<ShadowRoot> {
  const host = document.createElement("diffs-container");
  wrapper.append(host);
  // pierre's element attaches its own shadow root.
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.innerHTML = rows;
  await redrawn(host);
  return shadow;
}

/** Announce a render on `host` and let the repaint it schedules run. */
async function redrawn(host: Element): Promise<void> {
  await act(async () => {
    announceCodeRendered(host as HTMLElement);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

const texts = (registry: Map<string, FakeHighlight>, name: string) =>
  (registry.get(name)?.ranges ?? []).map((range) => range.toString());

const TS_FENCE =
  "Intro.\n\n```ts\nconst alpha = 1;\nconst bravo = 2;\nconst charlie = 3;\n```\n";
const TS_ROWS = `
  <div data-line="1"><span>const alpha = 1;</span></div>
  <div data-line="2"><span>const </span><span>bravo</span><span> = 2;</span></div>
  <div data-line="3"><span>const charlie = 3;</span></div>`;

describe("code highlights in the rendered view", () => {
  it("paints the characters a comment's columns name, and only those", async () => {
    const registry = stubHighlights();
    // Line 5 is "const bravo = 2;", and columns 7–11 cut "bravo" out of it.
    const { wrappers } = await renderDocument(TS_FENCE, [
      onLine("comment", 5, 7, 11),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    await drawRows(wrapper, TS_ROWS);
    expect(texts(registry, "spec-comment")).toEqual(["bravo"]);
    expect(wrapper.classList.contains("spec-mark-comment-block")).toBe(true);
    expect(wrapper.classList.contains("spec-code-painted")).toBe(true);
  });

  it("paints a list item's fence and a patch fence alike", async () => {
    const registry = stubHighlights();
    const body = [
      "- item",
      "",
      "  ```ts",
      "  const alpha = 1;",
      "  const bravo = 2;",
      "  ```",
      "",
      "```patch",
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old words",
      "+new words",
      "```",
      "",
    ].join("\n");
    // "  const bravo = 2;" 9–13 is "bravo"; "+new words" 6–10 is "words".
    const { wrappers } = await renderDocument(body, [
      onLine("comment", 5, 9, 13),
      onLine("comment", 15, 6, 10),
    ]);
    const [list, patch] = wrappers;
    if (list === undefined || patch === undefined) throw new Error("no fence");
    await drawRows(
      list,
      `<div data-line="1"><span>const alpha = 1;</span></div>
       <div data-line="2"><span>const bravo = 2;</span></div>`,
    );
    await drawRows(
      patch,
      `<pre data-diff="">
         <div data-line="1" data-line-type="context"><span>keep</span></div>
         <div data-line="2" data-line-type="change-deletion"><span>old words</span></div>
         <div data-line="2" data-line-type="change-addition"><span>new words</span></div>
       </pre>`,
    );
    const ranges = registry.get("spec-comment")?.ranges ?? [];
    expect(ranges.map((range) => range.toString()).sort()).toEqual([
      "bravo",
      "words",
    ]);
    const words = ranges.find((range) => range.toString() === "words");
    // "old words" holds the same word, on a line the comment is not on.
    const row = words?.startContainer.parentElement?.closest("[data-line]");
    expect(row?.getAttribute("data-line-type")).toBe("change-addition");
  });

  it("paints a draft as a draft", async () => {
    const registry = stubHighlights();
    const { wrappers } = await renderDocument(TS_FENCE, [
      onLine("draft", 5, 7, 11),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    await drawRows(wrapper, TS_ROWS);
    expect(texts(registry, "spec-draft")).toEqual(["bravo"]);
    expect(registry.has("spec-comment")).toBe(false);
  });

  it("paints again on the text nodes pierre's next render leaves", async () => {
    const registry = stubHighlights();
    const { wrappers } = await renderDocument(TS_FENCE, [
      onLine("comment", 5, 7, 11),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    const shadow = await drawRows(wrapper, TS_ROWS);
    const before = registry.get("spec-comment")?.ranges[0]?.startContainer;
    shadow.innerHTML = TS_ROWS;
    await redrawn(shadow.host);
    const after = registry.get("spec-comment")?.ranges[0];
    expect(after?.toString()).toBe("bravo");
    expect(after?.startContainer).not.toBe(before);
    expect(shadow.contains(after?.startContainer ?? null)).toBe(true);
  });

  it("keeps the wash for a whole-line comment that runs into the block", async () => {
    const registry = stubHighlights();
    // Lines 1–5 run from the paragraph into the fence; line 6, column 7–11
    // is "bravo".
    const body =
      "Para one\nstill para.\n\n```ts\nconst alpha = 1;\nconst bravo = 2;\n```\n";
    const whole: DisplayedAnnotation = {
      key: "c1",
      kind: "comment",
      item: ITEM,
      start: 1,
      end: 5,
      colStart: null,
      colEnd: null,
    };
    const { wrappers } = await renderDocument(body, [
      whole,
      onLine("draft", 6, 7, 11),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    await drawRows(
      wrapper,
      `<div data-line="1"><span>const alpha = 1;</span></div>
       <div data-line="2"><span>const bravo = 2;</span></div>`,
    );
    expect(texts(registry, "spec-draft")).toEqual(["bravo"]);
    expect(wrapper.classList.contains("spec-code-painted")).toBe(false);
  });

  it("keeps the wash while one of the block's comments cannot be painted", async () => {
    const registry = stubHighlights();
    // Line 5's row reads otherwise than its source, so its comment has no
    // characters to paint; line 4's does.
    const { wrappers } = await renderDocument(TS_FENCE, [
      onLine("comment", 4, 7, 11),
      onLine("comment", 5, 7, 11),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    await drawRows(
      wrapper,
      `<div data-line="1"><span>const alpha = 1;</span></div>
       <div data-line="2"><span>const BRAVO = 2;</span></div>`,
    );
    expect(texts(registry, "spec-comment")).toEqual(["alpha"]);
    expect(wrapper.classList.contains("spec-code-painted")).toBe(false);
  });

  it("keeps the whole-block wash where the browser has no highlights", async () => {
    const { wrappers } = await renderDocument(TS_FENCE, [
      onLine("comment", 5, 7, 11),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    await drawRows(wrapper, TS_ROWS);
    expect(wrapper.classList.contains("spec-mark-comment-block")).toBe(true);
    expect(wrapper.classList.contains("spec-code-painted")).toBe(false);
  });
});

/** Two of pierre's rows and their line numbers, in a shadow root of their own. */
function rowsWithNumbers(): ShadowRoot {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <code data-gutter="">
      <div data-column-number="1" data-line-index="0">1</div>
      <div data-column-number="2" data-line-index="1">2</div>
    </code>
    <code data-content="">
      <div data-line="1" data-line-index="0">alpha</div>
      <div data-line="2" data-line-index="1">bravo</div>
    </code>`;
  return shadow;
}

describe("whole-line marks", () => {
  const marksOf = (shadow: ShadowRoot, selector: string) =>
    [...shadow.querySelectorAll(selector)].map((el) =>
      el.getAttribute(LINE_MARK_ATTR),
    );

  it("marks each row and its line number with the kind that covers it", () => {
    const shadow = rowsWithNumbers();
    const [one, two] = shadow.querySelectorAll("[data-line]");
    if (one === undefined || two === undefined) throw new Error("no rows");
    markRows(
      shadow,
      new Map([
        [one, "draft"],
        [two, "comment"],
      ]),
    );
    expect(marksOf(shadow, "[data-line]")).toEqual(["draft", "comment"]);
    expect(marksOf(shadow, "[data-column-number]")).toEqual([
      "draft",
      "comment",
    ]);
  });

  it("unmarks the rows and numbers it is no longer handed", () => {
    const shadow = rowsWithNumbers();
    const [one, two] = shadow.querySelectorAll("[data-line]");
    if (one === undefined || two === undefined) throw new Error("no rows");
    markRows(
      shadow,
      new Map([
        [one, "draft"],
        [two, "comment"],
      ]),
    );
    markRows(shadow, new Map([[two, "comment"]]));
    expect(marksOf(shadow, "[data-line]")).toEqual([null, "comment"]);
    expect(marksOf(shadow, "[data-column-number]")).toEqual([null, "comment"]);
  });
});

describe("the highlight registry", () => {
  it("takes away only the ranges of the owner that leaves", () => {
    const registry = stubHighlights();
    const rendered = {};
    const source = {};
    const a = document.createRange();
    const b = document.createRange();
    // Switching views mounts the next surface before the last one unmounts.
    setCodeHighlights(source, { comment: [b], draft: [] });
    setCodeHighlights(rendered, { comment: [a], draft: [] });
    clearCodeHighlights(rendered);
    expect(registry.get("spec-comment")?.ranges).toEqual([b]);
    clearCodeHighlights(source);
    expect(registry.has("spec-comment")).toBe(false);
  });

  it("paints a comment over a draft where the two overlap", () => {
    const registry = stubHighlights();
    const owner = {};
    const range = document.createRange();
    try {
      setCodeHighlights(owner, { comment: [range], draft: [range] });
      expect(registry.get("spec-comment")?.priority).toBeGreaterThan(
        registry.get("spec-draft")?.priority ?? 0,
      );
    } finally {
      clearCodeHighlights(owner);
    }
  });

  it("takes as many ranges as long files can produce", () => {
    const registry = stubHighlights();
    const owner = {};
    // One range per row of every comment that spans rows: a few column
    // comments across files thousands of lines long.
    const range = document.createRange();
    const many = Array.from({ length: 200_000 }, () => range);
    try {
      setCodeHighlights(owner, { comment: many, draft: [] });
      expect(registry.get("spec-comment")?.ranges).toHaveLength(200_000);
    } finally {
      clearCodeHighlights(owner);
    }
  });
});
