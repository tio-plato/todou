import type { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  ReferenceConfig,
  SpecCommentItem,
} from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { projectsQuery } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import {
  AnnotatedMarkdown,
  type DisplayedAnnotation,
} from "../src/components/spec/annotated-markdown.tsx";
import { changedLineRanges } from "../src/lib/spec-changes.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

// Same pin as spec-inline-diff: fences go through pierre's lazy CodeView.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

const SINCE = "2026-01-01T00:00:00.000Z";

/** The project spells its issues "T-N", as the card's own project does. */
const PREFIXED: ReferenceConfig = {
  format: { prefix: "T", history: [{ prefix: "T", effective_from: SINCE }] },
  autolinks: [],
};

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
  created_at: SINCE,
  updated_at: SINCE,
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

/** How the resolve pass stores `T-161`: the token as text, the id as href. */
const REF = (number: number) => `[T-${number}](/projects/1/issues/${number})`;

function seeded(...numbers: number[]): QueryClient {
  const client = testQueryClient();
  client.setQueryData(referenceConfigQuery("p").queryKey, PREFIXED);
  client.setQueryData(projectsQuery.queryKey, [
    {
      id: 1,
      slug: "p",
      name: "p",
      description: "",
      created_at: SINCE,
    },
  ]);
  for (const number of numbers) {
    client.setQueryData(
      issueRefQuery("p", number).queryKey,
      refItem(number, `目标议题 ${number}`),
    );
  }
  return client;
}

function comment(anchor: Partial<SpecCommentItem["anchor"]>): SpecCommentItem {
  return {
    comment_id: 1,
    author: {
      id: 1,
      login: "alice",
      display_name: "alice",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    created_at: SINCE,
    body: "note",
    anchor: {
      path: "design.md",
      version: 1,
      line_start: null,
      line_end: null,
      col_start: null,
      col_end: null,
      quote: "",
      ...anchor,
    },
    resolved: null,
    outdated: false,
    current_line_start: null,
    current_line_end: null,
  };
}

/** One column-anchored annotation, of either kind. */
function anchored(
  kind: "comment" | "draft",
  start: number,
  colStart: number,
  end: number,
  colEnd: number,
): DisplayedAnnotation {
  const at = { start, end, colStart, colEnd, key: "c1" };
  return kind === "comment"
    ? {
        ...at,
        kind,
        item: comment({ line_start: start, line_end: end }),
      }
    : {
        ...at,
        kind,
        draft: {
          id: "d1",
          anchor: {
            path: "design.md",
            version: 1,
            line_start: start,
            line_end: end,
            col_start: colStart,
            col_end: colEnd,
          },
          quote: "",
          body: "draft note",
        },
      };
}

async function renderSpec(opts: {
  body: string;
  baselineBody?: string;
  annotations?: DisplayedAnnotation[];
  client?: QueryClient;
  ready?: string;
}) {
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={opts.body}
      baselineBody={opts.baselineBody}
      annotations={opts.annotations ?? []}
      changedRanges={
        opts.baselineBody === undefined
          ? []
          : changedLineRanges(opts.baselineBody, opts.body)
      }
      onStage={() => {}}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
    opts.client,
  );
  const container = await waitFor(() => {
    const el = view.getByTestId("annotated-markdown");
    if (el.querySelector(opts.ready ?? "[data-loc]") === null) {
      throw new Error("not rendered yet");
    }
    return el;
  });
  return { view, container };
}

const texts = (container: HTMLElement, selector: string) =>
  [...container.querySelectorAll(selector)].map((el) => el.textContent);

