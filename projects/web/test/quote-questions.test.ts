import type { Question, QuestionAnswer } from "@todou/shared";
import type { List, Nodes } from "mdast";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../src/lib/markdown-processor.ts";
import { entryQuote } from "../src/lib/quote-questions.ts";

const STORAGE: Question = {
  key: "storage",
  header: "Storage",
  question: "Where should X live?",
  multiple: false,
  options: [
    {
      label: "Reuse the jobs table (recommended)",
      description: "Fewer tables.",
    },
    { label: "A new table for X" },
  ],
};

const NAME: Question = {
  key: "name",
  question: "Which **name**?",
  multiple: true,
  options: [{ label: "`foo`" }, { label: "bar" }],
};

const ANSWERS: QuestionAnswer[] = [
  {
    key: "storage",
    selected: [{ index: 0, label: "Reuse the jobs table (recommended)" }],
    other: "Keep it small.",
    declined: false,
  },
  { key: "name", selected: [], other: null, declined: true },
];

/** The lists at the top level of `markdown`, in order. */
function listsOf(markdown: string): List[] {
  const tree = parseMarkdown(markdown) as Nodes & { children: Nodes[] };
  return tree.children.filter((node): node is List => node.type === "list");
}

describe("entryQuote", () => {
  it("lays out the body, each question and its answer", () => {
    expect(
      entryQuote({
        body: "Two questions below.",
        questions: [STORAGE, NAME],
        answers: ANSWERS,
      }),
    ).toBe(
      [
        "Two questions below.",
        "",
        "**Storage**",
        "",
        "Where should X live?",
        "",
        "- Reuse the jobs table (recommended) — Fewer tables.",
        "- A new table for X",
        "",
        "**Answer:** Reuse the jobs table (recommended) · other: Keep it small.",
        "",
        "Which **name**?",
        "",
        "- `foo`",
        "- bar",
        "",
        "**Answer:** declined to answer",
      ].join("\n"),
    );
  });

  it("names the picked options in their order on the card", () => {
    const question: Question = {
      key: "envs",
      question: "Which environments?",
      multiple: true,
      options: [{ label: "dev" }, { label: "staging" }, { label: "prod" }],
    };
    expect(
      entryQuote({
        body: "Pick some.",
        questions: [question],
        answers: [
          {
            key: "envs",
            selected: [
              { index: 2, label: "prod" },
              { index: 0, label: "dev" },
            ],
            other: null,
            declined: false,
          },
        ],
      }),
    ).toBe(
      [
        "Pick some.",
        "",
        "Which environments?",
        "",
        "- dev",
        "- staging",
        "- prod",
        "",
        "**Answer:** dev · prod",
      ].join("\n"),
    );
  });

  it("puts an other that is not one paragraph below the answer line", () => {
    expect(
      entryQuote({
        body: "One question.",
        questions: [NAME],
        answers: [
          {
            key: "name",
            selected: [{ index: 1, label: "bar" }],
            other: "- one reason\n- another\n",
            declined: false,
          },
        ],
      }),
    ).toBe(
      [
        "One question.",
        "",
        "Which **name**?",
        "",
        "- `foo`",
        "- bar",
        "",
        "**Answer:** bar · other:",
        "",
        "- one reason",
        "- another",
      ].join("\n"),
    );
  });

  it("keeps a multi-line label and a fenced description inside their item", () => {
    const question: Question = {
      key: "shape",
      question: "Which shape?",
      multiple: false,
      options: [
        {
          label: "First line\nsecond line",
          description: "```ts\nconst x = 1;\n```\n\nThen prose.",
        },
        { label: "Plain" },
      ],
    };
    const quote = entryQuote({
      body: "Shapes.",
      questions: [question],
      answers: null,
    });
    expect(quote).toBe(
      [
        "Shapes.",
        "",
        "Which shape?",
        "",
        "- First line",
        "  second line",
        "",
        "  ```ts",
        "  const x = 1;",
        "  ```",
        "",
        "  Then prose.",
        "- Plain",
      ].join("\n"),
    );
    const lists = listsOf(quote);
    expect(lists).toHaveLength(1);
    expect(lists[0]?.children).toHaveLength(2);
  });

  it("keeps a header on one line, its bold whole", () => {
    expect(
      entryQuote({
        body: "One.",
        questions: [{ ...NAME, header: " Two \n  lines " }],
        answers: null,
      }),
    ).toBe(
      [
        "One.",
        "",
        "**Two lines**",
        "",
        "Which **name**?",
        "",
        "- `foo`",
        "- bar",
      ].join("\n"),
    );
  });

  it("writes no answer line while the answers are unknown", () => {
    expect(
      entryQuote({
        body: "Two questions below.",
        questions: [STORAGE, NAME],
        answers: null,
      }),
    ).toBe(
      [
        "Two questions below.",
        "",
        "**Storage**",
        "",
        "Where should X live?",
        "",
        "- Reuse the jobs table (recommended) — Fewer tables.",
        "- A new table for X",
        "",
        "Which **name**?",
        "",
        "- `foo`",
        "- bar",
      ].join("\n"),
    );
  });
});
