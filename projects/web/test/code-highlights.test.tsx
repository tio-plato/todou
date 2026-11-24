import {
  act,
  cleanup,
  fireEvent,
  type RenderResult,
  waitFor,
} from "@testing-library/react";
import type { SpecCommentItem } from "@todou/shared";
import { useState } from "react";
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
import { FakeResizeObserver, resizePage } from "./fake-resize-observer.ts";
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

/** A comment or draft on whole lines `start`–`end`. */
function wholeLines(
  kind: "comment" | "draft",
  start: number,
  end: number,
): DisplayedAnnotation {
  const at = { start, end, colStart: null, colEnd: null };
  return kind === "comment"
    ? { key: `c${start}-${end}`, kind, item: ITEM, ...at }
    : {
        key: `d${start}-${end}`,
        kind,
        draft: {
          id: `d${start}-${end}`,
          anchor: {
            path: "plan.md",
            version: 1,
            line_start: start,
            line_end: end,
            col_start: null,
            col_end: null,
          },
          quote: "",
          body: "staged",
        },
        ...at,
      };
}

/** Each row's whole-line mark under `root`, in row order. */
const lineMarks = (root: ParentNode) =>
  [...root.querySelectorAll("[data-line]")].map((row) =>
    row.getAttribute(LINE_MARK_ATTR),
  );