// T-164, the card's own repro: a selection spanning three blocks left the
// middle one — the only one holding a ref — with no highlight at all,
// while the quote preview underneath proved the anchor had it all along.
describe("annotation highlights across a ref chip (T-164)", () => {
  const BODY = [
    "## 结论，就地展开",
    "",
    `- 第一条 bullet 提到 ${REF(161)} 的做法。`,
    "- 第二条 bullet 没有引用。",
    "",
  ].join("\n");

  it("marks the whole bullet, chip included", async () => {
    const { container } = await renderSpec({
      body: BODY,
      annotations: [anchored("comment", 1, 4, 4, 8)],
      client: seeded(161),
      ready: "a[data-issue-link]",
    });
    const chip = container.querySelector("a[data-issue-link='161']");
    const mark = chip?.closest("mark.spec-mark-comment");
    expect(mark).not.toBeNull();
    // The key is what the popover's "scroll to this" button aims at.
    expect(mark?.getAttribute("data-mark-key")).toBe("c1");
    const marked = texts(container, "li mark.spec-mark-comment").join("");
    expect(marked).toContain("第一条 bullet 提到");
    expect(marked).toContain("的做法。");
    // …and the neighbours the selection also covered.
    expect(texts(container, "h2 mark.spec-mark-comment")).toEqual([
      "结论，就地展开",
    ]);
  });

  it("keeps the chip a chip — no mark spliced into its children", async () => {
    const { container } = await renderSpec({
      body: BODY,
      annotations: [anchored("comment", 3, 3, 3, 20)],
      client: seeded(161),
      ready: "a[data-issue-link]",
    });
    const chip = container.querySelector("a[data-issue-link='161']");
    expect(chip?.textContent).toContain("目标议题 161");
    expect(chip?.querySelector("mark")).toBeNull();
  });

  it("wraps the chip in an insertion when the ref is new (compare mode)", async () => {
    const { container } = await renderSpec({
      body: `- 参考 ${REF(161)} 的既有做法。\n`,
      baselineBody: "- 参考既有做法。\n",
      client: seeded(161),
      ready: "a[data-issue-link]",
    });
    const chip = container.querySelector("a[data-issue-link='161']");
    expect(chip?.closest("ins.spec-ins")).not.toBeNull();
    expect(chip?.textContent).toContain("目标议题 161");
  });

  it("highlights only the anchored words of a wrapped bullet", async () => {
    // The anchor ends on column 5 of "  并且换到第二行继续写。": the
    // continuation's indent is not the item's text, and the rest of the line
    // was never in the anchor's range.
    const { container } = await renderSpec({
      body: `- 第一条 bullet 提到 ${REF(161)}，\n  并且换到第二行继续写。\n- 第二条。\n`,
      annotations: [anchored("comment", 1, 3, 2, 5)],
      client: seeded(161),
      ready: "a[data-issue-link]",
    });
    const chip = container.querySelector("a[data-issue-link='161']");
    expect(chip?.closest("mark.spec-mark-comment")).not.toBeNull();
    const marked = texts(container, "li mark.spec-mark-comment").join("");
    expect(marked).toContain("第一条 bullet 提到");
    expect(marked).toContain("并且换");
    expect(marked).not.toContain("到第二行继续写。");
    expect(container.querySelectorAll("li")[0]?.textContent).toContain(
      "到第二行继续写。",
    );
    // The bullet below was never in the anchor's range.
    expect(container.querySelectorAll("li")[1]?.textContent).toBe("第二条。");
  });
});

// A pasted permalink renders as a chip only while its <a> holds one plain
// text child. Painting a mark in there quietly downgraded it to a bare URL.
describe("a highlighted permalink stays a chip (T-164)", () => {
  const HREF = "http://localhost:3000/projects/p/issues/161";
  const LINE = `见 <${HREF}> 的结论。`;

  it("upgrades under a mark that covers the whole line", async () => {
    const { container } = await renderSpec({
      body: `${LINE}\n`,
      annotations: [anchored("comment", 1, 1, 1, LINE.length)],
      client: seeded(161),
      ready: "a[data-issue-link]",
    });
    const chip = container.querySelector("a[data-issue-link='161']");
    expect(chip?.textContent).toContain("目标议题 161");
    expect(chip?.closest("mark.spec-mark-comment")).not.toBeNull();
    expect(container.textContent).not.toContain(HREF);
  });
});

// The reviewer's second report: an anchor whose columns run across a fence.
// pierre owns the inside of a code block, so the block itself has to say it.
describe("annotations reaching into a code block (T-164)", () => {
  const BODY = [
    "abc",
    "",
    "```bash",
    "$ hello",
    "$ bad",
    "```",
    "",
    "尾段结论。",
    "",
  ].join("\n");

  it("washes the block and keeps the prose marks on either side", async () => {
    const { container } = await renderSpec({
      body: BODY,
      annotations: [anchored("comment", 1, 1, 8, 2)],
    });
    const block = container.querySelector("div[data-loc]");
    expect(block?.classList.contains("spec-mark-comment-block")).toBe(true);
    expect(texts(container, "p mark.spec-mark-comment")).toEqual([
      "abc",
      "尾段",
    ]);
    // Nothing was injected into the code itself — pierre reads it back out
    // by concatenating text children, and a <mark> would delete a line.
    expect(container.querySelector("pre")?.textContent).toBe("$ hello\n$ bad");
    expect(container.querySelector("pre mark")).toBeNull();
  });

  it("wears the draft colour for a staged draft", async () => {
    const { container } = await renderSpec({
      body: BODY,
      annotations: [anchored("draft", 1, 1, 8, 2)],
    });
    const block = container.querySelector("div[data-loc]");
    expect(block?.classList.contains("spec-mark-draft-block")).toBe(true);
    expect(block?.classList.contains("spec-mark-comment-block")).toBe(false);
  });

  it("leaves a fence alone when the anchor stops short of it", async () => {
    const { container } = await renderSpec({
      body: BODY,
      annotations: [anchored("comment", 1, 1, 1, 3)],
    });
    const block = container.querySelector("div[data-loc]");
    expect(block?.className).not.toContain("spec-mark");
  });
});

