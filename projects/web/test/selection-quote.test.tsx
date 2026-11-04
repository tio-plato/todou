import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { TimelineComment } from "@todou/shared";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUOTE_REHYPE_PLUGINS } from "../src/components/issue/entry-actions-menu.tsx";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import {
  QuoteReplyProvider,
  type QuoteTarget,
  useQuoteReply,
  useQuoteSink,
  useQuoteTarget,
} from "../src/components/timeline/quote-reply.tsx";
import {
  quotableSelection,
  SelectionQuote,
} from "../src/components/timeline/selection-quote.tsx";
import { inlineActionSource } from "../src/lib/action-text.ts";
import { POINTER_FINE } from "../src/lib/use-media-query.ts";
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

/**
 * The page's quote targets, as the floating entry and the menu read them;
 * `<Targets />` keeps this pointed at the provider it is rendered under.
 */
let targets: ReadonlyMap<Element, QuoteTarget> = new Map();
function Targets() {
  targets = useQuoteReply().targets;
  return null;
}

/** For sorting elements into document order. */
function inDocumentOrder(a: Element, b: Element): number {
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    ? -1
    : 1;
}

const A = "Alpha one two.\n\nAlpha **three** four.";
const B = "Bravo five six.";

/** The bodies of the entries under `container`, in document order. */
function bodiesIn(container: Element): HTMLElement[] {
  return [...targets.keys()]
    .filter((el): el is HTMLElement => container.contains(el))
    .sort(inDocumentOrder);
}

