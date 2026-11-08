import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { IssueListItem } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { projectsQuery } from "../src/api/queries.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { rehypeSourceLines } from "../src/lib/rehype-source-lines.ts";
import {
  anchorForSelection,
  anchorRangeForNode,
} from "../src/lib/selection-anchor.ts";
import { selectionEndpoints } from "../src/lib/selection-endpoints.ts";
import {
  buildSegmentIndex,
  type SegmentIndex,
} from "../src/lib/spec-source-index.ts";
import { POINTER_FINE } from "../src/lib/use-media-query.ts";
import { FENCE_SHAPES } from "./fence-shapes.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

// Code blocks render through pierre's CodeView, drawn in a shadow root
// happy-dom cannot lay out. The tests that need its rows build them by hand
// inside the real stamped wrapper, so a plain pre>code stands in for it.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

/** Render, select `pick`'s range, and return the floating comment button. */
async function stageSelection(
  body: string,
  pick: (container: HTMLElement) => {
    node: Node;
    from: number;
    to: number;
    /** Defaults to `node`; give one to select across two blocks. */
    endNode?: Node;
  },
  options: { client?: QueryClient; ready?: string } = {},
) {
  const onStage = vi.fn();
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={body}
      annotations={[]}
      onStage={onStage}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
    options.client,
  );
  const container = await waitFor(() => {
    const el = view.getByTestId("annotated-markdown");
    if (!el.querySelector(options.ready ?? "[data-loc]")) {
      throw new Error("not rendered");
    }
    return el;
  });
  const { node, from, to, endNode } = pick(container);
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(endNode ?? node, to);
  const selection = window.getSelection();
  if (!selection) throw new Error("no selection support");
  selection.removeAllRanges();
  // Applying the range is the whole trigger: `selectionchange` is what the
  // component listens to, and no mouse event is involved (T-384).
  selection.addRange(range);
  const button = await view.findByText(/Comment L/);
  return { view, container, onStage, button };
}

/**
 * The bracketed part of `pick` in the one text node of `container` holding
 * `pick` without its brackets: `"a [b] c"` selects the `b` of `a b c`.
 */
function bracketedIn(
  container: HTMLElement,
  pick: string,
): { node: Node; from: number; to: number } {
  const open = pick.indexOf("[");
  const close = pick.indexOf("]");
  const plain = pick.replace("[", "").replace("]", "");
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const at = (node as Text).data.indexOf(plain);
    if (at >= 0) return { node, from: at + open, to: at + close - 1 };
  }
  throw new Error(`no text node holds ${JSON.stringify(plain)}`);
}

