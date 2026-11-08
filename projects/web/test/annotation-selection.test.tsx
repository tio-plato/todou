import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { IssueListItem, ReferenceConfig } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentsQuery,
  attachmentTextQuery,
  deletedAttachmentsQuery,
} from "../src/api/attachments.ts";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { projectsQuery } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { compareAnchorForSelection } from "../src/lib/compare-anchor.ts";
import {
  NO_DECORATIONS,
  rehypeDecorations,
} from "../src/lib/rehype-decorations.ts";
import { rehypeSourceLines } from "../src/lib/rehype-source-lines.ts";
import {
  anchorForSelection,
  anchorRangeForNode,
} from "../src/lib/selection-anchor.ts";
import {
  type SelectionEndpoints,
  selectionEndpoints,
} from "../src/lib/selection-endpoints.ts";
import { pairedFences } from "../src/lib/spec-decorations.ts";
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
    [
      "two characters of inline code",
      "a `code` b\n",
      "c[od]e",
      { lineStart: 1, lineEnd: 1, colStart: 5, colEnd: 6 },
    ],
    [
      // The page shows the line ending as a space and keeps the four blanks
      // past the item's indent: five between "co" and "de".
      "a word of code folded in a list item",
      "- a `co\n      de` b\n",
      "co     [de]",
      { lineStart: 2, lineEnd: 2, colStart: 7, colEnd: 8 },
    ],
    [
      // Code folded at a lone CR stays whole, but shows a space there, and
      // so must its segment for the words after it to line up.
      "a word after code folded at a lone CR",
      "a `co\rde` b c\n",
      "b [c]",
      { lineStart: 1, lineEnd: 1, colStart: 13, colEnd: 13 },
    ],
    [
      // Indented four spaces, the `>` is the line's text, not a quote marker.
      "a word on a continuation line opening with >",
      "a\n    >b c\n",
      ">b [c]",
      { lineStart: 2, lineEnd: 2, colStart: 8, colEnd: 8 },
    ],
    [
      "the > a continuation line opens with",
      "a\n    >b c\n",
      "[>b] c",
      { lineStart: 2, lineEnd: 2, colStart: 5, colEnd: 6 },
    ],
    [
      // The page drops the blanks around the line break `&#10;` stands for.
      "a word after a reference for a line break",
      "x &#10; y z\n",
      "y [z]",
      { lineStart: 1, lineEnd: 1, colStart: 11, colEnd: 11 },
    ],
    [
      "a word after a blank reference ending a line",
      "a&#32;\nb c\n",
      "b [c]",
      { lineStart: 2, lineEnd: 2, colStart: 3, colEnd: 3 },
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

  it("anchors a word in a list item that holds a sublist", async () => {
    // The parent's <li> holds the sublist's text too, and the blank text
    // nodes the renderer puts between an item's blocks.
    const { onStage, button } = await stageSelection(
      "- parent item words\n  1. child one\n  2. child two\n- next item\n",
      (container) => bracketedIn(container, "parent [item] words"),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 10,
      colEnd: 13,
    });
  });

  // The page shows raw HTML as its source text, tags and all.
  it.each([
    [
      "a word after inline HTML",
      "a <kbd>Ctrl</kbd> b c\n",
      "b [c]",
      { lineStart: 1, lineEnd: 1, colStart: 21, colEnd: 21 },
    ],
    [
      "the text between two inline tags",
      "a <kbd>Ctrl</kbd> b c\n",
      "[Ctrl]",
      { lineStart: 1, lineEnd: 1, colStart: 8, colEnd: 11 },
    ],
    [
      "a table cell next to one holding a <br>",
      "| a<br>b | cc |\n| - | - |\n| x | y |\n",
      "[cc]",
      { lineStart: 1, lineEnd: 1, colStart: 12, colEnd: 13 },
    ],
  ])("anchors %s to its own columns", async (_name, body, pick, anchor) => {
    const { onStage, button } = await stageSelection(body, (container) =>
      bracketedIn(container, pick),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith(anchor);
  });

  describe("in a footnote definition", () => {
    const FOOTNOTE = "text[^1] more words\n\n[^1]: note here\n";

    /** The definition's text, and the text of its link back to the reference. */
    function definitionNodes(container: HTMLElement): {
      note: Node;
      back: Node;
    } {
      const back = container.querySelector(
        "a[data-footnote-backref]",
      )?.firstChild;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node as Text).data.startsWith("note here") && back) {
          return { note: node, back };
        }
      }
      throw new Error("no footnote definition");
    }

    it("anchors a word of the definition to its own columns", async () => {
      const { onStage, button } = await stageSelection(
        FOOTNOTE,
        (container) => bracketedIn(container, "[note] here"),
        { ready: "a[data-footnote-backref]" },
      );
      fireEvent.click(button);
      expect(onStage).toHaveBeenCalledWith({
        lineStart: 3,
        lineEnd: 3,
        colStart: 7,
        colEnd: 10,
      });
    });

    it("anchors a word on a definition's continuation line", async () => {
      const { onStage, button } = await stageSelection(
        "text[^1]\n\n[^1]: first line\n    continued\n",
        (container) => bracketedIn(container, "[continued]"),
        { ready: "a[data-footnote-backref]" },
      );
      fireEvent.click(button);
      // "    continued": the indent is the definition's, not its text.
      expect(onStage).toHaveBeenCalledWith({
        lineStart: 4,
        lineEnd: 4,
        colStart: 5,
        colEnd: 13,
      });
    });

    it("ends a drag past the link back to the reference on the text", async () => {
      const { onStage, button } = await stageSelection(
        FOOTNOTE,
        (container) => {
          const { note, back } = definitionNodes(container);
          return {
            node: note,
            from: 0,
            endNode: back,
            to: (back as Text).length,
          };
        },
        { ready: "a[data-footnote-backref]" },
      );
      fireEvent.click(button);
      expect(onStage).toHaveBeenCalledWith({
        lineStart: 3,
        lineEnd: 3,
        colStart: 7,
        colEnd: 15,
      });
    });
  });

  // Block HTML shows as its own source, but a fold's tags as a fold.
  it.each([
    [
      "the summary of a fold",
      "<details><summary>Fold here</summary>\n\nbody text\n\n</details>\n",
      "[Fold] here",
      { lineStart: 1, lineEnd: 1, colStart: 19, colEnd: 22 },
    ],
    [
      // No blank line: the fold is one block of HTML, its body shown as is.
      "the body of a fold written as one block",
      "<details>\n<summary>s</summary>\n**body** here\n</details>\n",
      "**body** [here]",
      { lineStart: 3, lineEnd: 3, colStart: 10, colEnd: 13 },
    ],
    [
      "a block of HTML",
      "<div>block words</div>\n\nafter text\n",
      "block [words]",
      { lineStart: 1, lineEnd: 1, colStart: 12, colEnd: 16 },
    ],
    [
      "a block of HTML in a quote",
      "> <div>block words</div>\n",
      "block [words]",
      { lineStart: 1, lineEnd: 1, colStart: 14, colEnd: 18 },
    ],
    [
      // One block of HTML: the fold, then on the next line more HTML.
      "the summary of a fold with HTML on the line after it",
      "<details><summary>More</summary>hidden</details>\n<p>after</p>\n",
      "[More]",
      { lineStart: 1, lineEnd: 1, colStart: 19, colEnd: 22 },
    ],
    [
      "the HTML on the line after a fold",
      "<details><summary>More</summary>hidden</details>\n<p>after</p>\n",
      "<p>[after]",
      { lineStart: 2, lineEnd: 2, colStart: 4, colEnd: 8 },
    ],
  ])(
    "anchors a word in %s to its own columns",
    async (_name, body, pick, anchor) => {
      const { onStage, button } = await stageSelection(body, (container) =>
        bracketedIn(container, pick),
      );
      fireEvent.click(button);
      expect(onStage).toHaveBeenCalledWith(anchor);
    },
  );

  it("anchors a list item's own text after a code block in it", async () => {
    const { onStage, button } = await stageSelection(
      "- item text\n  ```\n  code\n  ```\n  more\n",
      (container) => bracketedIn(container, "[more]"),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 5,
      lineEnd: 5,
      colStart: 3,
      colEnd: 6,
    });
  });

  it("counts the blank between two emphases as the paragraph's text", async () => {
    const { onStage, button } = await stageSelection(
      "*one* *two* three\n",
      (container) => bracketedIn(container, " [three]"),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 13,
      colEnd: 17,
    });
  });

  /** The query data a chip to issue 12 and a project `p` are drawn from. */
  function chipClient(): QueryClient {
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
    return client;
  }

  const CHIP_LINE = "see [#12](/projects/1/issues/12) here\n";

  /** The text node of the chip's title, and the one after the chip. */
  function chipNodes(container: HTMLElement): { title: Node; after: Node } {
    const chip = container.querySelector("a[data-issue-link]");
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let title: Node | null = null;
    let after: Node | null = null;
    for (
      let node = walker.nextNode();
      node !== null;
      node = walker.nextNode()
    ) {
      if ((node as Text).data === "A referenced issue") title = node;
      if ((node as Text).data === " here" && !chip?.contains(node))
        after = node;
    }
    if (title === null || after === null) throw new Error("no chip text");
    return { title, after };
  }

  it("anchors the words beside a ref chip to their columns", async () => {
    const { container, onStage, button } = await stageSelection(
      CHIP_LINE,
      (c) => {
        const node = c.querySelector("p[data-loc]")?.firstChild;
        if (!node) throw new Error("no paragraph");
        return { node, from: 0, to: 3 };
      },
      { client: chipClient(), ready: "a[data-issue-link]" },
    );
    // The chip renders the issue's title where the source says "#12".
    expect(container.textContent).toContain("A referenced issue");
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 1,
      colEnd: 3,
    });
  });

  it.each([
    [
      "from inside a ref chip to the word after it",
      (container: HTMLElement) => {
        const { title, after } = chipNodes(container);
        return { node: title, from: 1, to: 3, endNode: after };
      },
      // From the link's "[" in column 5 to the "he" of "here".
      { lineStart: 1, lineEnd: 1, colStart: 5, colEnd: 35 },
    ],
    [
      "with both ends inside a ref chip",
      (container: HTMLElement) => {
        const { title } = chipNodes(container);
        return { node: title, from: 1, to: 3 };
      },
      // The whole link, "[" through ")".
      { lineStart: 1, lineEnd: 1, colStart: 5, colEnd: 32 },
    ],
  ])("takes the whole link for a selection %s", async (_name, pick, anchor) => {
    const { onStage, button } = await stageSelection(CHIP_LINE, pick, {
      client: chipClient(),
      ready: "a[data-issue-link]",
    });
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith(anchor);
  });

  const DOC_URL = "/api/projects/p/attachments/6/download/doc.md";

  /** File `id` of issue 1 in project `p`. */
  const attachment = (id: number, filename: string, contentType: string) => ({
    id,
    filename,
    content_type: contentType,
    size: 26,
    url: `/api/projects/p/attachments/${id}/download/${filename}`,
    uploader: {
      id: 1,
      login: "user",
      display_name: "User",
      kind: "human" as const,
      avatar_url: null,
      owner: null,
    },
    created_at: "2026-01-01T00:00:00.000Z",
    aliases: [],
  });

  /** A project whose issue 1 has `doc.md`, drawn as a document card. */
  function docClient(text = "# Embedded\n\nhello from doc\n"): QueryClient {
    const client = chipClient();
    client.setQueryData(attachmentsQuery("p", 1).queryKey, [
      attachment(6, "doc.md", "text/markdown"),
    ]);
    client.setQueryData(attachmentTextQuery(DOC_URL).queryKey, text);
    return client;
  }

  it("anchors the word after a document card to its columns", async () => {
    const body = `see ![doc.md](${DOC_URL}) after\n`;
    const { container, onStage, button } = await stageSelection(
      body,
      (c) => bracketedIn(c, " [after]"),
      { client: docClient(), ready: "[data-loc] .markdown-body" },
    );
    // The card shows the document, which the paragraph's source does not.
    expect(container.textContent).toContain("hello from doc");
    fireEvent.click(button);
    const column = body.indexOf("after") + 1;
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: column,
      colEnd: column + 4,
    });
  });

  it("takes a document card on a line of its own whole", async () => {
    const line = `![doc.md](${DOC_URL})`;
    const { onStage, button } = await stageSelection(
      `${line}\n`,
      (c) => bracketedIn(c, "hello [from] doc"),
      { client: docClient(), ready: "[data-loc] .markdown-body" },
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 1,
      colEnd: line.length,
    });
  });

  it("keeps an image attachment a triple-click ends past to its columns", async () => {
    const client = chipClient();
    client.setQueryData(attachmentsQuery("p", 1).queryKey, [
      attachment(7, "pic.png", "image/png"),
    ]);
    // The click leaves the end at the start of the next paragraph, and the
    // end moves back to the element boundary after the image.
    const { onStage, button } = await stageSelection(
      "See ![pic.png](/api/projects/p/attachments/7/download/pic.png)\n\nnext\n",
      (container) => {
        const [first, second] = container.querySelectorAll("p[data-loc]");
        if (!first?.firstChild || !second) throw new Error("no paragraphs");
        return { node: first.firstChild, from: 0, endNode: second, to: 0 };
      },
      { client, ready: "p[data-loc] img" },
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 1,
      colEnd: 62,
    });
  });

  it("anchors a selection starting on the element boundary before a picture", async () => {
    const { onStage, button } = await stageSelection(
      "![pic](x.png) after\n",
      (container) => {
        const paragraph = container.querySelector("p[data-loc]");
        const after = paragraph?.lastChild;
        if (!paragraph || !after) throw new Error("no paragraph");
        return {
          node: paragraph,
          from: 0,
          endNode: after,
          to: (after as Text).length,
        };
      },
      { ready: "p[data-loc] img" },
    );
    fireEvent.click(button);
    // "![pic](x.png) after" is columns 1 to 19.
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 1,
      colEnd: 19,
    });
  });

  it("anchors the word after a deleted image attachment to its columns", async () => {
    const client = chipClient();
    client.setQueryData(attachmentsQuery("p", 1).queryKey, []);
    client.setQueryData(deletedAttachmentsQuery("p", 1).queryKey, [
      {
        id: 8,
        filename: "gone.png",
        deleted_by: attachment(8, "gone.png", "image/png").uploader,
        deleted_at: "2026-01-02T00:00:00.000Z",
      },
    ]);
    // The page shows "gone.png deleted" where the source has the image.
    const { onStage, button } = await stageSelection(
      "see ![gone.png](/api/projects/p/attachments/8/download/gone.png) after\n",
      (container) => bracketedIn(container, " [after]"),
      { client, ready: "[data-attachment-deleted]" },
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 66,
      colEnd: 70,
    });
  });

  it("takes a document card whole for an end beside a picture in it", async () => {
    const body = `see ![doc.md](${DOC_URL}) after\n`;
    const { onStage, button } = await stageSelection(
      body,
      (container) => {
        const image = container.querySelector("[data-loc] .markdown-body img");
        const parent = image?.parentNode;
        const see = container.querySelector(
          "p[data-loc], div[data-loc]",
        )?.firstChild;
        if (!image || !parent || !see) throw new Error("no card picture");
        // Past the picture, on the element boundary a triple-click leaves.
        const at = Array.prototype.indexOf.call(parent.childNodes, image);
        return { node: see, from: 0, endNode: parent, to: at + 1 };
      },
      {
        client: docClient("![x](/y.png)\n\nhello from doc\n"),
        ready: "[data-loc] .markdown-body img",
      },
    );
    fireEvent.click(button);
    // "see " and the whole "![doc.md](…)", columns 1 to 60.
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 1,
      colEnd: body.indexOf(" after"),
    });
  });

  it("takes a code card whole for a selection in one of its rows", async () => {
    const url = "/api/projects/p/attachments/9/download/a.ts";
    const body = `see ![a.ts](${url}) after\n`;
    const client = chipClient();
    client.setQueryData(attachmentsQuery("p", 1).queryKey, [
      attachment(9, "a.ts", "text/plain"),
    ]);
    client.setQueryData(attachmentTextQuery(url).queryKey, "const a = 1;\n");
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
      client,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("[data-loc] pre code")) throw new Error("no card");
      return el;
    });
    // pierre draws the card's rows in a shadow root, which the mock does not.
    const host = document.createElement("diffs-container");
    container.querySelector("[data-loc] pre")?.after(host);
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<div data-line="1"><span>const a = 1;</span></div>';
    const row = shadow.querySelector("span")?.firstChild;
    // The "a" of "const a = 1;": the whole "![a.ts](…)", columns 5 to 56.
    expect(
      anchorForSelection(
        container,
        buildSegmentIndex(body),
        ends(row, 6, row, 7),
      ),
    ).toEqual({
      lineStart: 1,
      lineEnd: 1,
      colStart: 5,
      colEnd: body.indexOf(" after"),
    });
  });

  /** A project whose `JIRA-42` links out to its tracker. */
  function autolinkClient(): QueryClient {
    const client = chipClient();
    client.setQueryData(referenceConfigQuery("p").queryKey, {
      format: { prefix: null, history: [] },
      autolinks: [
        {
          id: 1,
          prefix: "JIRA-",
          url_template: "https://tracker.example/<num>",
        },
      ],
    } satisfies ReferenceConfig);
    return client;
  }

  const JIRA_42 = "a[href='https://tracker.example/42']";

  // A chip makes the block fail to line up with every element walked into,
  // so these take the path that looks for atoms.
  it.each([
    [
      "a plain link",
      "[#12](/projects/1/issues/12) read [the docs](https://x.example) now\n",
      "the [docs]",
      // The chip's link takes columns 1 to 28.
      { colStart: 40, colEnd: 43 },
    ],
    [
      "a project autolink",
      "[#12](/projects/1/issues/12) fixes JIRA-42 today\n",
      "[JIRA]-42",
      { colStart: 36, colEnd: 39 },
    ],
  ])(
    "anchors a word inside %s beside a chip to its own columns",
    async (_name, body, pick, columns) => {
      const { onStage, button } = await stageSelection(
        body,
        (container) => bracketedIn(container, pick),
        { client: autolinkClient(), ready: "a[data-issue-link]" },
      );
      fireEvent.click(button);
      expect(onStage).toHaveBeenCalledWith({
        lineStart: 1,
        lineEnd: 1,
        ...columns,
      });
    },
  );

  it("anchors a word inside a plain link to its own columns", async () => {
    const { onStage, button } = await stageSelection(
      "read [the docs](https://x.example) now\n",
      (container) => bracketedIn(container, "the [docs]"),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 11,
      colEnd: 14,
    });
  });

  it.each([
    ["inside", "[JIRA]-42", { colStart: 7, colEnd: 10 }],
    ["after", " [today]", { colStart: 15, colEnd: 19 }],
  ])(
    "anchors a word %s a project autolink to its own columns",
    async (_name, pick, columns) => {
      // The renderer cuts the autolink out of a text node the index holds whole.
      const { onStage, button } = await stageSelection(
        "fixes JIRA-42 today\n",
        (container) => bracketedIn(container, pick),
        { client: autolinkClient(), ready: JIRA_42 },
      );
      fireEvent.click(button);
      expect(onStage).toHaveBeenCalledWith({
        lineStart: 1,
        lineEnd: 1,
        ...columns,
      });
    },
  );

  it("keeps the columns beside an autolink cut from text with an escape", async () => {
    // The text the link is cut from is longer in the source than on the
    // page, so the link's span is mapped through that text's pieces.
    const { onStage, button } = await stageSelection(
      "**bold** fixes JIRA-42 \\* today\n",
      (container) => bracketedIn(container, "[bold]"),
      { client: autolinkClient(), ready: JIRA_42 },
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 3,
      colEnd: 6,
    });
  });

  it("anchors a word beside a chip, after an autolink and an escape", async () => {
    // The text holding the autolink is longer in the source than on the
    // page, and the chip sends the block to the path that looks for atoms.
    const { onStage, button } = await stageSelection(
      "[#12](/projects/1/issues/12) fixes JIRA-42 \\* today\n",
      (container) => bracketedIn(container, "* [today]"),
      { client: autolinkClient(), ready: "a[data-issue-link]" },
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 47,
      colEnd: 51,
    });
  });

  it("anchors a word inside an autolink cut from a continuation line", async () => {
    // "\n  JIRA-7" is longer in the source than on the page; the blank
    // piece must not let the link pass for an atom spanning the indent.
    const { onStage, button } = await stageSelection(
      "- *em*\n  JIRA-7\n",
      (container) => bracketedIn(container, "J[IR]A-7"),
      {
        client: autolinkClient(),
        ready: "a[href='https://tracker.example/7']",
      },
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 2,
      lineEnd: 2,
      colStart: 4,
      colEnd: 5,
    });
  });

  it("anchors a word in text holding an object replacement character", async () => {
    const { onStage, button } = await stageSelection(
      "alpha \uFFFC beta gamma\n",
      (container) => bracketedIn(container, "beta [gamma]"),
    );
    fireEvent.click(button);
    // "alpha ", the character and " beta " take columns 1 to 13.
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 14,
      colEnd: 18,
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

  it("keeps the line for an end in a shadow root that is in no card", () => {
    // The shadow root's text reads like the rest of the line, but only a
    // card's rows map, to the whole card.
    const container = document.createElement("div");
    const prose = document.createElement("p");
    prose.setAttribute("data-loc", "1-1");
    prose.append("alpha ");
    const host = document.createElement("span");
    const shadow = host.attachShadow({ mode: "open" });
    const row = document.createElement("span");
    row.textContent = "beta";
    shadow.append(row);
    prose.append(host);
    container.append(prose);
    document.body.append(container);
    try {
      const anchor = anchorForSelection(
        container,
        buildSegmentIndex("alpha beta\n"),
        ends(prose.firstChild, 0, row.firstChild, 2),
      );
      expect(anchor).toEqual({
        lineStart: 1,
        lineEnd: 1,
        colStart: null,
        colEnd: null,
      });
    } finally {
      container.remove();
    }
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

  // pierre is handed a CRLF fence's lines joined by `\r\n`: whether a row
  // keeps its `\r` or not, the row reads as its source line.
  it.each([
    ["without", TOKEN_ROWS],
    [
      "with",
      TOKEN_ROWS.replace(/<\/span><\/div>(?=\s+<div)/g, "\r</span></div>"),
    ],
  ])(
    "anchors a word to its columns in a fence with CRLF line ends, rows drawn %s their \\r",
    (_drawn, rows) => {
      const { container, shadow, index, lines } = fenceWithRows(
        `Intro.\r\n\r\n\`\`\`ts\r\n${CODE_ROWS.join("\r\n")}\r\n\`\`\`\r\n`,
        rows,
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
    },
  );

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
    // The end moves beside the image, which takes its whole `![…](…)`.
    const source = "See ![pic](x.png)\n\nnext\n";
    const container = await rendered(source, "p[data-loc] img");
    const [first, second] = [...container.querySelectorAll("p[data-loc]")];
    expect(
      anchorForSelection(
        container,
        buildSegmentIndex(source),
        ends(first?.firstChild, 0, second, 0),
      ),
    ).toEqual({ lineStart: 1, lineEnd: 1, colStart: 1, colEnd: 17 });
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

describe("anchoring a compared document", () => {
  /**
   * `after` rendered as a comparison against `before`, and its selections
   * anchored as the spec view anchors them.
   */
  async function compared(before: string, after: string, ready = "[data-loc]") {
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={after}
        baselineBody={before}
        annotations={[]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector(ready)) throw new Error("not rendered");
      return el;
    });
    const index = buildSegmentIndex(after);
    const baseline = buildSegmentIndex(before);
    const fences = pairedFences(baseline, index);
    return {
      container,
      anchor: (selected: SelectionEndpoints) =>
        compareAnchorForSelection(container, index, baseline, fences, selected),
    };
  }

  /** The text node under `selector` holding `text`, and where it starts. */
  function textAt(
    container: Element,
    selector: string,
    text: string,
  ): { node: Node; at: number } {
    for (const el of container.querySelectorAll(selector)) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        const at = (n as Text).data.indexOf(text);
        if (at >= 0) return { node: n, at };
      }
    }
    throw new Error(`no ${selector} holds ${JSON.stringify(text)}`);
  }

  /** Endpoints from `from` characters into `a`'s text to `to` into `b`'s. */
  function across(
    a: { node: Node; at: number },
    from: number,
    b: { node: Node; at: number },
    to: number,
  ): SelectionEndpoints {
    return ends(a.node, a.at + from, b.node, b.at + to);
  }

  /** `text` selected whole, wherever under `selector` it is. */
  function word(container: Element, selector: string, text: string) {
    const found = textAt(container, selector, text);
    return across(found, 0, found, text.length);
  }

  /** What a baseline anchor names in `before`, as the server cuts a quote. */
  function quoted(
    before: string,
    anchor: ReturnType<typeof compareAnchorForSelection>,
  ): string {
    if (anchor === null) throw new Error("no anchor");
    expect(anchor.baseline).toBe(true);
    return cut(before.split("\n"), anchor);
  }

  it("anchors a removed word to where it was in the baseline", async () => {
    const before = "Intro.\n\nThe quick brown fox jumps.\n";
    const after = "Intro.\n\nThe quick red fox jumps.\n";
    const { container, anchor } = await compared(before, after);
    const selected = anchor(word(container, "del.spec-del", "brown"));
    expect(selected).toMatchObject({ lineStart: 3, lineEnd: 3 });
    expect(quoted(before, selected)).toBe("brown");
  });

  it("leaves the emphasis markers out of a removed run's edges", async () => {
    const before = "Keep this sentence **old bold** and the rest.\n";
    const after = "Keep this sentence and the rest.\n";
    const { container, anchor } = await compared(before, after);
    // From the first character of `old` to the last of `bold`: both ends
    // sit on a boundary between the plain text and the emphasis.
    expect(quoted(before, anchor(word(container, "del", "old bold")))).toBe(
      "old bold",
    );
    const run = textAt(container, "del", "old bold");
    expect(quoted(before, anchor(across(run, 0, run, 6)))).toBe("old bo");
  });

  it("anchors a word of a restored paragraph to its baseline columns", async () => {
    const before =
      "# Title\n\nFirst para.\n\nRemoved paragraph with words.\n\nLast para.\n";
    const after = "# Title\n\nFirst para.\n\nLast para.\n";
    const { container, anchor } = await compared(
      before,
      after,
      "p.spec-del-structure",
    );
    const selected = anchor(word(container, "p.spec-del-structure", "with"));
    expect(selected).toMatchObject({ lineStart: 5, lineEnd: 5 });
    expect(quoted(before, selected)).toBe("with");
  });

  it("anchors a triple-clicked restored paragraph to its own text", async () => {
    const before =
      "# Title\n\nFirst para.\n\nRemoved paragraph with words.\n\nLast para.\n";
    const after = "# Title\n\nFirst para.\n\nLast para.\n";
    const { container, anchor } = await compared(
      before,
      after,
      "p.spec-del-structure",
    );
    const old = container.querySelector("p.spec-del-structure");
    // Chromium and WebKit end a triple-click at the next block's start.
    const next = old?.nextElementSibling;
    expect(next?.textContent).toBe("Last para.");
    expect(quoted(before, anchor(ends(old?.firstChild, 0, next, 0)))).toBe(
      "Removed paragraph with words.",
    );
  });

  it("anchors inside a marker quoting a removed list item", async () => {
    const before = "- retained alpha\n- **deleted middle**\n- retained omega\n";
    const after =
      "- retained alpha\n\n| separator |\n| --- |\n| divider |\n\n- retained omega\n";
    const { container, anchor } = await compared(
      before,
      after,
      "del.spec-del-block",
    );
    const selected = anchor(word(container, "del.spec-del-block", "middle"));
    expect(selected).toMatchObject({ lineStart: 2, lineEnd: 2 });
    expect(quoted(before, selected)).toBe("middle");
  });

  it("anchors a triple-clicked marker to its own text", async () => {
    const before = "- retained alpha\n- **deleted middle**\n- retained omega\n";
    const after =
      "- retained alpha\n\n| separator |\n| --- |\n| divider |\n\n- retained omega\n";
    const { container, anchor } = await compared(
      before,
      after,
      "del.spec-del-block",
    );
    const marker = container.querySelector("del.spec-del-block");
    // Chromium and WebKit end a triple-click at the next block's start.
    const next = marker?.nextElementSibling;
    expect(next?.tagName).toBe("TABLE");
    expect(quoted(before, anchor(ends(marker?.firstChild, 0, next, 0)))).toBe(
      "- **deleted middle**",
    );
  });

  it("anchors inside the second of two removed items one marker quotes", async () => {
    const before =
      "- retained alpha\n- deleted one\n- deleted two\n- retained omega\n";
    const after =
      "- retained alpha\n\n| separator |\n| --- |\n| divider |\n\n- retained omega\n";
    const { container, anchor } = await compared(
      before,
      after,
      "del.spec-del-block",
    );
    expect(container.querySelectorAll("del.spec-del-block")).toHaveLength(1);
    const selected = anchor(word(container, "del.spec-del-block", "two"));
    expect(selected).toMatchObject({ lineStart: 3, lineEnd: 3 });
    expect(quoted(before, selected)).toBe("two");
  });

  it("anchors inside the marker a structure falls back to", async () => {
    const before =
      "<details>\n<summary>S</summary>\n\nKeep.\n\n</details>\n\nRemoved root.\n";
    const after = "<details>\n<summary>S</summary>\n\nKeep.\n\n</details>\n";
    const { container, anchor } = await compared(
      before,
      after,
      "del.spec-del-block",
    );
    const selected = anchor(word(container, "del.spec-del-block", "root"));
    expect(selected).toMatchObject({ lineStart: 8, lineEnd: 8 });
    expect(quoted(before, selected)).toBe("root");
  });

  it("starts a marker trimmed at its head where its text does", () => {
    const baselineSource = "Intro.\n\n  Old words here.\n";
    const current = "Intro.\n";
    const view = render(
      <QueryClientProvider client={testQueryClient()}>
        <MarkdownView
          rehypePlugins={[
            rehypeSourceLines,
            [
              rehypeDecorations,
              {
                ...NO_DECORATIONS,
                deletions: [
                  {
                    at: current.length,
                    text: "\n  Old words here.",
                    block: true,
                    // What a marker quoting from a line's end looks like.
                    parts: [
                      {
                        kind: "text",
                        text: "\n  Old words here.",
                        origin: { source: baselineSource.indexOf("\n  Old") },
                      },
                    ],
                  },
                ],
              },
            ],
          ]}
        >
          {current}
        </MarkdownView>
      </QueryClientProvider>,
    );
    const container = view.container;
    const first = textAt(container, "del.spec-del-block", "Old");
    const baseline = buildSegmentIndex(baselineSource);
    const selected = compareAnchorForSelection(
      container,
      buildSegmentIndex(current),
      baseline,
      new Map(),
      across(first, 0, first, 1),
    );
    expect(selected).toMatchObject({ lineStart: 3, colStart: 3 });
    expect(quoted(baselineSource, selected)).toBe("O");
  });

  it.each([
    [
      "a cell of a removed row",
      "| name | kept |\n| --- | --- |\n| alpha | gamma |\n| delta | epsilon |\n| eta | iota |\n",
      "| name | kept |\n| --- | --- |\n| alpha | gamma |\n| eta | iota |\n",
      "tr.spec-del-row",
      "epsilon",
      4,
    ],
    [
      "a cell of a removed column",
      "| name | gone | kept |\n| --- | --- | --- |\n| alpha | beta | gamma |\n| eta | theta | iota |\n",
      "| name | kept |\n| --- | --- |\n| alpha | gamma |\n| eta | iota |\n",
      ".spec-del-cell",
      "theta",
      4,
    ],
    [
      "the old text of a cell that was emptied",
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | four |\n",
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 |  |\n",
      "td del.spec-del",
      "four",
      4,
    ],
  ])(
    "anchors %s to the baseline",
    async (_name, before, after, selector, text, line) => {
      const { container, anchor } = await compared(before, after, selector);
      const selected = anchor(word(container, selector, text));
      expect(selected).toMatchObject({ lineStart: line, lineEnd: line });
      expect(quoted(before, selected)).toBe(text);
    },
  );

  /** Rows drawn into the shadow root of `wrapper`, as pierre draws them. */
  function drawRows(wrapper: Element | null, rows: string): ShadowRoot {
    if (wrapper === null) throw new Error("no code block wrapper");
    const host = document.createElement("diffs-container");
    wrapper.append(host);
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.innerHTML = rows;
    return shadow;
  }

  it("anchors a deleted row of an edited block to the baseline's line", async () => {
    // The baseline block opens two lines further down than the current one.
    const before =
      "Intro.\n\nExtra paragraph.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n";
    const after = "Intro.\n\n```ts\nconst a = 1;\nconst b = 3;\n```\n";
    const { container, anchor } = await compared(
      before,
      after,
      "[data-loc-content-start]",
    );
    const shadow = drawRows(
      container.querySelector("[data-loc-content-start]"),
      `<div data-line="1" data-line-type="context">const a = 1;</div>
       <div data-line="2" data-line-type="change-deletion">const b = 2;</div>
       <div data-line="2" data-line-type="change-addition">const b = 3;</div>`,
    );
    const row = shadow.querySelector("[data-line-type='change-deletion']");
    const selected = anchor(ends(row?.firstChild, 6, row?.firstChild, 11));
    expect(selected).toMatchObject({ lineStart: 7, lineEnd: 7 });
    expect(quoted(before, selected)).toBe("b = 2");
  });

  it("anchors a row of a restored code block to the baseline's line", async () => {
    const before = "Intro.\n\n```ts\nold();\nmore();\n```\n\nOutro.\n";
    const after = "Intro.\n\nOutro.\n";
    const { container, anchor } = await compared(
      before,
      after,
      "[data-old-loc].markdown-fence",
    );
    const shadow = drawRows(
      container.querySelector("[data-old-loc].markdown-fence"),
      `<div data-line="1">old();</div><div data-line="2">more();</div>`,
    );
    const row = shadow.querySelector("[data-line='2']");
    const selected = anchor(ends(row?.firstChild, 0, row?.firstChild, 4));
    expect(selected).toMatchObject({ lineStart: 5, lineEnd: 5 });
    expect(quoted(before, selected)).toBe("more");
  });

  it("anchors a selection running out of removed text to the current text", async () => {
    const before = "Intro.\n\nThe quick brown fox jumps.\n";
    const after = "Intro.\n\nThe quick red fox jumps.\n";
    const { container, anchor } = await compared(before, after);
    const selected = anchor(
      across(
        textAt(container, "del.spec-del", "brown"),
        2,
        textAt(container, "p", " fox jumps."),
        4,
      ),
    );
    expect(selected?.baseline).toBeUndefined();
    if (selected === null) throw new Error("no anchor");
    expect(cut(after.split("\n"), selected)).toBe("red fox");
  });

  it("anchors a selection out of a block's first deleted row from the next row", async () => {
    // pierre draws the deleted row first, with no current row before it.
    const before = "Intro.\n\n```ts\na();\n```\n\nAfter text.\n";
    const after = "Intro.\n\n```ts\nb();\n```\n\nAfter text.\n";
    const { container, anchor } = await compared(
      before,
      after,
      "[data-loc-content-start]",
    );
    const shadow = drawRows(
      container.querySelector("[data-loc-content-start]"),
      `<div data-line="1" data-line-type="change-deletion">a();</div>
       <div data-line="1" data-line-type="change-addition">b();</div>`,
    );
    const row = shadow.querySelector("[data-line-type='change-deletion']");
    const text = textAt(container, "p", "After text.");
    // From the current row that follows the deleted one, never from before
    // the block.
    expect(anchor(ends(row?.firstChild, 1, text.node, 5))).toEqual({
      lineStart: after.split("\n").indexOf("b();") + 1,
      colStart: 1,
      lineEnd: after.split("\n").indexOf("After text.") + 1,
      colEnd: 5,
    });
  });

  it("anchors a selection into a block's last deleted row up to the row before it", async () => {
    // pierre draws the deleted row last, with no current row after it.
    const before = "Intro text.\n\n```ts\nb();\na();\n```\n";
    const after = "Intro text.\n\n```ts\nb();\n```\n";
    const { container, anchor } = await compared(
      before,
      after,
      "[data-loc-content-start]",
    );
    const shadow = drawRows(
      container.querySelector("[data-loc-content-start]"),
      `<div data-line="1" data-line-type="context">b();</div>
       <div data-line="2" data-line-type="change-deletion">a();</div>`,
    );
    const row = shadow.querySelector("[data-line-type='change-deletion']");
    const text = textAt(container, "p", "Intro text.");
    // Up to the end of the current row before the deleted one, never past
    // the block.
    expect(anchor(ends(text.node, 6, row?.firstChild, 2))).toEqual({
      lineStart: 1,
      colStart: 7,
      lineEnd: after.split("\n").indexOf("b();") + 1,
      colEnd: 4,
    });
  });

  it("anchors a selection running into a restored paragraph to the current text", async () => {
    const before =
      "# Title\n\nFirst para.\n\nRemoved paragraph with words.\n\nLast para.\n";
    const after = "# Title\n\nFirst para.\n\nLast para.\n";
    const { container, anchor } = await compared(
      before,
      after,
      "p.spec-del-structure",
    );
    const selected = anchor(
      across(
        textAt(container, "p", "First para."),
        6,
        textAt(container, "p.spec-del-structure", "Removed"),
        4,
      ),
    );
    expect(selected?.baseline).toBeUndefined();
    if (selected === null) throw new Error("no anchor");
    expect(cut(after.split("\n"), selected)).toBe("para.");
  });

  it("anchors a selection between two removed paragraphs to the baseline between them", async () => {
    const before =
      "Para one.\n\nOld A here.\n\nPara two.\n\nOld B here.\n\nPara three.\n";
    const after = "Para one.\n\nPara two.\n\nPara three.\n";
    const { container, anchor } = await compared(
      before,
      after,
      "p.spec-del-structure",
    );
    const selected = anchor(
      across(
        textAt(container, "p.spec-del-structure", "Old A"),
        4,
        textAt(container, "p.spec-del-structure", "Old B"),
        5,
      ),
    );
    expect(selected).toMatchObject({ lineStart: 3, lineEnd: 7 });
    expect(quoted(before, selected)).toBe("A here.\n\nPara two.\n\nOld B");
  });

  it("anchors as the current document does where nothing was removed", async () => {
    const source =
      "First paragraph here.\n\nSecond **paragraph** here.\n\n- item one\n- item two\n";
    const { container, anchor } = await compared(source, source);
    const paragraphs = [...container.querySelectorAll("p[data-loc]")];
    const items = [...container.querySelectorAll("li[data-loc]")];
    const index = buildSegmentIndex(source);
    for (const selected of [
      ends(paragraphs[0]?.firstChild, 6, paragraphs[1]?.lastChild, 3),
      ends(paragraphs[0]?.firstChild, 0, paragraphs[1], 0),
      ends(items[1], 0, items[1], 1),
      ends(items[1]?.firstChild, 0, paragraphs[0]?.firstChild, 2),
    ]) {
      const current = anchorForSelection(container, index, selected);
      expect(current).not.toBeNull();
      expect(anchor(selected)).toEqual(current);
    }
  });

  it("starts a restored ordered item at its text, past its old number", async () => {
    const before = "1. first\n2. second removed\n3. third\n";
    const after = "1. first\n2. third\n";
    const { container, anchor } = await compared(
      before,
      after,
      "li.spec-del-structure",
    );
    const item = container.querySelector("li.spec-del-structure");
    const number = item?.querySelector(".spec-list-number");
    const text = textAt(container, "li.spec-del-structure", "second removed");
    const selected = anchor(
      ends(number?.firstChild, 0, text.node, text.at + "second removed".length),
    );
    expect(selected).toMatchObject({ lineStart: 2, lineEnd: 2, colStart: 4 });
    expect(quoted(before, selected)).toBe("second removed");
  });
});