/** Two comments with a node between them that belongs to neither body. */
async function renderTwo(first: TimelineComment, second: TimelineComment) {
  const view = renderWithProviders(
    <QuoteReplyProvider>
      <Targets />
      <CommentItem slug="p" issueNumber={7} comment={first} />
      <p data-testid="between">between the two</p>
      <CommentItem slug="p" issueNumber={7} comment={second} />
    </QuoteReplyProvider>,
  );
  const [a, b] = await waitFor(() => {
    const bodies = bodiesIn(view.container);
    if (bodies.length < 2 || !bodies[1]?.querySelector("[data-loc]")) {
      throw new Error("bodies not rendered yet");
    }
    return bodies as [HTMLElement, HTMLElement];
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
  vi.unstubAllGlobals();
});

describe("quotableSelection", () => {
  it("anchors a word selected in one comment to its columns", async () => {
    const { a } = await renderTwo(comment(1, A), comment(2, B));
    const text = paragraph(a, 0);
    const picked = quotableSelection(select(text, 10, text, 13), targets);
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
        targets,
      ),
    ).toBeNull();
  });

  it("clamps an end past the body to its last block", async () => {
    const { view, a } = await renderTwo(comment(1, A), comment(2, B));
    const between = view.getByTestId("between").firstChild as Node;
    const picked = quotableSelection(
      select(paragraph(a, 1), 6, between, 4),
      targets,
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
      targets,
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
      targets,
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
    const view = renderWithProviders(
      <>
        <Targets />
        <Edited />
      </>,
    );
    const before = await waitFor(() => {
      const el = bodiesIn(view.container)[0];
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
    const picked = quotableSelection(select(text, 7, text, 12), targets);
    expect(bodiesIn(view.container)[0]).toBe(before);
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
    expect(quotableSelection(select(name, 0, name, 3), targets)).toBeNull();
  });

  it("quotes nothing from a selection run in from a comment's header", async () => {
    const { view, a } = await renderTwo(comment(1, A), comment(2, B));
    const name = view.getAllByText("Alice")[0]?.firstChild as Node;
    expect(
      quotableSelection(select(name, 0, paragraph(a, 0), 5), targets),
    ).toBeNull();
  });

  it("reads an action line in the source it renders", async () => {
    const body = "- checks the list";
    const { b } = await renderTwo(
      comment(1, A),
      comment(2, body, { kind: "action" }),
    );
    const text = paragraph(b, 0);
    const picked = quotableSelection(select(text, 2, text, 8), targets);
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
      targets,
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
        targets,
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
    expect(() => quotableSelection(legacy, targets)).not.toThrow();
    expect(quotableSelection(legacy, targets)).toBeNull();
  });
});

/** One timeline entry: a header outside the body, and the rendered body. */
function Entry({ id, body }: { id: string; body: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const quoteRef = useQuoteTarget(body, bodyRef);
  return (
    <div data-testid={id}>
      <header>{id} wrote</header>
      <div ref={quoteRef}>
        <MarkdownView
          slug="p"
          issueNumber={1}
          rehypePlugins={QUOTE_REHYPE_PLUGINS}
        >
          {body}
        </MarkdownView>
      </div>
    </div>
  );
}

/** Stands in for the comment box. */
function Sink({ onQuote }: { onQuote: (markdown: string) => void }) {
  useQuoteSink(onQuote);
  return null;
}

/**
 * The comment box as it takes a quote: focused, the caret inside it, both
 * set while the quote is being handed over, the way a tap has to for iOS to
 * open the keyboard.
 */
function FocusingSink({ onQuote }: { onQuote: (markdown: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useQuoteSink((markdown) => {
    onQuote(markdown);
    const el = box.current;
    if (el === null) return;
    el.focus();
    const caret = document.createRange();
    caret.selectNodeContents(el);
    caret.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(caret);
  });
  return (
    <div
      ref={box}
      contentEditable
      suppressContentEditableWarning
      tabIndex={-1}
      data-testid="box"
    >
      draft
    </div>
  );
}

function mount({
  withBox = true,
  focusing = false,
}: {
  withBox?: boolean;
  focusing?: boolean;
} = {}) {
  const onQuote = vi.fn();
  const view = render(
    <QueryClientProvider client={testQueryClient()}>
      <QuoteReplyProvider>
        <Entry id="first" body={"Alpha *beta* gamma.\n\nDelta epsilon."} />
        <Entry id="second" body="Zeta eta." />
        {withBox &&
          (focusing ? (
            <FocusingSink onQuote={onQuote} />
          ) : (
            <Sink onQuote={onQuote} />
          ))}
        <SelectionQuote />
      </QuoteReplyProvider>
    </QueryClientProvider>,
  );
  return { view, onQuote };
}

async function rendered(view: ReturnType<typeof render>, id: string) {
  return waitFor(() => {
    const p = view.getByTestId(id).querySelector("p[data-loc]");
    if (!p) throw new Error("not rendered");
    return view.getByTestId(id);
  });
}

/** Let the rAF-batched read run, so "still absent" means something. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

function textOf(el: Element, selector: string): Node {
  const node = el.querySelector(selector)?.firstChild;
  if (!node) throw new Error(`no text under ${selector}`);
  return node;
}

describe("floating Quote reply (T-723)", () => {
  it("quotes the selected block's markdown from inside one body", async () => {
    const { view, onQuote } = mount();
    const first = await rendered(view, "first");
    const alpha = textOf(first, "p[data-loc]");
    select(alpha, 0, alpha, 5);

    const button = await view.findByRole("button", { name: "Quote reply" });
    fireEvent.click(button);
    // The whole paragraph, emphasis intact: the same block granularity as
    // the `…` menu's Quote reply.
    expect(onQuote).toHaveBeenCalledWith("Alpha *beta* gamma.");
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull(),
    );
  });

  it("stays away when the selection runs into the next entry", async () => {
    const { view } = mount();
    const first = await rendered(view, "first");
    const second = await rendered(view, "second");
    select(textOf(first, "p[data-loc]"), 0, textOf(second, "p[data-loc]"), 4);
    await settle();
    expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull();
  });

  it("stays away when the selection reaches the entry's own header", async () => {
    const { view } = mount();
    const first = await rendered(view, "first");
    select(textOf(first, "header"), 0, textOf(first, "p[data-loc]"), 4);
    await settle();
    expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull();
  });

  it("offers nothing on a card with no comment box", async () => {
    const { view } = mount({ withBox: false });
    const first = await rendered(view, "first");
    const alpha = textOf(first, "p[data-loc]");
    select(alpha, 0, alpha, 5);
    await settle();
    expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull();
  });

  it("survives its own press collapsing the selection", async () => {
    const { view, onQuote } = mount();
    const first = await rendered(view, "first");
    const delta = first.querySelectorAll("p[data-loc]")[1]?.firstChild;
    if (!delta) throw new Error("no second paragraph");
    select(delta, 0, delta, 5);
    const button = await view.findByRole("button", { name: "Quote reply" });

    fireEvent.pointerDown(button);
    window.getSelection()?.removeAllRanges();
    fireEvent.pointerUp(button);
    await settle();
    fireEvent.click(button);
    expect(onQuote).toHaveBeenCalledWith("Delta epsilon.");
  });

  it("leaves the caret where the comment box put it", async () => {
    const { view, onQuote } = mount({ focusing: true });
    const first = await rendered(view, "first");
    const alpha = textOf(first, "p[data-loc]");
    select(alpha, 0, alpha, 5);
    fireEvent.click(await view.findByRole("button", { name: "Quote reply" }));
    expect(onQuote).toHaveBeenCalledOnce();
    const box = view.getByTestId("box");
    expect(document.activeElement).toBe(box);
    const caret = window.getSelection();
    expect(caret?.rangeCount).toBe(1);
    expect(caret?.anchorNode && box.contains(caret.anchorNode)).toBe(true);
  });

  it("goes once the selection does", async () => {
    const { view } = mount();
    const first = await rendered(view, "first");
    const alpha = textOf(first, "p[data-loc]");
    select(alpha, 0, alpha, 5);
    await view.findByRole("button", { name: "Quote reply" });
    window.getSelection()?.removeAllRanges();
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull(),
    );
  });

  it("pins a full-width bar to the viewport's foot for touch", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query !== POINTER_FINE,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { view } = mount();
    const first = await rendered(view, "first");
    const alpha = textOf(first, "p[data-loc]");
    select(alpha, 0, alpha, 5);
    const button = await view.findByRole("button", { name: "Quote reply" });
    expect(button.parentElement?.className).toContain("fixed");
  });
});