/**
 * Let the rAF-batched recompute run and React commit it. Assertions that
 * something is *still* on screen are worthless without it: they would pass
 * in the frame before the component has looked at the selection at all.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

// T-60: the spec annotation flow died in two places — the comment button's
// appearance re-rendered the markdown with a fresh component-override map
// (React remounts overridden elements, killing the text selection anchored
// in them), and the button's own mouseup bubbled into the container handler,
// unmounting it before click could fire.

describe("MarkdownView DOM stability (T-60 root cause A)", () => {
  it("keeps overridden elements' DOM nodes across re-renders", async () => {
    const md = "First paragraph.\n\nSecond paragraph.";
    // MarkdownView reads the reference config through react-query now, so
    // a provider is part of its contract (the app root always has one).
    const client = testQueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <MarkdownView slug="p" issueNumber={1}>
          {md}
        </MarkdownView>
      </QueryClientProvider>,
    );
    const before = view.container.querySelector("p");
    expect(before).not.toBeNull();
    // Same props, new parent render — overridden <p> must not remount.
    view.rerender(
      <QueryClientProvider client={client}>
        <MarkdownView slug="p" issueNumber={1}>
          {md}
        </MarkdownView>
      </QueryClientProvider>,
    );
    const after = view.container.querySelector("p");
    expect(after).toBe(before);
  });
});

describe("AnnotatedMarkdown floating button (T-60 root cause B)", () => {
  function selectParagraph(container: HTMLElement): void {
    const p = container.querySelector("p[data-loc]");
    if (!p?.firstChild) throw new Error("no stamped paragraph to select");
    const range = document.createRange();
    range.selectNodeContents(p);
    const selection = window.getSelection();
    if (!selection) throw new Error("jsdom selection unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
  }

  it("survives its own press and stages even after the selection collapses", async () => {
    const onStage = vi.fn();
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"Alpha beta gamma.\n\nDelta epsilon."}
        annotations={[]}
        onStage={onStage}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("p[data-loc]")) throw new Error("not rendered");
      return el;
    });

    selectParagraph(container);
    const button = await view.findByText(/Comment L1/);

    // The real browser clears the selection on the button's press
    // (prevented in production by preventDefault, but happy-dom runs no
    // such default anyway); what must hold is that the button's own press
    // never feeds the trigger and unmounts it.
    fireEvent.pointerDown(button);
    window.getSelection()?.removeAllRanges();
    fireEvent.pointerUp(button);
    await settle();
    expect(view.queryByText(/Comment L1/)).not.toBeNull();

    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 1,
      colEnd: 17,
    });
  });

  it("still clears the button once the selection genuinely goes", async () => {
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"Alpha beta gamma."}
        annotations={[]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("p[data-loc]")) throw new Error("not rendered");
      return el;
    });

    selectParagraph(container);
    await view.findByText(/Comment L1/);

    // A click elsewhere in the document collapses the selection, and
    // nothing at all is dispatched inside the container.
    window.getSelection()?.removeAllRanges();
    await waitFor(() => {
      expect(view.queryByText(/Comment L1/)).toBeNull();
    });
  });
});

// T-142: a selection that stops inside a line anchors to the columns it
// actually covers, instead of claiming the whole block.
describe("AnnotatedMarkdown column anchors (T-142)", () => {
  it("anchors to the selected columns inside a paragraph", async () => {
    const { onStage, button } = await stageSelection(
      "The quick brown fox jumps.\n",
      (container) => {
        const node = container.querySelector("p[data-loc]")?.firstChild;
        if (!node) throw new Error("no paragraph");
        return { node, from: 4, to: 9 };
      },
    );
    expect(button.textContent).toContain("L1:5–9");
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 5,
      colEnd: 9,
    });
  });

  it("anchors inside one table cell, on that row's source line", async () => {
    const { onStage, button } = await stageSelection(
      "| a | b |\n| --- | --- |\n| one | two |\n",
      (container) => {
        const cells = container.querySelectorAll("tbody td");
        const node = cells[1]?.firstChild;
        if (!node) throw new Error("no second cell");
        return { node, from: 0, to: 3 };
      },
    );
    fireEvent.click(button);
    // "| one | two |" — the word "two" occupies columns 9 through 11.
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 3,
      lineEnd: 3,
      colStart: 9,
      colEnd: 11,
    });
  });

  it("spans the whole line when the selection does", async () => {
    const { onStage, button } = await stageSelection(
      "intro\n\nsecond paragraph here\n",
      (container) => {
        const node =
          container.querySelectorAll("p[data-loc]")[1]?.firstChild ?? null;
        if (!node) throw new Error("no second paragraph");
        return { node, from: 0, to: "second paragraph here".length };
      },
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 3,
      lineEnd: 3,
      colStart: 1,
      colEnd: 21,
    });
  });

  it("anchors a selection on a block's element boundaries to its text", async () => {
    const onStage = vi.fn();
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"Alpha beta gamma.\n"}
        annotations={[]}
        onStage={onStage}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("p[data-loc]")) throw new Error("not rendered");
      return el;
    });
    const p = container.querySelector("p[data-loc]");
    if (!p) throw new Error("no paragraph");
    const range = document.createRange();
    range.selectNodeContents(p);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.click(await view.findByText(/Comment L1/));
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 1,
      colEnd: 17,
    });
  });
});

// T-169: an endpoint left sitting on a line's newline used to anchor at
// column len+1, which the server rejects — the inclusive contract has no
// way to say "one past the end".
describe("AnnotatedMarkdown line-end columns (T-169)", () => {
  // A soft break keeps both lines in one paragraph, so a single text node
  // holds the newline an endpoint can land on. Line 1 is 4 characters.
  const SOFT_WRAP = "甲乙丙,\n丁戊己。\n";

  function paragraphText(container: HTMLElement): Node {
    const node = container.querySelector("p[data-loc]")?.firstChild;
    if (!node) throw new Error("no paragraph");
    return node;
  }

  const inParagraph = (from: number, to: number) => (c: HTMLElement) => ({
    node: paragraphText(c),
    from,
    to,
  });

  it("moves a start at the end of a line to column 1 of the next", async () => {
    const { onStage, button } = await stageSelection(
      SOFT_WRAP,
      inParagraph(4, 7),
    );
    expect(button.textContent).toContain("L2:1–2");
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 2,
      lineEnd: 2,
      colStart: 1,
      colEnd: 2,
    });
  });

  it("moves an end past the line's newline back onto its last character", async () => {
    const { onStage, button } = await stageSelection(
      SOFT_WRAP,
      inParagraph(0, 5),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 1,
      colEnd: 4,
    });
  });

  it("falls back to whole lines when the selection is only a newline", async () => {
    const { onStage, button } = await stageSelection(
      SOFT_WRAP,
      inParagraph(4, 5),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 2,
      colStart: null,
      colEnd: null,
    });
  });

  it("anchors one character to one column at both ends", async () => {
    const { onStage, button } = await stageSelection(
      SOFT_WRAP,
      inParagraph(0, 1),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 1,
      colEnd: 1,
    });
  });

  it("never puts a column on a blank line the selection spans", async () => {
    const { onStage, button } = await stageSelection(
      "one\n\nthree\n",
      (container) => {
        const paragraphs = container.querySelectorAll("p[data-loc]");
        const start = paragraphs[0]?.firstChild;
        const end = paragraphs[1]?.firstChild;
        if (!start || !end) throw new Error("no paragraphs");
        return { node: start, from: 0, to: 5, endNode: end };
      },
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 3,
      colStart: 1,
      colEnd: 5,
    });
  });

  it("offers no anchor at all for a collapsed selection", async () => {
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={SOFT_WRAP}
        annotations={[]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("p[data-loc]")) throw new Error("not rendered");
      return el;
    });
    const node = container.querySelector("p[data-loc]")?.firstChild;
    if (!node) throw new Error("no paragraph");
    const range = document.createRange();
    range.setStart(node, 3);
    range.setEnd(node, 3);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    await settle();
    expect(view.queryByText(/Comment L/)).toBeNull();
  });
});

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: 1,
    name: "In Progress",
    category: "open",
    color: "#bf8700",
    position: 2,
    is_default: false,
  },
  author: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
});

// Reverse mapping (selection → source line and column) block kind by block
// kind. What matters per kind is whether it may carry columns at all: the
// ones that can must be exact, and the ones that cannot must widen to the
// whole line rather than name a column they cannot prove.
describe("AnnotatedMarkdown reverse mapping by block kind", () => {
  it("anchors inside one list item, on that item's source line", async () => {
    const { onStage, button } = await stageSelection(
      "- alpha one\n- beta two\n",
      (container) => {
        const node = container.querySelectorAll("li[data-loc]")[1]?.firstChild;
        if (!node) throw new Error("no second item");
        return { node, from: 0, to: 4 };
      },
    );
    fireEvent.click(button);
    // "- beta two" — the word "beta" occupies columns 3 through 6.
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 2,
      lineEnd: 2,
      colStart: 3,
      colEnd: 6,
    });
  });

  it("anchors a word on a blockquote's continuation line to its columns", async () => {
    const { onStage, button } = await stageSelection(
      "> first line\n> second line\n",
      (container) => {
        const node = container.querySelector("blockquote p")?.firstChild;
        if (!node) throw new Error("no quoted paragraph");
        return { node, from: 11, to: 17 };
      },
    );
    fireEvent.click(button);
    // "> second line" — the word "second" occupies columns 3 through 8; the
    // "> " in front of it is the quote's, not the paragraph's.
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 2,
      lineEnd: 2,
      colStart: 3,
      colEnd: 8,
    });
  });

  // Each of these makes a text node's source longer than the text it shows,
  // which used to widen the anchor to the whole paragraph. The brackets mark
  // the selection in the rendered text.
  it.each([
    [
      "a list item's continuation line",
      "- item one\n  continues here\n",
      "[continues] here",
      { lineStart: 2, lineEnd: 2, colStart: 3, colEnd: 11 },
    ],
    [
      "a word after an escape",
      "a \\* b c\n",
      "* [b] c",
      { lineStart: 1, lineEnd: 1, colStart: 6, colEnd: 6 },
    ],
    [
      "an escaped character and the word after it",
      "a \\* b c\n",
      "a [* b] c",
      { lineStart: 1, lineEnd: 1, colStart: 3, colEnd: 6 },
    ],
    [
      "a word after a character reference",
      "x &amp; y z\n",
      "& [y] z",
      { lineStart: 1, lineEnd: 1, colStart: 9, colEnd: 9 },
    ],
    [
      "a character reference",
      "x &amp; y z\n",
      "x [&] y",
      { lineStart: 1, lineEnd: 1, colStart: 3, colEnd: 7 },
    ],
    [
      "a word after a soft break with a space before it",
      "foo \nbar baz\n",
      "bar [baz]",
      { lineStart: 2, lineEnd: 2, colStart: 5, colEnd: 7 },
    ],
  ])("anchors %s to its own columns", async (_name, body, pick, anchor) => {
    const { onStage, button } = await stageSelection(body, (container) =>
      bracketedIn(container, pick),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith(anchor);
  });

  it("starts past a quote's prefix a selection starting on its line break", async () => {
    // The soft break shows as a space, and selecting it with "tw" names the
    // second line's text, not the "> " in front of it.
    const { onStage, button } = await stageSelection(
      "> one\n> two three\n",
      (container) => bracketedIn(container, "one[\ntw]o"),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 2,
      lineEnd: 2,
      colStart: 3,
      colEnd: 4,
    });
  });

  it("gives up columns on a line holding a ref chip", async () => {
    const client = testQueryClient();
    client.setQueryData(
      issueRefQuery("p", 12).queryKey,
      refItem(12, "A referenced issue"),
    );
    client.setQueryData(projectsQuery.queryKey, [
      {
        id: 1,
        slug: "p",
        name: "p",
        description: "",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { container, onStage, button } = await stageSelection(
      "see [#12](/projects/1/issues/12) here\n",
      (c) => {
        const node = c.querySelector("p[data-loc]")?.firstChild;
        if (!node) throw new Error("no paragraph");
        return { node, from: 0, to: 3 };
      },
      { client, ready: "a[data-issue-link]" },
    );
    // The chip renders the issue's title where the source says "#12", so
    // rendered offsets no longer line up with source ones at all.
    expect(container.textContent).toContain("A referenced issue");
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: null,
      colEnd: null,
    });
  });
});

// T-164: pierre renders code inside an open shadow root, and the legacy
// Selection API clamps any endpoint landing in there onto the host.
// Dragging backwards out of a code block is the loud case — the selection
// reports itself collapsed while `toString()` still returns the code, so
// the comment button never appeared at all.
describe("selection endpoints across a shadow boundary (T-164)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A container holding one paragraph and one open shadow root. */
  function scene() {
    const container = document.createElement("div");
    const prose = document.createElement("p");
    prose.textContent = "abc";
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const row = document.createElement("span");
    row.textContent = "$ hello";
    shadow.append(row);
    container.append(prose, host);
    document.body.append(container);
    return {
      container,
      host,
      shadow,
      prose: prose.firstChild as Node,
      code: row.firstChild as Node,
    };
  }

  type StaticRangeLike = {
    startContainer: Node;
    startOffset: number;
    endContainer: Node;
    endOffset: number;
    collapsed: boolean;
  };

  /** A Selection whose legacy view is whatever the browser clamped it to. */
  function stubSelection(over: {
    anchorNode: Node;
    anchorOffset?: number;
    focusNode: Node;
    focusOffset?: number;
    isCollapsed: boolean;
    composed?: StaticRangeLike[];
    onComposed?: (options: { shadowRoots?: ShadowRoot[] }) => void;
  }): Selection {
    const range = document.createRange();
    range.setStart(over.anchorNode, over.anchorOffset ?? 0);
    range.setEnd(over.focusNode, over.focusOffset ?? 0);
    const composed = over.composed;
    return {
      anchorNode: over.anchorNode,
      anchorOffset: over.anchorOffset ?? 0,
      focusNode: over.focusNode,
      focusOffset: over.focusOffset ?? 0,
      isCollapsed: over.isCollapsed,
      rangeCount: 1,
      getRangeAt: () => range,
      // What the trigger reads to tell an empty selection from a live one,
      // and the legacy collapse is exactly the lie it must not believe.
      toString: () => "selected",
      ...(composed === undefined
        ? {}
        : {
            getComposedRanges: (
              options: { shadowRoots?: ShadowRoot[] } = {},
            ) => {
              over.onComposed?.(options);
              return composed;
            },
          }),
    } as unknown as Selection;
  }

  it("falls back to the legacy endpoints where the API is missing", () => {
    const { container, prose, host } = scene();
    const endpoints = selectionEndpoints(
      stubSelection({
        anchorNode: prose,
        anchorOffset: 1,
        focusNode: host,
        isCollapsed: false,
      }),
      container,
    );
    expect(endpoints?.start).toEqual({ node: prose, offset: 1 });
    expect(endpoints?.end).toEqual({ node: host, offset: 0 });
    expect(endpoints?.collapsed).toBe(false);
  });

  it("hands every open shadow root under the container to the API", () => {
    const { container, prose, shadow } = scene();
    let seen: ShadowRoot[] | undefined;
    selectionEndpoints(
      stubSelection({
        anchorNode: prose,
        focusNode: prose,
        isCollapsed: false,
        composed: [],
        onComposed: (options) => {
          seen = options.shadowRoots;
        },
      }),
      container,
    );
    expect(seen).toEqual([shadow]);
  });

  it("believes the composed range over a legacy collapse that lies", () => {
    const { container, host, prose, code } = scene();
    const endpoints = selectionEndpoints(
      stubSelection({
        // What Chromium reports for a backwards drag out of a code block:
        // both ends clamped onto the host, and isCollapsed true.
        anchorNode: host,
        focusNode: host,
        isCollapsed: true,
        composed: [
          {
            startContainer: prose,
            startOffset: 1,
            endContainer: code,
            endOffset: 7,
            collapsed: false,
          },
        ],
      }),
      container,
    );
    expect(endpoints?.collapsed).toBe(false);
    expect(endpoints?.start.node).toBe(prose);
    expect(endpoints?.end).toEqual({ node: code, offset: 7 });
  });

  it("still offers the comment button for a drag the browser collapsed", async () => {
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"first paragraph.\n\nsecond paragraph.\n"}
        annotations={[]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("p[data-loc]")) throw new Error("not rendered");
      return el;
    });
    const paragraphs = container.querySelectorAll("p[data-loc]");
    const start = paragraphs[0]?.firstChild as Node;
    const end = paragraphs[1]?.firstChild as Node;
    vi.spyOn(window, "getSelection").mockReturnValue(
      stubSelection({
        anchorNode: container,
        focusNode: container,
        isCollapsed: true,
        composed: [
          {
            startContainer: start,
            startOffset: 0,
            endContainer: end,
            endOffset: 6,
            collapsed: false,
          },
        ],
      }),
    );
    fireEvent(document, new Event("selectionchange"));
    // The composed endpoints are two ordinary text nodes, so the anchor
    // narrows to the columns they cover — the legacy collapse that used to
    // decide this had no columns to give.
    expect(await view.findByText(/Comment L1:1–L3:6/)).not.toBeNull();
  });
});

