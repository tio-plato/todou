import { act, waitFor } from "@testing-library/react";
import type { TimelineComment } from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import { QuoteReplyProvider } from "../src/components/timeline/quote-reply.tsx";
import {
  QUOTE_BODY_ATTR,
  quotableSelection,
} from "../src/components/timeline/selection-quote.tsx";
import { inlineActionSource } from "../src/lib/action-text.ts";
import { renderWithProviders } from "./render.tsx";

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

const author = {
  id: 2,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

function comment(
  id: number,
  body: string,
  overrides: Partial<TimelineComment> = {},
): TimelineComment {
  return {
    type: "comment",
    id,
    author,
    body,
    component: null,
    created_at: "2026-08-11T00:00:00Z",
    edited_at: null,
    resolved_at: null,
    hidden_at: null,
    agent_context: null,
    ...overrides,
  };
}

const A = "Alpha one two.\n\nAlpha **three** four.";
const B = "Bravo five six.";

/** Two comments with a node between them that belongs to neither body. */
async function renderTwo(first: TimelineComment, second: TimelineComment) {
  const view = renderWithProviders(
    <QuoteReplyProvider>
      <CommentItem slug="p" issueNumber={7} comment={first} />
      <p data-testid="between">between the two</p>
      <CommentItem slug="p" issueNumber={7} comment={second} />
    </QuoteReplyProvider>,
  );
  const [a, b] = await waitFor(() => {
    const bodies = view.container.querySelectorAll(`[${QUOTE_BODY_ATTR}]`);
    if (bodies.length < 2 || !bodies[1]?.querySelector("[data-loc]")) {
      throw new Error("bodies not rendered yet");
    }
    return [...bodies] as [HTMLElement, HTMLElement];
  });
  return { view, a, b };
}

/** The text node of the `n`th stamped paragraph in `body`. */
function paragraph(body: Element, n: number): Text {
  const text = body.querySelectorAll("p[data-loc]")[n]?.firstChild;
  if (!(text instanceof Text)) throw new Error(`no paragraph ${n}`);
  return text;
}

function select(start: Node, from: number, end: Node, to: number): Selection {
  const range = document.createRange();
  range.setStart(start, from);
  range.setEnd(end, to);
  const selection = window.getSelection();
  if (selection === null) throw new Error("no selection support");
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

type StaticRangeLike = {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
  collapsed: boolean;
};

/**
 * A Selection as a browser with `getComposedRanges` reports one that reaches
 * into a shadow root: the legacy view clamped onto the host and collapsed,
 * the composed range holding the real endpoints.
 */
function shadowSelection(
  host: Element,
  composed: () => StaticRangeLike[],
): Selection {
  const range = document.createRange();
  range.setStart(host, 0);
  return {
    anchorNode: host,
    anchorOffset: 0,
    focusNode: host,
    focusOffset: 0,
    isCollapsed: true,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => "selected",
    getComposedRanges: composed,
  } as unknown as Selection;
}

/** pierre's rows for a comment's code block, drawn into its wrapper. */
function drawRows(body: Element, rows: string): ShadowRoot {
  const wrapper = body.querySelector("[data-loc-content-start]");
  if (wrapper === null) throw new Error("the fence rendered no wrapper");
  const host = document.createElement("diffs-container");
  wrapper.append(host);
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.innerHTML = rows;
  return shadow;
}

const CODE = "Intro.\n\n```ts\nconst a = 1;\nconst b = 2;\n```";
const CODE_ROWS = `
  <div data-line="1"><span>const a = 1;</span></div>
  <div data-line="2"><span>const b = 2;</span></div>`;

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

describe("quotableSelection", () => {
  it("anchors a word selected in one comment to its columns", async () => {
    const { a } = await renderTwo(comment(1, A), comment(2, B));
    const text = paragraph(a, 0);
    const picked = quotableSelection(select(text, 10, text, 13), document);
    expect(picked?.body).toBe(a);
    expect(picked?.source).toBe(A);
    expect(picked?.anchor).toEqual({
      lineStart: 1,
      lineEnd: 1,
      colStart: 11,
      colEnd: 13,
    });
  });

  it("quotes nothing from a selection across two comments", async () => {
    const { a, b } = await renderTwo(comment(1, A), comment(2, B));
    expect(
      quotableSelection(
        select(paragraph(a, 0), 6, paragraph(b, 0), 5),
        document,
      ),
    ).toBeNull();
  });

  it("clamps an end past the body to its last block", async () => {
    const { view, a } = await renderTwo(comment(1, A), comment(2, B));
    const between = view.getByTestId("between").firstChild as Node;
    const picked = quotableSelection(
      select(paragraph(a, 1), 6, between, 4),
      document,
    );
    expect(picked?.body).toBe(a);
    expect(picked?.anchor).toEqual({
      lineStart: 3,
      lineEnd: 3,
      colStart: null,
      colEnd: null,
    });
  });

  it("keeps a selection that ends at the very start of the next comment", async () => {
    // What a triple-click on a comment's last paragraph selects.
    const { a, b } = await renderTwo(comment(1, A), comment(2, B));
    const picked = quotableSelection(
      select(paragraph(a, 1), 0, paragraph(b, 0), 0),
      document,
    );
    expect(picked?.body).toBe(a);
    expect(picked?.anchor.lineStart).toBe(3);
    expect(picked?.anchor.lineEnd).toBe(3);
  });

  it("counts no next comment whose selected part is only whitespace", async () => {
    // A list renders a newline before its first item, which a triple-click
    // ending at the start of that item takes in.
    const { a, b } = await renderTwo(
      comment(1, A),
      comment(2, "- item one\n- item two"),
    );
    const item = b.querySelector("li")?.firstChild;
    if (!item) throw new Error("no list item");
    const picked = quotableSelection(
      select(paragraph(a, 1), 0, item, 0),
      document,
    );
    expect(picked?.body).toBe(a);
  });

  it("anchors in the body as it reads after an edit", async () => {
    let edit: (body: string) => void = () => {};
    function Edited() {
      const [body, setBody] = useState(A);
      edit = setBody;
      return (
        <CommentItem slug="p" issueNumber={7} comment={comment(1, body)} />
      );
    }
    const view = renderWithProviders(<Edited />);
    const before = await waitFor(() => {
      const el = view.container.querySelector(`[${QUOTE_BODY_ATTR}]`);
      if (!el?.querySelector("p[data-loc]")) throw new Error("not rendered");
      return el;
    });
    const edited = "Edited words now.";
    act(() => edit(edited));
    const text = await waitFor(() => {
      const node = paragraph(before, 0);
      if (node.nodeValue !== edited) throw new Error("edit not rendered");
      return node;
    });
    const picked = quotableSelection(select(text, 7, text, 12), document);
    expect(view.container.querySelector(`[${QUOTE_BODY_ATTR}]`)).toBe(before);
    expect(picked?.source).toBe(edited);
    expect(picked?.anchor).toEqual({
      lineStart: 1,
      lineEnd: 1,
      colStart: 8,
      colEnd: 12,
    });
  });

  it("quotes nothing from a selection in a comment's header", async () => {
    const { view } = await renderTwo(comment(1, A), comment(2, B));
    const name = view.getAllByText("Alice")[0]?.firstChild as Node;
    expect(quotableSelection(select(name, 0, name, 3), document)).toBeNull();
  });

  it("reads an action line in the source it renders", async () => {
    const body = "- checks the list";
    const { b } = await renderTwo(
      comment(1, A),
      comment(2, body, { kind: "action" }),
    );
    const text = paragraph(b, 0);
    const picked = quotableSelection(select(text, 2, text, 8), document);
    expect(picked?.body).toBe(b);
    expect(picked?.source).toBe(inlineActionSource(body));
    expect(picked?.source).not.toBe(body);
  });

  it("finds the comment a selection inside its code rows belongs to", async () => {
    const { a } = await renderTwo(comment(1, CODE), comment(2, B));
    const shadow = drawRows(a, CODE_ROWS);
    const row = shadow.querySelector("[data-line='2'] span")?.firstChild;
    if (!row) throw new Error("no row");
    const picked = quotableSelection(
      shadowSelection(shadow.host, () => [
        {
          startContainer: row,
          startOffset: 6,
          endContainer: row,
          endOffset: 11,
          collapsed: false,
        },
      ]),
      document,
    );
    expect(picked?.body).toBe(a);
    expect(picked?.anchor).toEqual({
      lineStart: 5,
      lineEnd: 5,
      colStart: 7,
      colEnd: 11,
    });
  });

  it("quotes nothing from a selection out of one comment's code into the next", async () => {
    const { a, b } = await renderTwo(comment(1, CODE), comment(2, B));
    const shadow = drawRows(a, CODE_ROWS);
    const row = shadow.querySelector("[data-line='2'] span")?.firstChild;
    if (!row) throw new Error("no row");
    expect(
      quotableSelection(
        shadowSelection(shadow.host, () => [
          {
            startContainer: row,
            startOffset: 6,
            endContainer: paragraph(b, 0),
            endOffset: 5,
            collapsed: false,
          },
        ]),
        document,
      ),
    ).toBeNull();
  });

  it("gives up quietly where getComposedRanges rejects the call", async () => {
    const { a } = await renderTwo(comment(1, A), comment(2, B));
    const text = paragraph(a, 0);
    const selection = select(text, 10, text, 13);
    const legacy = Object.assign(Object.create(selection), {
      toString: () => selection.toString(),
      getComposedRanges: () => {
        throw new TypeError("Failed to execute 'getComposedRanges'");
      },
    }) as Selection;
    expect(() => quotableSelection(legacy, document)).not.toThrow();
    expect(quotableSelection(legacy, document)).toBeNull();
  });
});