/** The rendered document, its code wrappers waiting for their rows. */
async function renderDocument(
  body: string,
  annotations: DisplayedAnnotation[],
  compared?: {
    baselineBody: string;
    baselineAnnotations: DisplayedAnnotation[];
    wrappers?: string;
  },
) {
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={body}
      baselineBody={compared?.baselineBody}
      annotations={annotations}
      baselineAnnotations={compared?.baselineAnnotations}
      onStage={() => {}}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
  );
  const wrappers = await waitFor(() => {
    const els = view.container.querySelectorAll(
      compared?.wrappers ?? "[data-loc-content-start]",
    );
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

/** A block edited in place: v1 opens it two lines further down. */
const EDITED_BEFORE =
  "Intro.\n\nExtra paragraph.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n";
const EDITED_AFTER = "Intro.\n\n```ts\nconst a = 1;\nconst b = 3;\n```\n";
const EDITED_ROWS = `
  <div data-line="1" data-line-type="context"><span>const a = 1;</span></div>
  <div data-line="2" data-line-type="change-deletion"><span>const b = 2;</span></div>
  <div data-line="2" data-line-type="change-addition"><span>const b = 3;</span></div>`;

describe("code highlights in the rendered view", () => {
  it("marks a deleted row and a current one in the same block", async () => {
    stubHighlights();
    // v1's line 7 is the deleted "const b = 2;"; the current line 5 is the
    // "const b = 3;" that replaced it.
    const { wrappers } = await renderDocument(
      EDITED_AFTER,
      [wholeLines("draft", 5, 5)],
      {
        baselineBody: EDITED_BEFORE,
        baselineAnnotations: [wholeLines("comment", 7, 7)],
      },
    );
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    const shadow = await drawRows(wrapper, EDITED_ROWS);
    expect(lineMarks(shadow)).toEqual([null, "comment", "draft"]);
  });

  it("paints the characters of a deleted row a baseline comment names", async () => {
    const registry = stubHighlights();
    // Columns 7–11 of v1's line 7, "const b = 2;", are "b = 2".
    const { wrappers } = await renderDocument(EDITED_AFTER, [], {
      baselineBody: EDITED_BEFORE,
      baselineAnnotations: [onLine("comment", 7, 7, 11)],
    });
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    await drawRows(wrapper, EDITED_ROWS);
    expect(texts(registry, "spec-comment")).toEqual(["b = 2"]);
  });

  it("marks the row of a restored code block a baseline comment covers", async () => {
    stubHighlights();
    // v1's line 5 is "more();", the second row of the block v2 removed.
    const { wrappers } = await renderDocument("Intro.\n\nOutro.\n", [], {
      baselineBody: "Intro.\n\n```ts\nold();\nmore();\n```\n\nOutro.\n",
      baselineAnnotations: [wholeLines("comment", 5, 5)],
      wrappers: "[data-old-loc].markdown-fence",
    });
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    const shadow = await drawRows(
      wrapper,
      `<div data-line="1"><span>old();</span></div>
       <div data-line="2"><span>more();</span></div>`,
    );
    expect(lineMarks(shadow)).toEqual([null, "comment"]);
  });

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

  it("marks the rows a whole-line comment covers, and drops the wash", async () => {
    stubHighlights();
    // Line 5 is "const bravo = 2;", the second of the block's three rows.
    const { wrappers } = await renderDocument(TS_FENCE, [
      wholeLines("comment", 5, 5),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    const shadow = await drawRows(wrapper, TS_ROWS);
    expect(lineMarks(shadow)).toEqual([null, "comment", null]);
    expect(wrapper.classList.contains("spec-code-painted")).toBe(true);
  });

  it("marks whole-line rows where the browser has no highlights", async () => {
    // Line 5 is "const bravo = 2;"; an attribute needs no highlight API.
    const { wrappers } = await renderDocument(TS_FENCE, [
      wholeLines("comment", 5, 5),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    const shadow = await drawRows(wrapper, TS_ROWS);
    expect(lineMarks(shadow)).toEqual([null, "comment", null]);
    expect(wrapper.classList.contains("spec-code-painted")).toBe(true);
  });

  // A whole-line comment reaching into a block from the prose above it used
  // to keep the block's wash, having no characters of its own to paint
  // there; the rows it covers now carry it, so the wash steps aside.
  it("marks the rows a whole-line comment runs into from the prose", async () => {
    const registry = stubHighlights();
    // Lines 1–5 run from the paragraph into the fence; line 6, column 7–11
    // is "bravo".
    const body =
      "Para one\nstill para.\n\n```ts\nconst alpha = 1;\nconst bravo = 2;\n```\n";
    const { wrappers } = await renderDocument(body, [
      wholeLines("comment", 1, 5),
      onLine("draft", 6, 7, 11),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    const shadow = await drawRows(
      wrapper,
      `<div data-line="1"><span>const alpha = 1;</span></div>
       <div data-line="2"><span>const bravo = 2;</span></div>`,
    );
    expect(texts(registry, "spec-draft")).toEqual(["bravo"]);
    expect(lineMarks(shadow)).toEqual(["comment", null]);
    expect(wrapper.classList.contains("spec-code-painted")).toBe(true);
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

/** A block of six rows of code: source lines 4–9 are its rows 1–6. */
const SIX_FENCE = `Intro.\n\n\`\`\`ts\n${[1, 2, 3, 4, 5, 6]
  .map((k) => `const a${k} = ${k};`)
  .join("\n")}\n\`\`\`\n`;
const SIX_ROWS = [1, 2, 3, 4, 5, 6]
  .map((k) => `<div data-line="${k}"><span>const a${k} = ${k};</span></div>`)
  .join("\n");

/**
 * Lay the page out as a browser would, as far as chips care: each of
 * pierre's rows 20px below the last, counted by its place among its shadow
 * root's rows rather than by `data-line`, which a deleted row and the row
 * replacing it share; a code block's wrapper 8px above its first row, and
 * everything else, the container included, at 0. `shift` moves the rows
 * and the wrappers down, as content arriving above them would.
 */
function layOutRows(shift: () => number = () => 0) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      let top = 0;
      if (this.hasAttribute("data-line")) {
        const root = this.getRootNode() as ParentNode;
        top =
          shift() +
          200 +
          20 * [...root.querySelectorAll("[data-line]")].indexOf(this);
      } else if (this.matches(".markdown-fence")) {
        top = shift() + 192;
      }
      return new DOMRect(0, top, 600, 20);
    },
  );
}

/** Whether each chip's popover is open, top to bottom. */
function expanded(view: Pick<RenderResult, "getAllByRole">) {
  return view
    .getAllByRole("button", { name: /^\d+ comments?$/ })
    .map((el) => el.getAttribute("aria-expanded"));
}

/**
 * The document with annotations a test can change, as staging a draft or a
 * comment arriving would, its code wrappers drawn with `SIX_ROWS`.
 */
async function renderLive(body: string, initial: DisplayedAnnotation[]) {
  let annotate: (next: DisplayedAnnotation[]) => void = () => {};
  function Live() {
    const [annotations, setAnnotations] = useState(initial);
    annotate = setAnnotations;
    return (
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={body}
        annotations={annotations}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />
    );
  }
  const view = renderWithProviders(<Live />);
  const wrapper = await waitFor(() => {
    const el = view.container.querySelector("[data-loc-content-start]");
    if (el === null) throw new Error("not rendered");
    return el;
  });
  await drawRows(wrapper, SIX_ROWS);
  return { view, annotate: (next: DisplayedAnnotation[]) => annotate(next) };
}

/** The open popover, once it is. */
async function openPopover(chip: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(chip);
  return await waitFor(() => {
    const el = document.querySelector("[data-slot='popover-content']");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
}

/** Close `popover` with the reader's own key, before the test ends. */
async function closePopover(popover: HTMLElement): Promise<void> {
  fireEvent.keyDown(popover, { key: "Escape" });
  await waitFor(() =>
    expect(document.querySelector("[data-slot='popover-content']")).toBeNull(),
  );
}

/** Every element `scrollIntoView` is called on from now. */
function revealsSpy(): Element[] {
  const reveals: Element[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
  ) {
    reveals.push(this);
  });
  return reveals;
}

/** The locate control labelled `label` in `popover`. */
function locateIn(popover: HTMLElement, label: string): HTMLElement {
  const locate = [
    ...popover.querySelectorAll<HTMLElement>(
      "button[title='Scroll to what this points at']",
    ),
  ].find((button) => button.textContent === label);
  if (locate === undefined) throw new Error(`no ${label} control`);
  return locate;
}

/** Each chip's top and how many annotations it holds, top to bottom. */
function chipsOf(view: Pick<RenderResult, "queryAllByRole">) {
  return view
    .queryAllByRole("button", { name: /^\d+ comments?$/ })
    .map((chip) => [
      chip.style.top,
      Number.parseInt(chip.getAttribute("aria-label") ?? "", 10),
    ]);
}

describe("chips on code rows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    FakeResizeObserver.instances = [];
  });

  it("hangs each annotation's chip by the row it is on", async () => {
    layOutRows();
    // Line 5 is the block's second row; line 8, columns 7–8, its fifth.
    const { view, wrappers } = await renderDocument(SIX_FENCE, [
      wholeLines("comment", 5, 5),
      onLine("comment", 8, 7, 8),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    await drawRows(wrapper, SIX_ROWS);
    await waitFor(() =>
      expect(chipsOf(view)).toEqual([
        ["220px", 1],
        ["280px", 1],
      ]),
    );
  });

  it("joins a row's chip to the one kept above it within a chip's height", async () => {
    layOutRows();
    // Rows 4, 3 and 2, listed bottom up as no order promises otherwise: the
    // chip is kept at the top one, and the bottom one is two rows below it.
    const { view, wrappers } = await renderDocument(SIX_FENCE, [
      wholeLines("comment", 7, 7),
      wholeLines("draft", 6, 6),
      wholeLines("comment", 5, 5),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    await drawRows(wrapper, SIX_ROWS);
    await waitFor(() =>
      expect(chipsOf(view)).toEqual([
        ["220px", 2],
        ["260px", 1],
      ]),
    );
  });

  it("hangs a baseline annotation by the deleted row it is on", async () => {
    layOutRows();
    // v1's line 7 is the deleted "const b = 2;", the block's second row.
    const { view, wrappers } = await renderDocument(EDITED_AFTER, [], {
      baselineBody: EDITED_BEFORE,
      baselineAnnotations: [wholeLines("comment", 7, 7)],
    });
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    await drawRows(wrapper, EDITED_ROWS);
    await waitFor(() => expect(chipsOf(view)).toEqual([["220px", 1]]));
  });

  it("hangs a baseline annotation by its row of a restored block", async () => {
    layOutRows();
    // v1's line 5 is "more();", the second row of the block v2 removed.
    const { view, wrappers } = await renderDocument("Intro.\n\nOutro.\n", [], {
      baselineBody: "Intro.\n\n```ts\nold();\nmore();\n```\n\nOutro.\n",
      baselineAnnotations: [wholeLines("comment", 5, 5)],
      wrappers: "[data-old-loc].markdown-fence",
    });
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    await drawRows(
      wrapper,
      `<div data-line="1"><span>old();</span></div>
       <div data-line="2"><span>more();</span></div>`,
    );
    await waitFor(() => expect(chipsOf(view)).toEqual([["220px", 1]]));
  });

  it("scrolls to an annotation's own row from the chip it joined", async () => {
    layOutRows();
    // Rows 2 and 3, one chip between them.
    const { view, wrappers } = await renderDocument(SIX_FENCE, [
      wholeLines("comment", 5, 5),
      wholeLines("draft", 6, 6),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    const shadow = await drawRows(wrapper, SIX_ROWS);
    const [chip] = await view.findAllByRole("button", {
      name: /^\d+ comments?$/,
    });
    if (chip === undefined) throw new Error("no chip");
    const popover = await openPopover(chip);
    const reveals = revealsSpy();
    fireEvent.click(locateIn(popover, "L6"));
    expect(reveals).toEqual([shadow.querySelector("[data-line='3']")]);
    await closePopover(popover);
  });

  it("keeps an open popover through its chip moving and hanging anew", async () => {
    let shift = 0;
    layOutRows(() => shift);
    const { view, annotate } = await renderLive(SIX_FENCE, [
      wholeLines("draft", 5, 5),
      wholeLines("draft", 6, 6),
    ]);
    // Rows 2 and 3 share the chip at row 2.
    const chip = await view.findByRole("button", {
      name: "2 comments",
    });
    const popover = await openPopover(chip);
    // Content arriving above moves the rows down.
    shift = 40;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(chipsOf(view)).toEqual([["260px", 2]]);
    expect(expanded(view)).toEqual(["true"]);
    // The draft on row 2 goes; row 3's hangs at its own row.
    act(() => annotate([wholeLines("draft", 6, 6)]));
    expect(chipsOf(view)).toEqual([["280px", 1]]);
    expect(expanded(view)).toEqual(["true"]);
    await closePopover(popover);
  });

  it("never hands an open popover to an annotation new to the page", async () => {
    layOutRows();
    const drafts = [wholeLines("draft", 5, 5), wholeLines("draft", 6, 6)];
    const { view, annotate } = await renderLive(SIX_FENCE, drafts);
    const chip = await view.findByRole("button", {
      name: "2 comments",
    });
    const popover = await openPopover(chip);
    // A comment arrives on the opening fence, which no row shows: it hangs
    // at the code block's top, where the open chip hung before pierre drew.
    act(() => annotate([onLine("comment", 3, 1, 3), ...drafts]));
    expect(chipsOf(view)).toEqual([
      ["192px", 1],
      ["220px", 2],
    ]);
    expect(expanded(view)).toEqual(["false", "true"]);
    await closePopover(popover);
  });

  it("keeps the open popover of a row's chip joining its block's under a shut fold", async () => {
    layOutRows();
    // Columns on line 4, the opening fence, hang by the code block, which
    // shows no row for them; line 9 is its fifth row.
    const body = `<details>\n<summary>More</summary>\n\n${SIX_FENCE.slice("Intro.\n\n".length)}\n</details>\n`;
    const { view } = await renderLive(body, [
      onLine("comment", 4, 1, 3),
      wholeLines("draft", 9, 9),
    ]);
    await waitFor(() =>
      expect(chipsOf(view)).toEqual([
        ["192px", 1],
        ["280px", 1],
      ]),
    );
    const [, rowChip] = view.getAllByRole("button", {
      name: /^\d+ comments?$/,
    });
    if (rowChip === undefined) throw new Error("no chip");
    const popover = await openPopover(rowChip);
    const fold = view.container.querySelector("details");
    if (fold === null) throw new Error("no fold");
    // Shut, both hang by the fold, in one chip: the one being read.
    act(() => {
      fold.removeAttribute("open");
      fold.dispatchEvent(new Event("toggle"));
    });
    expect(chipsOf(view)).toEqual([["0px", 2]]);
    expect(expanded(view)).toEqual(["true"]);
    await closePopover(popover);
  });

  it("scrolls to an annotation's row that pierre drew again since the last layout", async () => {
    layOutRows();
    const { view, wrappers } = await renderDocument(SIX_FENCE, [
      wholeLines("comment", 5, 5),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    const shadow = await drawRows(wrapper, SIX_ROWS);
    const [chip] = await view.findAllByRole("button", {
      name: /^\d+ comments?$/,
    });
    if (chip === undefined) throw new Error("no chip");
    const popover = await openPopover(chip);
    // pierre draws the rows again, and no frame has passed since.
    shadow.innerHTML = SIX_ROWS;
    const reveals = revealsSpy();
    fireEvent.click(locateIn(popover, "L5"));
    expect(reveals).toEqual([shadow.querySelector("[data-line='2']")]);
    await closePopover(popover);
  });

  it("keeps holding an annotation's row that pierre draws again after the jump", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    layOutRows();
    const { view, wrappers } = await renderDocument(SIX_FENCE, [
      wholeLines("comment", 5, 5),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    const shadow = await drawRows(wrapper, SIX_ROWS);
    const [chip] = await view.findAllByRole("button", {
      name: /^\d+ comments?$/,
    });
    if (chip === undefined) throw new Error("no chip");
    const popover = await openPopover(chip);
    const reveals = revealsSpy();
    const jumpedTo = shadow.querySelector("[data-line='2']");
    fireEvent.click(locateIn(popover, "L5"));
    // pierre draws the rows again, and the page grows before a frame passes.
    shadow.innerHTML = SIX_ROWS;
    act(() => resizePage());
    // By identity: the row drawn again is equal to the one it replaced.
    expect(reveals).toHaveLength(2);
    expect(reveals[0]).toBe(jumpedTo);
    expect(reveals[1]).toBe(shadow.querySelector("[data-line='2']"));
    await closePopover(popover);
  });

  it("glides to an annotation's row screens away, finding it again as pierre draws it anew", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    // A tall page whose code block sits 2800 down, scrolled to its top.
    const page = { y: 0 };
    layOutRows(() => 2_800 - page.y);
    const { view, wrappers } = await renderDocument(SIX_FENCE, [
      wholeLines("comment", 5, 5),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    const shadow = await drawRows(wrapper, SIX_ROWS);
    const [chip] = await view.findAllByRole("button", {
      name: /^\d+ comments?$/,
    });
    if (chip === undefined) throw new Error("no chip");
    const popover = await openPopover(chip);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => page.y);
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
      10_000,
    );
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
      800,
    );
    const glided: number[] = [];
    vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
      page.y = Number(args[1]);
      glided.push(page.y);
    });
    const reveals = revealsSpy();
    // Frames as the test runs them: each frame's callback, then the
    // placement once it is drawn, on the clock the glide reads.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.useFakeTimers({
      toFake: [
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "setTimeout",
        "clearTimeout",
      ],
    });
    const frame = (ms = 16) => {
      now += ms;
      vi.advanceTimersByTime(17);
      fireEvent.scroll(window);
    };
    try {
      fireEvent.click(locateIn(popover, "L5"));
      for (let i = 0; i < 3; i++) frame();
      expect(reveals).toEqual([]);
      // pierre draws the rows again on the way.
      shadow.innerHTML = SIX_ROWS;
      for (let i = 0; i < 3; i++) frame();
      expect(reveals).toEqual([]);
      expect(glided).toHaveLength(6);
      for (let i = 1; i < glided.length; i++)
        expect(glided[i]).toBeGreaterThan(glided[i - 1]);
      frame(1_000);
      expect(reveals).toEqual([shadow.querySelector("[data-line='2']")]);
    } finally {
      vi.useRealTimers();
    }
    await closePopover(popover);
  });

  it("hangs a row's chip by the fold shut over it, and opens it to scroll to the row", async () => {
    layOutRows();
    // Line 6 is the block's second row, inside the fold.
    const body = `<details>\n<summary>More</summary>\n\n${SIX_FENCE.slice("Intro.\n\n".length)}\n</details>\n`;
    const { view, wrappers } = await renderDocument(body, [
      wholeLines("comment", 6, 6),
    ]);
    const [wrapper] = wrappers;
    if (wrapper === undefined) throw new Error("no fence");
    const shadow = await drawRows(wrapper, SIX_ROWS);
    await waitFor(() => expect(chipsOf(view)).toEqual([["220px", 1]]));
    const fold = wrapper.closest("details");
    if (fold === null) throw new Error("no fold");
    // The reader shuts it: every row in it measures 0 in a browser, and the
    // chip goes up to the fold, at 0 here.
    act(() => {
      fold.removeAttribute("open");
      fold.dispatchEvent(new Event("toggle"));
    });
    expect(chipsOf(view)).toEqual([["0px", 1]]);
    const [chip] = view.getAllByRole("button", {
      name: /^\d+ comments?$/,
    });
    if (chip === undefined) throw new Error("no chip");
    const popover = await openPopover(chip);
    const reveals = revealsSpy();
    fireEvent.click(locateIn(popover, "L6"));
    expect(fold.hasAttribute("open")).toBe(true);
    expect(reveals).toEqual([shadow.querySelector("[data-line='2']")]);
    await closePopover(popover);
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