// T-384: the entry hung off one `mouseup` on the container, so it appeared
// only for a mouse drag that both began and ended inside the prose. Every
// case here is a path that event never saw — and the touchscreen half is
// the reason the button did not exist there at all: a long press is a
// selection gesture, for which no compatibility mouse event is synthesised.
describe("AnnotatedMarkdown selection triggers (T-384)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Three paragraphs, on source lines 1, 3 and 5.
  const BODY = "alpha one\n\nbeta two\n\ngamma three\n";

  async function mount(body = BODY) {
    const onStage = vi.fn();
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={body}
        annotations={[]}
        onStage={onStage}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("p[data-loc]")) throw new Error("not rendered");
      return el;
    });
    return { view, container, onStage };
  }

  /** Put a range on the document — all a keyboard selection ever does. */
  function select(start: Node, from: number, end: Node, to: number): void {
    const range = document.createRange();
    range.setStart(start, from);
    range.setEnd(end, to);
    const selection = window.getSelection();
    if (!selection) throw new Error("no selection support");
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function textOf(container: HTMLElement, nth: number): Node {
    const node = container.querySelectorAll("p[data-loc]")[nth]?.firstChild;
    if (!node) throw new Error(`no paragraph ${nth}`);
    return node;
  }

  /** A device whose primary pointer is a finger. */
  function stubCoarsePointer(): void {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query !== POINTER_FINE,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  }

  it("offers the entry for a keyboard selection, with no pointer event at all", async () => {
    const { view, container } = await mount();
    select(textOf(container, 0), 0, textOf(container, 0), 5);
    expect(await view.findByText(/Comment L1:1–5/)).not.toBeNull();
  });

  it("offers the entry for a drag released outside the container", async () => {
    const { view, container } = await mount();
    const prose = textOf(container, 0);
    fireEvent.pointerDown(prose.parentElement as Element);
    select(prose, 0, textOf(container, 2), 5);
    await settle();
    // Mid-drag the entry would sit under the words still being selected.
    expect(view.queryByText(/Comment L/)).toBeNull();
    fireEvent.pointerUp(document.body);
    expect(await view.findByText(/Comment L1:1–L5:5/)).not.toBeNull();
  });

  it("clears the entry when the selection is emptied anywhere on the page", async () => {
    const { view, container } = await mount();
    select(textOf(container, 0), 0, textOf(container, 0), 5);
    await view.findByText(/Comment L/);
    window.getSelection()?.removeAllRanges();
    await settle();
    expect(view.queryByText(/Comment L/)).toBeNull();
  });

  it("keeps its anchor while the entry itself is pressed (T-60)", async () => {
    const { view, container, onStage } = await mount();
    select(textOf(container, 1), 0, textOf(container, 1), 4);
    const button = await view.findByText(/Comment L3:1–4/);
    // The press is what clears the selection on a touchscreen, and the
    // click that stages has not happened yet.
    fireEvent.pointerDown(button);
    window.getSelection()?.removeAllRanges();
    await settle();
    expect(view.queryByText(/Comment L3:1–4/)).not.toBeNull();
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 3,
      lineEnd: 3,
      colStart: 1,
      colEnd: 4,
    });
  });

  it("drops the anchor when a press on the entry is followed by no click", async () => {
    const { view, container } = await mount();
    select(textOf(container, 1), 0, textOf(container, 1), 4);
    const button = await view.findByText(/Comment L3/);
    // Installed before the press, which is what arms the fallback timer.
    vi.useFakeTimers();
    fireEvent.pointerDown(button);
    window.getSelection()?.removeAllRanges();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(view.queryByText(/Comment L3/)).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(view.queryByText(/Comment L3/)).toBeNull();
  });

  it("recomputes nothing mid-drag, and exactly once when the pointer lifts", async () => {
    const { view, container } = await mount();
    const prose = textOf(container, 0);
    const range = document.createRange();
    range.setStart(prose, 0);
    range.setEnd(prose, 5);
    const composed = vi.fn(() => [
      {
        startContainer: prose,
        startOffset: 0,
        endContainer: prose,
        endOffset: 5,
        collapsed: false,
      },
    ]);
    vi.spyOn(window, "getSelection").mockReturnValue({
      anchorNode: prose,
      anchorOffset: 0,
      focusNode: prose,
      focusOffset: 5,
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "alpha",
      getComposedRanges: composed,
    } as unknown as Selection);

    fireEvent.pointerDown(prose.parentElement as Element);
    for (let i = 0; i < 3; i++) {
      fireEvent(document, new Event("selectionchange"));
    }
    await settle();
    // Reading the endpoints walks every open shadow root under the
    // container; a drag delivers `selectionchange` every frame.
    expect(composed).not.toHaveBeenCalled();
    expect(view.queryByText(/Comment L/)).toBeNull();

    fireEvent.pointerUp(document.body);
    await settle();
    expect(composed).toHaveBeenCalledTimes(1);
    expect(view.queryByText(/Comment L/)).not.toBeNull();
  });

  it("clamps an endpoint past the end of the file to the last block", async () => {
    const { view, container } = await mount();
    // What a drag off the end of the prose lands in: the next section of
    // the page, which carries no source lines of its own.
    const below = document.createElement("p");
    below.textContent = "Comments without a place in v3";
    document.body.append(below);
    try {
      select(textOf(container, 0), 0, below.firstChild as Node, 8);
      expect(await view.findByText(/Comment L1–5/)).not.toBeNull();
    } finally {
      below.remove();
    }
  });

  it("clamps an endpoint above the file to the first block", async () => {
    const above = document.createElement("p");
    above.textContent = "page header";
    document.body.prepend(above);
    try {
      const { view, container } = await mount();
      select(above.firstChild as Node, 0, textOf(container, 1), 4);
      expect(await view.findByText(/Comment L1–3/)).not.toBeNull();
    } finally {
      above.remove();
    }
  });

  it("stages the same anchor from the touch action bar as from the rail button", async () => {
    const desktop = await mount();
    select(textOf(desktop.container, 1), 0, textOf(desktop.container, 1), 4);
    const rail = await desktop.view.findByText(/Comment L3:1–4/);
    expect(rail.closest('[data-testid="annotation-action-bar"]')).toBeNull();
    fireEvent.click(rail);
    cleanup();

    stubCoarsePointer();
    const touch = await mount();
    select(textOf(touch.container, 1), 0, textOf(touch.container, 1), 4);
    const bar = await touch.view.findByText(/Comment L3:1–4/);
    expect(bar.closest('[data-testid="annotation-action-bar"]')).not.toBeNull();
    fireEvent.click(bar);

    expect(touch.onStage.mock.calls).toEqual(desktop.onStage.mock.calls);
    expect(touch.onStage).toHaveBeenCalledWith({
      lineStart: 3,
      lineEnd: 3,
      colStart: 1,
      colEnd: 4,
    });
  });

  it("offers the touch action bar with no pointer event at all", async () => {
    // Dragging the platform's own selection handles: the page is told the
    // selection moved and nothing else.
    stubCoarsePointer();
    const { view, container } = await mount();
    select(textOf(container, 0), 0, textOf(container, 0), 5);
    expect(await view.findByTestId("annotation-action-bar")).not.toBeNull();
  });

  it("follows a selection handle dragged after a long press", async () => {
    // iOS Safari: once the long press lifts, holding a selection handle
    // sends one touch pointerdown and no pointerup or pointercancel until
    // the next press. A quick tap on the entry then clicks before the
    // recompute its own pointerup schedules has rendered, which the
    // pointerdown, pointerup and click fired back to back stand for here.
    stubCoarsePointer();
    const { view, container, onStage } = await mount();
    const first = textOf(container, 0);
    const paragraph = first.parentElement as Element;

    fireEvent.pointerDown(paragraph, { pointerType: "touch" });
    select(first, 0, first, 5);
    fireEvent.pointerUp(paragraph, { pointerType: "touch" });
    await view.findByText(/Comment L1:1–5/);

    fireEvent.pointerDown(paragraph, { pointerType: "touch" });
    select(first, 0, textOf(container, 1), 4);
    await settle();
    const bar = view.getByText(/Comment L1:1–L3:4/);

    fireEvent.pointerDown(bar, { pointerType: "touch" });
    fireEvent.pointerUp(bar, { pointerType: "touch" });
    fireEvent.click(bar);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 3,
      colStart: 1,
      colEnd: 4,
    });
  });
});

