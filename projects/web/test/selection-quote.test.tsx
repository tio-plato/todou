import { act, fireEvent, waitFor } from "@testing-library/react";
import type { QuestionsComponent, TimelineComment } from "@todou/shared";
import { type ReactNode, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import {
  QuoteReplyProvider,
  useQuoteSink,
} from "../src/components/timeline/quote-reply.tsx";
import {
  QUOTE_BODY_ATTR,
  quotableSelection,
  quoteOfQuotable,
  SelectionQuote,
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

/** Each comment's body, which comes before anything else quotable in it. */
function bodiesIn(container: Element): HTMLElement[] {
  return [...container.querySelectorAll("[data-comment-id]")].flatMap(
    (entry) => entry.querySelector<HTMLElement>(`[${QUOTE_BODY_ATTR}]`) ?? [],
  );
}

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

const LIST = "- First item.\n- Second item with `code` in it.\n- Third item.";
const PROSE_AND_CODE =
  "Intro words.\n\n```ts\nconst a = 1;\n```\n\nOutro words.";

/** The markdown a picked selection quotes, as the composer receives it. */
function quoted(picked: ReturnType<typeof quotableSelection>): string | null {
  return picked === null ? null : quoteOfQuotable(picked);
}

/**
 * The one part a selection picked, once it is shown to be the only one and
 * to belong to the entry `body` sits in: the root of its comment or line.
 */
function onlyPart(picked: ReturnType<typeof quotableSelection>, body: Element) {
  expect(picked?.parts).toHaveLength(1);
  expect(picked?.entry).toBe(body.closest("[data-comment-id]"));
  return picked?.parts[0];
}

const ASKING: QuestionsComponent = {
  type: "questions",
  questions: [
    {
      key: "storage",
      header: "Storage",
      question: "Where should X live?",
      multiple: false,
      options: [
        { label: "Reuse the **jobs** table", description: "Fewer tables." },
        { label: "A new table for X" },
      ],
    },
  ],
};

const ANSWER = {
  event_id: 7,
  actor: author,
  created_at: "2026-08-12T00:00:00Z",
  answers: [
    {
      key: "storage",
      selected: [{ index: 0, label: "Reuse the **jobs** table" }],
      other: "Keep it small.",
      declined: false,
    },
  ],
};

/**
 * `/questions` for the card, answering for comment 1 with `answer`: the form
 * for null, the answered card otherwise.
 */
function stubQuestions(answer: typeof ANSWER | null) {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    if (url.includes("/questions")) {
      return Response.json({
        items: [
          {
            comment_id: 1,
            author,
            created_at: "2026-08-11T00:00:00Z",
            questions: ASKING.questions,
            answer,
          },
        ],
        open: answer === null ? 1 : 0,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** The first text node under `root` that holds `text`. */
function textWith(root: Element, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue?.includes(text)) return node as Text;
  }
  throw new Error(`no text "${text}"`);
}

/** A question comment of body A, then B, its card settled as `answer` says. */
async function renderAsking(answer: typeof ANSWER | null) {
  stubQuestions(answer);
  const { view, a, b } = await renderTwo(
    comment(1, A, { component: ASKING }),
    comment(2, B),
  );
  await view.findByText(answer === null ? "awaiting answer" : "answered by");
  const prompt = await view.findByText("Where should X live?");
  const card = prompt.closest("[data-question-key]");
  if (card === null) throw new Error("no question card");
  return { view, a, b, card };
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

describe("quotableSelection", () => {
  it("anchors a word selected in one comment to its columns", async () => {
    const { a } = await renderTwo(comment(1, A), comment(2, B));
    const text = paragraph(a, 0);
    const picked = quotableSelection(select(text, 10, text, 13), document);
    const part = onlyPart(picked, a);
    expect(part?.el).toBe(a);
    expect(part?.source).toBe(A);
    expect(part?.anchor).toEqual({
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

  it("quotes up to the body's last character from a drag past its end", async () => {
    const { view, a } = await renderTwo(comment(1, A), comment(2, B));
    const between = view.getByTestId("between").firstChild as Node;
    const picked = quotableSelection(
      select(paragraph(a, 1), 6, between, 4),
      document,
    );
    expect(onlyPart(picked, a)?.el).toBe(a);
    expect(quoted(picked)).toBe("**three** four.");
  });

  // A triple-click leaves an end on an element boundary rather than in text:
  // Chromium and WebKit end at the start of the next block, Firefox wraps
  // the block's element.
  it.each([
    [
      "ends at the next item's element",
      (items: Element[]) => {
        select(items[1]?.firstChild as Node, 0, items[2] as Node, 0);
      },
    ],
    [
      "wraps the item's element",
      (items: Element[]) => {
        const item = items[1] as Node;
        select(item, 0, item, item.childNodes.length);
      },
    ],
    [
      "ends between the two items",
      (items: Element[]) => {
        const list = items[1]?.parentNode as Node;
        const next = [...list.childNodes].indexOf(items[2] as ChildNode);
        select(items[1]?.firstChild as Node, 0, list, next);
      },
    ],
    [
      "is made backwards from the next item's element",
      (items: Element[]) => {
        window
          .getSelection()
          ?.setBaseAndExtent(
            items[2] as Node,
            0,
            items[1]?.firstChild as Node,
            0,
          );
      },
    ],
  ])(
    "quotes only the text of an item whose selection %s",
    async (_name, pick) => {
      const { a } = await renderTwo(comment(1, LIST), comment(2, B));
      pick([...a.querySelectorAll("li")]);
      expect(quoted(quotableSelection(window.getSelection(), document))).toBe(
        "Second item with `code` in it.",
      );
    },
  );

  it("quotes from the body's first character for a drag in from above it", async () => {
    const { view, b } = await renderTwo(comment(1, A), comment(2, B));
    const between = view.getByTestId("between").firstChild as Node;
    expect(
      quoted(
        quotableSelection(select(between, 4, paragraph(b, 0), 5), document),
      ),
    ).toBe("Bravo");
  });

  it("quotes only the text of a body's last item selected past the body", async () => {
    const { view, a } = await renderTwo(comment(1, LIST), comment(2, B));
    const last = a.querySelectorAll("li")[2]?.firstChild as Node;
    const between = view.getByTestId("between").firstChild as Node;
    expect(
      quoted(quotableSelection(select(last, 0, between, 0), document)),
    ).toBe("Third item.");
  });

  it("keeps a code block that ends the selected prose", async () => {
    const { a } = await renderTwo(comment(1, PROSE_AND_CODE), comment(2, B));
    // Highlighted, the block shows pierre's rows and no plain text.
    a.querySelector("[data-loc-content-start]")?.replaceChildren();
    drawRows(a, '<div data-line="1"><span>const a = 1;</span></div>');
    const outro = a.querySelectorAll("p[data-loc]")[1] as Node;
    expect(
      quoted(quotableSelection(select(paragraph(a, 0), 0, outro, 0), document)),
    ).toBe("Intro words.\n\n```ts\nconst a = 1;\n```");
  });

  it("leaves out a code block the selection only touches", async () => {
    // Before highlighting, a triple-click on the paragraph above ends at the
    // start of the block's plain text.
    const { a } = await renderTwo(comment(1, PROSE_AND_CODE), comment(2, B));
    const wrapper = a.querySelector("[data-loc-content-start]");
    const plain = wrapper?.firstChild as Node;
    expect(
      quoted(quotableSelection(select(paragraph(a, 0), 0, plain, 0), document)),
    ).toBe("Intro words.");
  });

  it("keeps a selection that ends at the very start of the next comment", async () => {
    // What a triple-click on a comment's last paragraph selects.
    const { a, b } = await renderTwo(comment(1, A), comment(2, B));
    const picked = quotableSelection(
      select(paragraph(a, 1), 0, paragraph(b, 0), 0),
      document,
    );
    const part = onlyPart(picked, a);
    expect(part?.el).toBe(a);
    expect(part?.anchor.lineStart).toBe(3);
    expect(part?.anchor.lineEnd).toBe(3);
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
    expect(onlyPart(picked, a)?.el).toBe(a);
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
    const part = onlyPart(picked, before);
    expect(part?.source).toBe(edited);
    expect(part?.anchor).toEqual({
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
    const part = onlyPart(picked, b);
    expect(part?.el).toBe(b);
    expect(part?.source).toBe(inlineActionSource(body));
    expect(part?.source).not.toBe(body);
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
    const part = onlyPart(picked, a);
    expect(part?.el).toBe(a);
    expect(part?.anchor).toEqual({
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

  it("quotes from a question's prompt into its second option as a list", async () => {
    const { card } = await renderAsking(null);
    const prompt = textWith(card, "Where should X live?");
    const second = textWith(card, "A new table for X");
    expect(
      quoted(quotableSelection(select(prompt, 15, second, 5), document)),
    ).toBe(
      [
        "live?",
        "",
        "- Reuse the **jobs** table — Fewer tables.",
        "- A new",
      ].join("\n"),
    );
  });

  it("quotes from a comment's body into its question, the header whole", async () => {
    const { a, card } = await renderAsking(null);
    const prompt = textWith(card, "Where should X live?");
    expect(
      quoted(
        quotableSelection(
          select(textWith(a, " four."), 1, prompt, 12),
          document,
        ),
      ),
    ).toBe(["four.", "", "**Storage**", "", "Where should"].join("\n"));
  });

  it("quotes from an answered card's last option into its other text", async () => {
    const { card } = await renderAsking(ANSWER);
    const last = textWith(card, "A new table for X");
    const other = textWith(card, "Keep it small.");
    expect(quoted(quotableSelection(select(last, 6, other, 7), document))).toBe(
      ["- table for X", "", "other: Keep it"].join("\n"),
    );
  });

  it("quotes the selection where getComposedRanges refuses every call", async () => {
    const { a } = await renderTwo(comment(1, A), comment(2, B));
    const text = paragraph(a, 0);
    const selection = select(text, 10, text, 13);
    Object.defineProperty(selection, "getComposedRanges", {
      configurable: true,
      value: () => {
        throw new TypeError("Failed to execute 'getComposedRanges'");
      },
    });
    try {
      const part = onlyPart(quotableSelection(selection, document), a);
      expect(part?.el).toBe(a);
      expect(part?.anchor).toEqual({
        lineStart: 1,
        lineEnd: 1,
        colStart: 11,
        colEnd: 13,
      });
    } finally {
      delete (selection as { getComposedRanges?: unknown }).getComposedRanges;
    }
  });
});

/** Stands in for the page's comment box, so quotes have somewhere to land. */
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

/** The card page's part in this: two comments, the floating entry, a box. */
function Page({
  first = comment(1, A),
  children,
}: {
  first?: TimelineComment;
  children?: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <div ref={content} className="relative">
      <CommentItem slug="p" issueNumber={7} comment={first} />
      <CommentItem slug="p" issueNumber={7} comment={comment(2, B)} />
      <SelectionQuote containerRef={content} />
      {children}
    </div>
  );
}

async function renderPage(box?: "plain" | "focusing", first?: TimelineComment) {
  const onQuote = vi.fn();
  const view = renderWithProviders(
    <QuoteReplyProvider>
      <Page first={first}>
        {box === "plain" && <Sink onQuote={onQuote} />}
        {box === "focusing" && <FocusingSink onQuote={onQuote} />}
      </Page>
    </QuoteReplyProvider>,
  );
  const [a, b] = await waitFor(() => {
    const bodies = bodiesIn(view.container);
    if (bodies.length < 2 || !bodies[1]?.querySelector("[data-loc]")) {
      throw new Error("bodies not rendered yet");
    }
    return bodies as [HTMLElement, HTMLElement];
  });
  return { view, a, b, onQuote };
}

/** The bold word in A's second paragraph, selected. */
function selectBold(a: Element): void {
  const bold = a.querySelector("strong")?.firstChild;
  if (!bold) throw new Error("no bold word");
  select(bold, 0, bold, 5);
}

/**
 * Let the rAF-batched recompute run and React commit it, so that "no button"
 * is a verdict rather than a frame the entry has not looked at yet.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

describe("SelectionQuote", () => {
  it("quotes the selected word in its markdown and steps aside", async () => {
    const { view, a, onQuote } = await renderPage("plain");
    selectBold(a);
    fireEvent.click(await view.findByRole("button", { name: "Quote reply" }));
    expect(onQuote).toHaveBeenCalledExactlyOnceWith("**three**");
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull(),
    );
    expect(window.getSelection()?.toString()).toBe("");
  });

  it("quotes what was selected when its own press clears the selection", async () => {
    const { view, a, onQuote } = await renderPage("plain");
    selectBold(a);
    const button = await view.findByRole("button", { name: "Quote reply" });
    fireEvent.pointerDown(button, { pointerType: "mouse" });
    window.getSelection()?.removeAllRanges();
    await settle();
    fireEvent.pointerUp(button, { pointerType: "mouse" });
    fireEvent.click(button);
    expect(onQuote).toHaveBeenCalledExactlyOnceWith("**three**");
  });

  it("offers nothing where there is no comment box", async () => {
    const { view, a } = await renderPage();
    selectBold(a);
    await settle();
    expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull();
  });

  it("offers nothing for a selection across two comments", async () => {
    const { view, a, b } = await renderPage("plain");
    select(paragraph(a, 0), 6, paragraph(b, 0), 5);
    await settle();
    expect(view.queryByRole("button", { name: "Quote reply" })).toBeNull();
  });

  it("quotes a word selected in an option of a question's form", async () => {
    stubQuestions(null);
    const { view, onQuote } = await renderPage(
      "plain",
      comment(1, A, { component: ASKING }),
    );
    await view.findByText("awaiting answer");
    const jobs = await waitFor(() => textWith(view.container, "jobs"));
    select(jobs, 0, jobs, 4);
    fireEvent.click(await view.findByRole("button", { name: "Quote reply" }));
    expect(onQuote).toHaveBeenCalledExactlyOnceWith("**jobs**");
  });

  it("leaves the caret where the comment box put it", async () => {
    const { view, a, onQuote } = await renderPage("focusing");
    selectBold(a);
    fireEvent.click(await view.findByRole("button", { name: "Quote reply" }));
    expect(onQuote).toHaveBeenCalledExactlyOnceWith("**three**");
    const box = view.getByTestId("box");
    expect(document.activeElement).toBe(box);
    const caret = window.getSelection();
    expect(caret?.rangeCount).toBe(1);
    expect(caret?.anchorNode && box.contains(caret.anchorNode)).toBe(true);
  });
});