// An escape or a character reference is one piece of its text node: a
// highlight that reaches into one takes all of it.
describe("annotation highlights over an escape", () => {
  it("takes the escaped character an anchor ends on the backslash of", async () => {
    // In "a \* b c", columns 1 to 3 are "a \", which shows as "a *".
    const { container } = await renderSpec({
      body: "a \\* b c\n",
      annotations: [anchored("comment", 1, 1, 1, 3)],
    });
    expect(texts(container, "mark.spec-mark-comment")).toEqual(["a *"]);
  });
});

// Text whose source is longer than what it shows for more than an escape:
// each used to be highlighted whole.
describe("annotation highlights in text lined up piece by piece", () => {
  // [shape, body, the anchor's line, column, line, column, what is marked].
  it.each([
    [
      "a continuation line opening with >",
      "a\n    >b c\n",
      [2, 8, 2, 8],
      ["c"],
    ],
    ["a reference for a line break", "x &#10; y z\n", [1, 11, 1, 11], ["z"]],
  ] as const)(
    "marks only the anchored characters of %s",
    async (_shape, body, [start, colStart, end, colEnd], marked) => {
      const { container } = await renderSpec({
        body,
        annotations: [anchored("comment", start, colStart, end, colEnd)],
      });
      expect(texts(container, "mark.spec-mark-comment")).toEqual(marked);
    },
  );
});

describe("annotation highlights in a footnote definition", () => {
  it("marks only the anchored word, never the link back", async () => {
    // "[^1]: note here" is line 3; "note" is columns 7 to 10.
    const { container } = await renderSpec({
      body: "text[^1] more words\n\n[^1]: note here\n",
      annotations: [anchored("comment", 3, 7, 3, 10)],
      ready: "a[data-footnote-backref]",
    });
    expect(texts(container, "mark.spec-mark-comment")).toEqual(["note"]);
    const back = container.querySelector("a[data-footnote-backref]");
    expect(back?.closest("mark")).toBeNull();
  });

  it("marks part of a definition that ends in a blank it spells out", async () => {
    // The renderer appends a blank of its own after the one `&#32;` stands
    // for, and only that one is taken off. "ot" is columns 8 and 9.
    const { container } = await renderSpec({
      body: "text[^1] x\n\n[^1]: note&#32;\n",
      annotations: [anchored("comment", 3, 8, 3, 9)],
      ready: "a[data-footnote-backref]",
    });
    expect(texts(container, "mark.spec-mark-comment")).toEqual(["ot"]);
  });

  it("marks the anchored word after an escape in a definition", async () => {
    // "[^1]: note \* here" is line 3; "here" is columns 15 to 18.
    const { container } = await renderSpec({
      body: "text[^1] x\n\n[^1]: note \\* here\n",
      annotations: [anchored("comment", 3, 15, 3, 18)],
      ready: "a[data-footnote-backref]",
    });
    expect(texts(container, "mark.spec-mark-comment")).toEqual(["here"]);
  });
});