// The two edges T-384's review found: an entry the reader cannot reach is
// not an entry, and the anchor of a selection that crosses into pierre's
// shadow root has to widen to whole lines rather than vanish.
describe("AnnotatedMarkdown entry placement and shadow fallback (T-384)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rect = (top: number, bottom: number) =>
    ({ top, bottom, height: bottom - top }) as DOMRect;

  /** The entry's rendered offset, with both rects it is measured from stubbed. */
  async function topWith(
    containerRect: DOMRect,
    selectionRect: DOMRect,
  ): Promise<number> {
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"alpha one\n\nbeta two\n\ngamma three\n"}
        annotations={[]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("p[data-loc]")) throw new Error("not rendered");
      return el;
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(containerRect);
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      selectionRect,
    );

    const node = container.querySelector("p[data-loc]")?.firstChild;
    if (!node) throw new Error("no paragraph");
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const button = await view.findByText(/Comment L/);
    return Number.parseFloat(
      (button as HTMLElement).style.top.replace("px", ""),
    );
  }

  it("sits six pixels under the end of the selection", async () => {
    // Pins the offset itself, not just a range it falls in: an `entryTop`
    // that answered a constant would satisfy the clamp below and still put
    // the button nowhere near the words it points at.
    expect(await topWith(rect(0, 400), rect(0, 120))).toBe(126);
  });

  it("keeps the entry inside the file when the selection reaches past it", async () => {
    // The shape ⌘/Ctrl-A produces on a real page: the selection's rect is as
    // tall as the document, while the file it anchors to is a short box.
    expect(await topWith(rect(0, 52), rect(0, 3150))).toBe(52);
  });

  it("widens to whole lines when an endpoint sits in a shadow root", () => {
    const container = document.createElement("div");
    const prose = document.createElement("p");
    prose.setAttribute("data-loc", "1-1");
    prose.textContent = "alpha beta";
    const block = document.createElement("div");
    block.setAttribute("data-loc", "2-2");
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const row = document.createElement("span");
    row.textContent = "x = 1";
    shadow.append(row);
    block.append(host);
    container.append(prose, block);
    document.body.append(container);
    try {
      const index = buildSegmentIndex("alpha beta\nx = 1\n");
      const anchor = anchorForSelection(container, index, {
        start: { node: prose.firstChild as Node, offset: 2 },
        // An endpoint in a shadow root that is on none of pierre's rows
        // in a code block's wrapper: nothing maps it to a column, so the
        // anchor widens to the lines of both blocks.
        end: { node: row.firstChild as Node, offset: 3 },
        collapsed: false,
      });
      expect(anchor).toEqual({
        lineStart: 1,
        lineEnd: 2,
        colStart: null,
        colEnd: null,
      });
    } finally {
      container.remove();
    }
  });
});

describe("selection around restored old structure", () => {
  it("rejects both pure-old and mixed selections instead of falling back to a current line", () => {
    const container = document.createElement("div");
    const current = document.createElement("p");
    current.setAttribute("data-loc", "1-1");
    current.textContent = "Current text";
    const old = document.createElement("p");
    old.className = "spec-del-structure";
    // An old node may still carry a stamp from its original source tree.
    old.setAttribute("data-loc", "1-1");
    old.textContent = "Removed text";
    container.append(current, old);
    document.body.append(container);
    try {
      const index = buildSegmentIndex("Current text\n");
      const currentText = current.firstChild as Node;
      const oldText = old.firstChild as Node;
      const ends = (start: Node, end: Node) => ({
        start: { node: start, offset: 0 },
        end: { node: end, offset: 4 },
        collapsed: false,
      });
      expect(
        anchorForSelection(container, index, ends(oldText, oldText)),
      ).toBeNull();
      expect(
        anchorForSelection(container, index, ends(oldText, currentText)),
      ).toBeNull();
      expect(
        anchorForSelection(container, index, ends(currentText, oldText)),
      ).toBeNull();
    } finally {
      container.remove();
    }
  });

  it("rejects explicit list numbers without rejecting prose beside them", () => {
    const container = document.createElement("div");
    const item = document.createElement("li");
    item.setAttribute("data-loc", "1-1");
    const number = document.createElement("span");
    number.className = "spec-list-number";
    number.textContent = "1. ";
    const prose = document.createTextNode("fresh prose");
    item.append(number, prose);
    container.append(item);
    document.body.append(container);
    try {
      const index = buildSegmentIndex("1. fresh prose\n");
      expect(
        anchorForSelection(container, index, {
          start: { node: number.firstChild as Node, offset: 0 },
          end: { node: prose, offset: 5 },
          collapsed: false,
        }),
      ).toBeNull();
      // The explicit number does not shift offsets for live text in the item.
      expect(
        anchorForSelection(container, index, {
          start: { node: prose, offset: 0 },
          end: { node: prose, offset: 5 },
          collapsed: false,
        }),
      ).toEqual({
        lineStart: 1,
        lineEnd: 1,
        colStart: 4,
        colEnd: 8,
      });
    } finally {
      container.remove();
    }
  });

  it("rejects an endpoint inside old code through its shadow host", () => {
    const container = document.createElement("div");
    const current = document.createElement("p");
    current.setAttribute("data-loc", "1-1");
    current.textContent = "Current";
    const oldCode = document.createElement("pre");
    oldCode.className = "spec-del-structure";
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const row = document.createElement("span");
    row.textContent = "removed()";
    shadow.append(row);
    oldCode.append(host);
    container.append(current, oldCode);
    document.body.append(container);
    try {
      expect(
        anchorForSelection(container, buildSegmentIndex("Current\n"), {
          start: { node: current.firstChild as Node, offset: 0 },
          end: { node: row.firstChild as Node, offset: 4 },
          collapsed: false,
        }),
      ).toBeNull();
    } finally {
      container.remove();
    }
  });

  it("keeps current line and columns after an old subtree inside a stamped block", () => {
    const container = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.setAttribute("data-loc", "3-3");
    const before = document.createTextNode("Fresh ");
    const old = document.createElement("span");
    old.className = "spec-del-structure";
    old.textContent = "obsolete words ";
    const number = document.createElement("span");
    number.className = "spec-list-number";
    number.textContent = "9. ";
    const after = document.createTextNode("prose");
    paragraph.append(before, old, number, after);
    container.append(paragraph);
    document.body.append(container);
    try {
      expect(
        anchorForSelection(
          container,
          buildSegmentIndex("First\n\nFresh prose\n"),
          {
            start: { node: after, offset: 0 },
            end: { node: after, offset: 5 },
            collapsed: false,
          },
        ),
      ).toEqual({
        lineStart: 3,
        lineEnd: 3,
        colStart: 7,
        colEnd: 11,
      });
    } finally {
      container.remove();
    }
  });
});