// The page shows raw HTML as its own source, and its text can be anchored.
describe("annotation highlights on raw HTML", () => {
  it("paints nothing on raw HTML whose position does not read as its source", async () => {
    // A fold in one block of HTML in a quote: the parser's value has no
    // `> `, so the summary's place, counted in the value, falls short of
    // its place in the source. "Fold" is columns 12 to 15 of line 2.
    const { container } = await renderSpec({
      body: "> <details>\n> <summary>Fold here</summary>\n> </details>\n",
      annotations: [anchored("comment", 2, 12, 2, 15)],
      ready: "summary",
    });
    expect(texts(container, "mark.spec-mark-comment")).toEqual([]);
  });

  it("marks the anchored characters of inline HTML a list item wraps", async () => {
    // "x" is column 3 of line 2, past the item's indent.
    const { container } = await renderSpec({
      body: "- a <kbd\n  x>b</kbd> c\n",
      annotations: [anchored("comment", 2, 3, 2, 3)],
    });
    expect(texts(container, "mark.spec-mark-comment")).toEqual(["x"]);
  });

  // [shape, body, the anchor's line, column, line, column, what is marked].
  it.each([
    [
      // "<details><summary>" is columns 1 to 18; "Fold" 19 to 22.
      "a fold's summary",
      "<details><summary>Fold here</summary>\n\nbody text\n\n</details>\n",
      [1, 19, 1, 22],
      ["Fold"],
    ],
    [
      // "<div>block " is columns 1 to 11; "words" 12 to 16.
      "a block of HTML",
      "<div>block words</div>\n\nafter text\n",
      [1, 12, 1, 16],
      ["words"],
    ],
  ] as const)(
    "marks only the anchored characters of %s",
    async (_shape, body, [start, colStart, end, colEnd], marked) => {
      const { container } = await renderSpec({
        body,
        annotations: [anchored("comment", start, colStart, end, colEnd)],
      });
      expect(texts(container, "mark.spec-mark-comment")).toEqual(marked);
    },
  );
});

// A link drawn as a link shows its own children, so a mark goes on the
// characters anchored inside it, as anywhere else.
describe("annotation highlights inside a plain link", () => {
  it.each([
    // "see [so" is columns 1 to 7; "me te" 8 to 12.
    [
      "a link's text",
      "see [some text](https://example.com) end\n",
      8,
      12,
      "me te",
    ],
    // "go https://" is columns 1 to 11; "example" 12 to 18.
    ["a bare address", "go https://example.com/path now\n", 12, 18, "example"],
  ])(
    "marks only the anchored characters of %s",
    async (_shape, body, colStart, colEnd, marked) => {
      const { container } = await renderSpec({
        body,
        annotations: [anchored("comment", 1, colStart, 1, colEnd)],
      });
      expect(texts(container, "mark.spec-mark-comment")).toEqual([marked]);
      expect(
        container.querySelector("mark.spec-mark-comment")?.closest("a"),
      ).not.toBeNull();
    },
  );
});

describe("annotation highlights beside an autolink", () => {
  it("marks only the anchored word of text an autolink is cut from", async () => {
    const client = seeded();
    client.setQueryData(referenceConfigQuery("p").queryKey, {
      ...PREFIXED,
      autolinks: [
        {
          id: 1,
          prefix: "JIRA-",
          url_template: "https://tracker.example/<num>",
        },
      ],
    } satisfies ReferenceConfig);
    // In "fixes JIRA-42 \* today", "today" is columns 18 to 22.
    const { container } = await renderSpec({
      body: "fixes JIRA-42 \\* today\n",
      annotations: [anchored("comment", 1, 18, 1, 22)],
      client,
      ready: "a[href='https://tracker.example/42']",
    });
    expect(texts(container, "mark.spec-mark-comment")).toEqual(["today"]);
    const link = container.querySelector(
      "a[href='https://tracker.example/42']",
    );
    expect(link?.closest("mark")).toBeNull();
  });
});

describe("annotation highlights inside inline code", () => {
  it("marks only the characters of code the anchor names", async () => {
    // In "a `code` b", columns 5 and 6 are "od".
    const { container } = await renderSpec({
      body: "a `code` b\n",
      annotations: [anchored("comment", 1, 5, 1, 6)],
    });
    expect(texts(container, "mark.spec-mark-comment")).toEqual(["od"]);
    const mark = container.querySelector("mark.spec-mark-comment");
    expect(mark?.parentElement?.tagName).toBe("CODE");
  });
});

// An image shows no text a mark could sit in, so an annotation anchored on
// one — a selection inside a document card anchors to its `![…](…)` — showed
// nowhere on the page but the rail.
describe("annotations reaching onto an image", () => {
  const BODY = "See ![pic](x.png) after\n";

  it("washes the image the anchor covers", async () => {
    const { container } = await renderSpec({
      body: BODY,
      // "![pic](x.png)" occupies columns 5 through 17.
      annotations: [anchored("comment", 1, 5, 1, 17)],
      ready: "img",
    });
    const image = container.querySelector("img");
    expect(image?.classList.contains("spec-mark-comment-block")).toBe(true);
  });

  it("leaves an image alone when the anchor is the word after it", async () => {
    const { container } = await renderSpec({
      body: BODY,
      annotations: [anchored("comment", 1, 19, 1, 23)],
      ready: "img",
    });
    expect(texts(container, "mark.spec-mark-comment")).toEqual(["after"]);
    expect(container.querySelector("img")?.className ?? "").not.toContain(
      "spec-mark",
    );
  });
});