describe("existing deletion selection behavior", () => {
  it("keeps the whole-line fallback for an old inline deletion", () => {
    const container = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.setAttribute("data-loc", "1-1");
    const removed = document.createElement("del");
    removed.className = "spec-del";
    removed.textContent = "former";
    paragraph.append(removed, document.createTextNode("present"));
    container.append(paragraph);
    document.body.append(container);
    try {
      const oldText = removed.firstChild as Node;
      expect(
        anchorForSelection(container, buildSegmentIndex("present\n"), {
          start: { node: oldText, offset: 0 },
          end: { node: oldText, offset: 6 },
          collapsed: false,
        }),
      ).toEqual({
        lineStart: 1,
        lineEnd: 1,
        colStart: null,
        colEnd: null,
      });
    } finally {
      container.remove();
    }
  });

  it("keeps a paired code diff's old row on the whole current fence", () => {
    const code = document.createElement("div");
    code.setAttribute("data-loc", "2-4");
    code.setAttribute("data-loc-content-start", "3");
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const row = document.createElement("span");
    row.setAttribute("data-line", "1");
    row.setAttribute("data-line-type", "change-deletion");
    row.textContent = "old code";
    shadow.append(row);
    code.append(host);
    expect(anchorRangeForNode(row.firstChild as Node)).toEqual({
      start: 2,
      end: 4,
    });
  });
});

/**
 * `source` rendered with its stamps, and its first code block given pierre's
 * shape: `rows` inside an open shadow root under the stamped wrapper.
 */
function fenceWithRows(
  source: string,
  rows: string,
): {
  container: HTMLElement;
  shadow: ShadowRoot;
  index: SegmentIndex;
  lines: string[];
} {
  const view = render(
    <QueryClientProvider client={testQueryClient()}>
      <MarkdownView rehypePlugins={[rehypeSourceLines]}>{source}</MarkdownView>
    </QueryClientProvider>,
  );
  const wrapper = view.container.querySelector("[data-loc-content-start]");
  if (wrapper === null) throw new Error("the fence rendered no wrapper");
  const host = document.createElement("diffs-container");
  wrapper.append(host);
  // Once pierre's module has loaded (a patch fence parses through it), the
  // host is its registered element and arrives with a shadow root already.
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.innerHTML = rows;
  return {
    container: view.container,
    shadow,
    index: buildSegmentIndex(source),
    lines: source.split("\n"),
  };
}

/** The source an anchor's columns cut, the way the server cuts a quote. */
function cut(
  lines: string[],
  anchor: {
    lineStart: number;
    lineEnd: number;
    colStart: number | null;
    colEnd: number | null;
  },
): string {
  const picked = lines.slice(anchor.lineStart - 1, anchor.lineEnd);
  const last = picked.length - 1;
  if (anchor.colStart === null || anchor.colEnd === null) {
    throw new Error("the anchor has no columns");
  }
  if (last === 0) {
    return (picked[0] ?? "").slice(anchor.colStart - 1, anchor.colEnd);
  }
  picked[0] = (picked[0] ?? "").slice(anchor.colStart - 1);
  picked[last] = (picked[last] ?? "").slice(0, anchor.colEnd);
  return picked.join("\n");
}

/** Endpoints for the text of `start` and `end` at those offsets. */
function ends(
  start: Node | null | undefined,
  from: number,
  end: Node | null | undefined,
  to: number,
) {
  if (!start || !end) throw new Error("no node to select");
  return {
    start: { node: start, offset: from },
    end: { node: end, offset: to },
    collapsed: false,
  };
}

const CODE_ROWS = [
  "const alpha = 1;",
  "const bravo = 2;",
  "const charlie = 3;",
];

/** Rows for CODE_ROWS, the second split into token spans as pierre does. */
const TOKEN_ROWS = `
  <div data-line="1"><span>const alpha = 1;</span></div>
  <div data-line="2"><span>const </span><span>bravo</span><span> = 2;</span></div>
  <div data-line="3"><span>const charlie = 3;</span></div>`;

describe("column anchors inside a code block", () => {
  it("anchors a word selected in one line of a fence", () => {
    const { container, shadow, index, lines } = fenceWithRows(
      `Intro.\n\n\`\`\`ts\n${CODE_ROWS.join("\n")}\n\`\`\`\n`,
      TOKEN_ROWS,
    );
    const word = shadow.querySelector("[data-line='2'] span:nth-child(2)");
    const anchor = anchorForSelection(
      container,
      index,
      ends(word?.firstChild, 0, word?.firstChild, 5),
    );
    if (anchor === null) throw new Error("no anchor");
    expect(anchor.lineStart).toBe(anchor.lineEnd);
    expect(cut(lines, anchor)).toBe("bravo");
  });

  it.each(FENCE_SHAPES)("anchors a word to its columns in %s", (_name, of) => {
    const source = of(CODE_ROWS);
    const { container, shadow, index, lines } = fenceWithRows(
      source,
      TOKEN_ROWS,
    );
    const text = shadow.querySelector("[data-line='3'] span")?.firstChild;
    const anchor = anchorForSelection(
      container,
      index,
      ends(text, 6, text, 13),
    );
    if (anchor === null) throw new Error("no anchor");
    expect(lines[anchor.lineStart - 1]).toContain("const charlie = 3;");
    expect(cut(lines, anchor)).toBe("charlie");
  });

  it("keeps the whole line when the row does not read as its source", () => {
    const source = `\`\`\`ts\n${CODE_ROWS.join("\n")}\n\`\`\`\n`;
    const { container, shadow, index } = fenceWithRows(
      source,
      `<div data-line="2"><span>const BRAVO = 2;</span></div>`,
    );
    const text = shadow.querySelector("span")?.firstChild;
    expect(
      anchorForSelection(container, index, ends(text, 6, text, 11)),
    ).toEqual({ lineStart: 3, lineEnd: 3, colStart: null, colEnd: null });
  });

  it("anchors a drag from prose into a code line the same either way", () => {
    const source = `Intro words here.\n\n\`\`\`ts\n${CODE_ROWS.join("\n")}\n\`\`\`\n`;
    const { container, shadow, index, lines } = fenceWithRows(
      source,
      TOKEN_ROWS,
    );
    const prose = container.querySelector("p[data-loc]")?.firstChild;
    const word = shadow.querySelector("[data-line='2'] span:nth-child(2)");
    const forward = anchorForSelection(
      container,
      index,
      ends(prose, 6, word?.firstChild, 5),
    );
    if (forward === null) throw new Error("no anchor");
    expect(cut(lines, forward)).toBe(
      "words here.\n\n```ts\nconst alpha = 1;\nconst bravo",
    );
    const backward = anchorForSelection(
      container,
      index,
      ends(word?.firstChild, 5, prose, 6),
    );
    expect(backward).toEqual(forward);
  });

  const PATCH = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,2 @@",
    " same",
    "-old words",
    "+new words",
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1,2 +1,2 @@",
    " same",
    "-b",
    "+B",
  ];

  it("anchors a patch row to the fence line that carries it", () => {
    const source = `Some prose.\n\n\`\`\`patch\n${PATCH.join("\n")}\n\`\`\`\n`;
    const { container, shadow, index, lines } = fenceWithRows(
      source,
      `<pre data-diff=""><div data-line="2" data-line-type="change-addition"><span>new words</span></div></pre>`,
    );
    const text = shadow.querySelector("span")?.firstChild;
    const anchor = anchorForSelection(container, index, ends(text, 4, text, 9));
    if (anchor === null) throw new Error("no anchor");
    expect(lines[anchor.lineStart - 1]).toBe("+new words");
    expect(cut(lines, anchor)).toBe("words");
  });

  it("keeps the whole fence for a patch row two files share", () => {
    const source = `Some prose.\n\n\`\`\`patch\n${PATCH.join("\n")}\n\`\`\`\n`;
    const { container, shadow, index, lines } = fenceWithRows(
      source,
      `<pre data-diff=""><div data-line="1" data-line-type="context"><span>same</span></div></pre>`,
    );
    const text = shadow.querySelector("span")?.firstChild;
    expect(
      anchorForSelection(container, index, ends(text, 0, text, 4)),
    ).toEqual({
      lineStart: lines.indexOf("```patch") + 1,
      lineEnd: lines.lastIndexOf("```") + 1,
      colStart: null,
      colEnd: null,
    });
  });
});

describe("column anchors at the edges of code rows", () => {
  it.each([
    ["list item's indent", "  "],
    ["quote's marker", "> "],
  ])(
    "leaves the next line's %s out of a selection that stops at a row's start",
    (_name, prefix) => {
      const lines = ["const alpha = 1;", "const bravo = 2;"];
      const source =
        prefix === "  "
          ? `- item\n\n  \`\`\`ts\n${lines.map((l) => `  ${l}`).join("\n")}\n  \`\`\`\n`
          : `> \`\`\`ts\n${lines.map((l) => `> ${l}`).join("\n")}\n> \`\`\`\n`;
      const {
        container,
        shadow,
        index,
        lines: all,
      } = fenceWithRows(
        source,
        `<div data-line="1"><span>${lines[0]}</span></div>
         <div data-line="2"><span>${lines[1]}</span></div>`,
      );
      const first = shadow.querySelector("[data-line='1'] span")?.firstChild;
      const second = shadow.querySelector("[data-line='2'] span")?.firstChild;
      // The whole first row, as a triple-click or Shift+Down leaves it: the
      // end sits at the very start of the next row.
      const whole = anchorForSelection(
        container,
        index,
        ends(first, 0, second, 0),
      );
      if (whole === null) throw new Error("no anchor");
      expect(cut(all, whole)).toBe("const alpha = 1;");
      // Starting at the first row's end, the next row's prefix is skipped.
      const opening = anchorForSelection(
        container,
        index,
        ends(first, lines[0]?.length ?? 0, second, 5),
      );
      if (opening === null) throw new Error("no anchor");
      expect(cut(all, opening)).toBe("const");
    },
  );

  it("leaves a fence's markers out of a selection crossing its edge", () => {
    const source = `Intro words.\n\n\`\`\`ts\n${CODE_ROWS.join("\n")}\n\`\`\`\n\nOutro words.\n`;
    const { container, shadow, index, lines } = fenceWithRows(
      source,
      TOKEN_ROWS,
    );
    const [intro, outro] = [...container.querySelectorAll("p[data-loc]")].map(
      (p) => p.firstChild,
    );
    const last = shadow.querySelector("[data-line='3'] span")?.firstChild;
    const first = shadow.querySelector("[data-line='1'] span")?.firstChild;
    // From a code row down to the very start of the next paragraph.
    const down = anchorForSelection(container, index, ends(last, 6, outro, 0));
    if (down === null) throw new Error("no anchor");
    expect(cut(lines, down)).toBe("charlie = 3;");
    // From the very end of the paragraph above into the first row.
    const into = anchorForSelection(
      container,
      index,
      ends(intro, "Intro words.".length, first, 5),
    );
    if (into === null) throw new Error("no anchor");
    expect(cut(lines, into)).toBe("const");
  });

  it("reaches a patch row that names no single line", () => {
    const source = `Some prose.\n\n\`\`\`patch\n${[
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " same",
      "-old words",
      "+new words",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,2 +1,2 @@",
      " same",
      "-b",
      "+B",
    ].join("\n")}\n\`\`\`\n`;
    const { container, shadow, index, lines } = fenceWithRows(
      source,
      `<pre data-diff="">
         <div data-line="1" data-line-type="context"><span>same</span></div>
         <div data-line="2" data-line-type="change-deletion"><span>old words</span></div>
         <div data-line="2" data-line-type="change-addition"><span>new words</span></div>
         <div data-line="1" data-line-type="context"><span>same</span></div>
         <div data-line="2" data-line-type="change-deletion"><span>b</span></div>
       </pre>`,
    );
    const rows = shadow.querySelectorAll("[data-line] span");
    // From "words" on file a's last row to the start of file b's deletion:
    // file b's "same" row, which both files share, is in between and
    // selected, so the anchor reaches its line.
    const anchor = anchorForSelection(
      container,
      index,
      ends(rows[2]?.firstChild, 4, rows[4]?.firstChild, 0),
    );
    if (anchor === null) throw new Error("no anchor");
    expect(anchor.lineEnd).toBe(lines.lastIndexOf(" same") + 1);
  });

  // Left open, the fence ends with its quote, on its blank body line rather
  // than on a closing marker.
  it("gives an unclosed fence's one blank body line its own line", () => {
    const source = "> ```\n>\n\nAfter.\n";
    const { shadow, index } = fenceWithRows(
      source,
      `<div data-line="1"><span>\n</span></div>`,
    );
    const row = shadow.querySelector("span")?.firstChild;
    if (!row) throw new Error("no row");
    expect(anchorRangeForNode(row, index)).toEqual({ start: 2, end: 2 });
  });

  it("gives a fence's one blank body line its own line", () => {
    const source = "Intro.\n\n```\n\n```\n";
    const { shadow, index } = fenceWithRows(
      source,
      `<div data-line="1"><span>\n</span></div>`,
    );
    const row = shadow.querySelector("span")?.firstChild;
    if (!row) throw new Error("no row");
    expect(anchorRangeForNode(row, index)).toEqual({ start: 4, end: 4 });
  });

  it("anchors in a fence indented by its own two spaces", () => {
    const source = `Intro.\n\n  \`\`\`ts\n  ${CODE_ROWS.join("\n  ")}\n  \`\`\`\n`;
    const { container, shadow, index, lines } = fenceWithRows(
      source,
      TOKEN_ROWS,
    );
    const word = shadow.querySelector("[data-line='2'] span:nth-child(2)");
    const anchor = anchorForSelection(
      container,
      index,
      ends(word?.firstChild, 0, word?.firstChild, 5),
    );
    if (anchor === null) throw new Error("no anchor");
    expect(lines[anchor.lineStart - 1]).toBe("  const bravo = 2;");
    expect(cut(lines, anchor)).toBe("bravo");
  });

  it("gives an empty fence's row no line, so no columns reach its marker", () => {
    const source = "Intro.\n\n```ts\n```\n";
    const { container, shadow, index } = fenceWithRows(
      source,
      `<div data-line="1"><span>\n</span></div>`,
    );
    const prose = container.querySelector("p[data-loc]")?.firstChild;
    const row = shadow.querySelector("span")?.firstChild;
    expect(
      anchorForSelection(container, index, ends(prose, 0, row, 1)),
    ).toEqual({ lineStart: 1, lineEnd: 4, colStart: null, colEnd: null });
  });

  // Where a backwards selection's ends sit on a boundary between two runs of
  // prose, which run each belongs to depends on which end it is: mapped
  // under the wrong edge, "a **b** c" would anchor "**b**" instead of "b".
  it("reads each end of a backwards selection under its own edge", () => {
    const container = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.setAttribute("data-loc", "1-1");
    const before = document.createTextNode("a ");
    const strong = document.createElement("strong");
    strong.textContent = "b";
    paragraph.append(before, strong, document.createTextNode(" c"));
    container.append(paragraph);
    document.body.append(container);
    try {
      expect(
        anchorForSelection(container, buildSegmentIndex("a **b** c\n"), {
          // Dragged from after "b" back to before it.
          start: { node: strong.firstChild as Node, offset: 1 },
          end: { node: before, offset: 2 },
          collapsed: false,
        }),
      ).toEqual({ lineStart: 1, lineEnd: 1, colStart: 5, colEnd: 5 });
    } finally {
      container.remove();
    }
  });
});

// A triple-click leaves an end on an element boundary rather than in text:
// Chromium and WebKit end at the start of the next block, Firefox wraps the
// block's element. Neither end maps to a column, which used to widen the
// anchor to the whole lines of every block the two ends touch.
describe("endpoints that select nothing", () => {
  const SOURCE =
    "First paragraph here.\n\nSecond paragraph here.\n\n- item one\n- item two\n- item three\n";

  async function rendered(
    body = SOURCE,
    ready = "li[data-loc]",
  ): Promise<HTMLElement> {
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={body}
        annotations={[]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    return waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector(ready)) throw new Error("not rendered");
      return el;
    });
  }

  it.each([
    [
      "a paragraph that ends on the next one's element",
      (paragraphs: Element[], _items: Element[]) =>
        ends(paragraphs[0]?.firstChild, 0, paragraphs[1], 0),
      { lineStart: 1, lineEnd: 1, colStart: 1, colEnd: 21 },
    ],
    [
      "an item that ends on the next item's element",
      (_paragraphs: Element[], items: Element[]) =>
        ends(items[1]?.firstChild, 0, items[2], 0),
      { lineStart: 6, lineEnd: 6, colStart: 3, colEnd: 10 },
    ],
    [
      "an item selected as its element's contents",
      (_paragraphs: Element[], items: Element[]) =>
        ends(items[1], 0, items[1], 1),
      { lineStart: 6, lineEnd: 6, colStart: 3, colEnd: 10 },
    ],
    [
      "an item selected backwards from the next item's element",
      (_paragraphs: Element[], items: Element[]) =>
        ends(items[2], 0, items[1]?.firstChild, 0),
      { lineStart: 6, lineEnd: 6, colStart: 3, colEnd: 10 },
    ],
  ])("anchors %s to that block's text", async (_name, pick, anchor) => {
    const container = await rendered();
    const paragraphs = [...container.querySelectorAll("p[data-loc]")];
    const items = [...container.querySelectorAll("li[data-loc]")];
    expect(
      anchorForSelection(
        container,
        buildSegmentIndex(SOURCE),
        pick(paragraphs, items),
      ),
    ).toEqual(anchor);
  });

  it("stops before deleted old text rather than in it", () => {
    const container = document.createElement("div");
    const first = document.createElement("p");
    first.setAttribute("data-loc", "1-1");
    const removed = document.createElement("del");
    removed.className = "spec-del";
    removed.textContent = "former";
    first.append(document.createTextNode("present"), removed);
    const second = document.createElement("p");
    second.setAttribute("data-loc", "3-3");
    second.textContent = "next";
    container.append(first, second);
    document.body.append(container);
    try {
      expect(
        anchorForSelection(
          container,
          buildSegmentIndex("present\n\nnext\n"),
          ends(first.firstChild, 0, second, 0),
        ),
      ).toEqual({ lineStart: 1, lineEnd: 1, colStart: 1, colEnd: 7 });
    } finally {
      container.remove();
    }
  });

  it("keeps an image the selection ends past", async () => {
    const source = "See ![pic](x.png)\n\nnext\n";
    const container = await rendered(source, "p[data-loc] img");
    const [first, second] = [...container.querySelectorAll("p[data-loc]")];
    expect(
      anchorForSelection(
        container,
        buildSegmentIndex(source),
        ends(first?.firstChild, 0, second, 0),
      ),
    ).toEqual({ lineStart: 1, lineEnd: 1, colStart: null, colEnd: null });
  });

  it("stops before an old image a compared table put back", async () => {
    const source = "| a |\n| - |\n| one |\n\nafter\n";
    const container = await rendered(source, "tbody td");
    // An image the cell lost, as the comparison puts it back after the text.
    const image = document.createElement("img");
    image.className = "spec-del-img";
    container.querySelector("tbody td")?.append(image);
    expect(
      anchorForSelection(
        container,
        buildSegmentIndex(source),
        ends(
          container.querySelector("tbody td")?.firstChild,
          0,
          container.querySelector("p[data-loc]"),
          0,
        ),
      ),
    ).toEqual({ lineStart: 3, lineEnd: 3, colStart: 3, colEnd: 5 });
  });

  it("leaves alone ends that select text themselves", async () => {
    // Both ends sit next to a space, which stays in the anchor.
    const container = await rendered();
    const [first, second] = [...container.querySelectorAll("p[data-loc]")];
    expect(
      anchorForSelection(
        container,
        buildSegmentIndex(SOURCE),
        ends(first?.firstChild, 5, second?.firstChild, 7),
      ),
    ).toEqual({ lineStart: 1, lineEnd: 3, colStart: 6, colEnd: 7 });
  });
});
