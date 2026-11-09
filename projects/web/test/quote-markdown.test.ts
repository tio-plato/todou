import type { Nodes } from "mdast";
import { describe, expect, it } from "vitest";
import type { AnchorRange } from "../src/components/spec/selection-entry.tsx";
import { parseMarkdown } from "../src/lib/markdown-processor.ts";
import {
  blockquote,
  quotedReference,
  quoteOfSelection,
  sourceLines,
} from "../src/lib/quote-markdown.ts";

describe("blockquote", () => {
  it("prefixes every line and keeps paragraphs in one block", () => {
    expect(blockquote("first\n\nsecond")).toBe("> first\n>\n> second");
  });

  it("nests a quote that was already quoted", () => {
    expect(blockquote("> said before")).toBe("> > said before");
  });

  it("writes a blank line as a bare marker, whitespace and all", () => {
    expect(blockquote("a\n   \nb")).toBe("> a\n>\n> b");
  });

  it("takes a fence whole, marker lines included", () => {
    expect(blockquote("```ts\nconst x = 1;\n```")).toBe(
      "> ```ts\n> const x = 1;\n> ```",
    );
  });

  it("drops the trailing blank lines rather than quoting them", () => {
    expect(blockquote("only line\n\n\n")).toBe("> only line");
  });

  it("gives an empty body a single marker", () => {
    expect(blockquote("")).toBe(">");
  });
});

describe("sourceLines", () => {
  const body = "one\ntwo\nthree\nfour";

  it("takes a closed interval", () => {
    expect(sourceLines(body, 2, 3)).toBe("two\nthree");
  });

  it("takes a single line when both ends agree", () => {
    expect(sourceLines(body, 4, 4)).toBe("four");
  });

  it("clamps both ends into the body", () => {
    expect(sourceLines(body, 0, 99)).toBe(body);
  });

  it("returns nothing when the range starts past the end", () => {
    expect(sourceLines(body, 10, 12)).toBe("");
  });
});

describe("quotedReference", () => {
  it("puts the quote, a blank line and the attribution in that order", () => {
    expect(
      quotedReference({
        body: "the finding\n\nand the number",
        authorLogin: "alice",
        permalink: "https://todou.example/projects/p/issues/370#comment-1234",
      }),
    ).toBe(
      [
        "> the finding",
        ">",
        "> and the number",
        "",
        "_Originally posted by @alice in https://todou.example/projects/p/issues/370#comment-1234_",
      ].join("\n"),
    );
  });

  it("leaves only the attribution when there is no body to quote", () => {
    expect(
      quotedReference({
        body: "   \n\n  ",
        authorLogin: "alice",
        permalink: "https://todou.example/projects/p/issues/370",
      }),
    ).toBe(
      "_Originally posted by @alice in https://todou.example/projects/p/issues/370_",
    );
  });
});

/**
 * The anchor of a selection running from the first character of `first` to
 * the last of `last`, as they lie in `source`: 1-based lines, inclusive
 * columns. `first` has to be unique, so the test says what it selects.
 */
function span(source: string, first: string, last = first): AnchorRange {
  const from = source.indexOf(first);
  if (from < 0 || source.indexOf(first, from + 1) >= 0) {
    throw new Error(`"${first}" is not in the source exactly once`);
  }
  const to = source.indexOf(last, from) + last.length;
  if (to < from + last.length) throw new Error(`no "${last}" after it`);
  const at = (offset: number) => {
    const lines = source.slice(0, offset).split("\n");
    return { line: lines.length, col: (lines.at(-1)?.length ?? 0) + 1 };
  };
  const start = at(from);
  const end = at(to - 1);
  return {
    lineStart: start.line,
    colStart: start.col,
    lineEnd: end.line,
    colEnd: end.col,
  };
}

/** The text a node holds, its children's joined. */
function textOf(node: Nodes): string {
  if ("value" in node) return node.value;
  return "children" in node
    ? (node.children as Nodes[]).map(textOf).join("")
    : "";
}

describe("quoteOfSelection", () => {
  describe("inside one paragraph, heading or cell", () => {
    it.each([
      ["foo **bar baz** qux", "baz", "baz", "**baz**"],
      ["foo **bar baz** qux", "baz", "qux", "**baz** qux"],
      ["foo **bar baz** qux", "foo", "bar", "foo **bar**"],
      ["foo **bar baz** qux", " baz", " baz", "**baz**"],
      ["foo **bar baz** qux", "bar ", "bar ", "**bar**"],
      ["**a *b c* d**", "c*", "d", "***c* d**"],
      ["**a [b c](u) d**", "a [", "b", "**a [b](u)**"],
      ["[**a b** c](u)", "b*", "b", "[**b**](u)"],
      [
        "see [the docs](https://x.test/a) now",
        "docs",
        "now",
        "[docs](https://x.test/a) now",
      ],
      ["run `pnpm test` first", "test`", "fir", "`pnpm test` fir"],
      ["go to https://x.test/a/b now", "x.test", "/a", "https://x.test/a/b"],
      [
        "see <https://x.test/a/b> now",
        "x.test",
        "x.test",
        "<https://x.test/a/b>",
      ],
      ["## Install the CLI", "the", "CLI", "the CLI"],
      ["| a b | c |\n| --- | --- |", "b |", "b", "b"],
      ["---\nname: Some value here\n---\n\nbody", "value", "value", "value"],
      ["---\nname: Some value here\n---\n\nbody", "name", "name", "name"],
    ])(
      "quotes %j, selected from %j to %j, as %j",
      (source, first, last, quote) => {
        expect(quoteOfSelection(source, span(source, first, last))).toBe(quote);
      },
    );

    it.each([
      ["starts", { colStart: 6, colEnd: 9 }],
      ["ends", { colStart: 7, colEnd: 10 }],
    ])("takes the whole marker an anchor %s inside", (_edge, cols) => {
      expect(
        quoteOfSelection("foo **bar** baz", {
          lineStart: 1,
          lineEnd: 1,
          ...cols,
        }),
      ).toBe("**bar**");
    });

    it("drops the quote's `>` from the line a selection crosses onto", () => {
      const source = "> one two\n> three four";
      expect(quoteOfSelection(source, span(source, "two", "three"))).toBe(
        "two\nthree",
      );
    });

    it("takes a quoted paragraph whole when its columns span it", () => {
      // What the selection above arrives as today: the quote's `>` is not on
      // screen, so the run of text around it is mapped end to end.
      const source = "> one two\n> three four";
      expect(
        quoteOfSelection(source, {
          lineStart: 1,
          colStart: 3,
          lineEnd: 2,
          colEnd: 12,
        }),
      ).toBe("one two\nthree four");
    });

    it("drops a list item's indent from the line a selection crosses onto", () => {
      const source = "- first line\n  second line";
      expect(quoteOfSelection(source, span(source, "line\n", "second"))).toBe(
        "line\nsecond",
      );
    });

    it("starts after the `>` a selection from the line above lands on", () => {
      const source = "> one two\n> three four";
      expect(
        quoteOfSelection(source, {
          lineStart: 2,
          colStart: 1,
          lineEnd: 2,
          colEnd: 7,
        }),
      ).toBe("three");
    });
  });

  describe("inside a block of HTML", () => {
    // The page shows block HTML as its source, a fold's tags aside.
    it.each([
      ["<div>block words</div>", "words", "words"],
      [
        "<details><summary>Fold here</summary>\n\nbody text\n\n</details>",
        "Fold",
        "Fold",
      ],
    ])("quotes %j, selected on %j, as %j", (source, selected, quote) => {
      expect(quoteOfSelection(source, span(source, selected))).toBe(quote);
    });
  });

  describe("inside a code block", () => {
    const quoted = "```ts\nb = 2;\nconst c\n```";

    it.each([
      ["a fence", "```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```"],
      [
        "a fence in a quote",
        "> ```ts\n> const a = 1;\n> const b = 2;\n> const c = 3;\n> ```",
      ],
      [
        "a fence in a nested list item",
        "- item\n  - nested\n\n    ```ts\n    const a = 1;\n    const b = 2;\n    const c = 3;\n    ```",
      ],
      ["a fence left open", "```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;"],
    ])(
      "quotes the selected part of %s as a fence of its own",
      (_shape, source) => {
        expect(quoteOfSelection(source, span(source, "b = 2", "const c"))).toBe(
          quoted,
        );
      },
    );

    it("fences the lines of an indented block", () => {
      const source =
        "Intro.\n\n    const a = 1;\n    const b = 2;\n    const c = 3;";
      expect(quoteOfSelection(source, span(source, "b = 2", "const c"))).toBe(
        "```\nb = 2;\nconst c\n```",
      );
    });

    it("fences an indented block holding a fence with a longer one", () => {
      const source = "Intro.\n\n    ```\n    const b = 2;\n";
      expect(quoteOfSelection(source, span(source, "```", "const b"))).toBe(
        "````\n```\nconst b\n````",
      );
    });

    it("fences an indented block holding an indented fence with a longer one", () => {
      const source = "Intro.\n\n      ```\n    x";
      expect(quoteOfSelection(source, span(source, "```", "x"))).toBe(
        "````\n```\nx\n````",
      );
    });

    it.each([
      ["```ts\nconst alpha = 1;\n```", "alpha", "alpha", "`alpha`"],
      ["> ```ts\n> const alpha = 1;\n> ```", "alpha", "alpha", "`alpha`"],
      ["```sh\necho `date` now\n```", "`date`", "`date`", "`` `date` ``"],
      ["```ts\r\nconst alpha = 1;\r\n```\r\n", "alpha", "alpha", "`alpha`"],
    ])(
      "quotes a few characters of one code line in %j as inline code",
      (source, first, last, quote) => {
        expect(quoteOfSelection(source, span(source, first, last))).toBe(quote);
      },
    );

    it("leaves out a first line the selection starts at the end of", () => {
      const source = "```ts\nconst a = 1;\nconst b = 2;\n```";
      // Column 13 of line 2 is its line ending.
      expect(
        quoteOfSelection(source, {
          lineStart: 2,
          colStart: 13,
          lineEnd: 3,
          colEnd: 7,
        }),
      ).toBe("`const b`");
    });

    it("fences the whole lines of an indented block holding an indented fence", () => {
      // An anchor with no columns takes whole lines: one of them opens with
      // a fence indented two spaces, which still closes a fence.
      const source = "Intro.\n\n      ```\n    x";
      expect(
        quoteOfSelection(source, {
          lineStart: 3,
          colStart: null,
          lineEnd: 4,
          colEnd: null,
        }),
      ).toBe("````\n  ```\nx\n````");
    });

    it("grows the fence a line cut down to a marker's run would close", () => {
      const source = "```\nUse ```\nx\n```";
      // From the backticks that end line 2.
      expect(
        quoteOfSelection(source, {
          lineStart: 2,
          colStart: 5,
          lineEnd: 3,
          colEnd: 1,
        }),
      ).toBe("````\n```\nx\n````");
    });

    it("quotes an empty fence as an empty fence", () => {
      const source = "Intro.\n\n```ts\n```";
      expect(
        quoteOfSelection(source, {
          lineStart: 3,
          colStart: null,
          lineEnd: 3,
          colEnd: null,
        }),
      ).toBe("```ts\n```");
    });

    it("takes every line when only the opening fence is selected", () => {
      const source = "```ts\nconst a = 1;\nconst b = 2;\n```";
      expect(quoteOfSelection(source, span(source, "ts"))).toBe(source);
    });
  });

  describe("across blocks", () => {
    it("cuts two paragraphs at the selection's ends", () => {
      const source = "First para here.\n\nSecond one here.\n\nThird.";
      expect(quoteOfSelection(source, span(source, "para", "Second"))).toBe(
        "para here.\n\nSecond",
      );
    });

    // A tab counts the columns its tab stop gives it where it stands in the
    // source, wherever the quote puts what follows a prefix taken off.
    it.each([
      [
        "code a quote's marker cuts a tab of",
        "> one two\n>\n>\t\tcode here\n>\n> five",
        "five",
        [
          ["paragraph", "two"],
          ["code", "  code here"],
          ["paragraph", "five"],
        ],
      ],
      [
        "a paragraph a tab indents past an item's blanks",
        "- one two\n\n  \tthree four",
        "three",
        [
          ["paragraph", "two"],
          ["paragraph", "three"],
        ],
      ],
    ])("keeps the blocks of %s", (_shape, source, last, blocks) => {
      const quote = quoteOfSelection(source, span(source, "two", last));
      const tree = parseMarkdown(quote) as { children: Nodes[] };
      expect(
        tree.children.map((node) => [
          node.type,
          node.type === "code" ? node.value : textOf(node),
        ]),
      ).toEqual(blocks);
    });

    // [source, anchor, quote]: an end that takes nothing of a code block
    // belongs to what lies beside it.
    it.each([
      [
        "a start at a fence's last line end",
        "```ts\nconst a = 1;\n```\n\nAfter words.",
        { lineStart: 2, colStart: 13, lineEnd: 5, colEnd: 5 },
        "After",
      ],
      [
        "an end on a fence's opening line",
        "Intro words.\n\n```ts\nconst a = 1;\n```",
        { lineStart: 1, colStart: 7, lineEnd: 3, colEnd: 3 },
        "words.",
      ],
    ])("leaves out a code block %s", (_where, source, anchor, quote) => {
      expect(quoteOfSelection(source, anchor)).toBe(quote);
    });

    it("grows the fence a code block's last line cut down to a marker's run would close", () => {
      // From "Intro" to the backticks that open line 4.
      const source = "Intro\n\n```\n```x\n```";
      expect(
        quoteOfSelection(source, {
          lineStart: 1,
          colStart: 1,
          lineEnd: 4,
          colEnd: 3,
        }),
      ).toBe("Intro\n\n````\n```\n````");
    });

    it("takes a fold's summary and the text after it whole", () => {
      // The fold's tags become elements: cut through, they would show.
      const source =
        "<details><summary>Fold here</summary>\n\nbody text\n\n</details>";
      expect(quoteOfSelection(source, span(source, "here", "body"))).toBe(
        "<details><summary>Fold here</summary>\n\nbody text",
      );
    });

    it("takes the paragraph a whole-line anchor falls in", () => {
      const source = "one\ntwo\nthree\n\nafter";
      expect(
        quoteOfSelection(source, {
          lineStart: 2,
          colStart: null,
          lineEnd: 2,
          colEnd: null,
        }),
      ).toBe("one\ntwo\nthree");
    });

    it("takes a paragraph and the code block a selection runs into", () => {
      const source =
        "Intro words.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter.";
      expect(quoteOfSelection(source, span(source, "words", "const b"))).toBe(
        "words.\n\n```ts\nconst a = 1;\nconst b\n```",
      );
    });

    const TABLE = "| h1 | h2 |\n| - | - |\n| a b | c d |\n| e f | g h |";
    it.each([
      ["- alpha beta\n- gamma delta", "beta", "gamma", "- beta\n- gamma"],
      ["10. a\n\n    second para\n\nAfter", "para", "After", "para\n\nAfter"],
      ["## Head words\n\nbody text", "words", "body", "## words\n\nbody"],
      ["> one two\n>\n> three four", "two", "three", "two\n\nthree"],
      ["> one two\n\nthree four", "two", "three", "> two\n\nthree"],
      ["- a b\n\n  c d", "b", "c", "b\n\nc"],
      ["- parent text\n  - child item", "text", "child", "text\n- child"],
      ["- a b\n  - nested\n- c d", "b", "c", "- b\n  - nested\n- c"],
      ["> - a b\n>\n>   c d", "b", "c", "b\n\nc"],
      [
        "foo **bar baz**\n\nqux *quux corge*",
        "baz",
        "quux",
        "**baz**\n\nqux *quux*",
      ],
      [`${TABLE}\n| i j | k l |`, "b", "f", TABLE],
      [TABLE, "b", "c", "| h1 | h2 |\n| - | - |\n| a b | c d |"],
      [
        `Intro words.\n\n${TABLE}`,
        "words",
        "b",
        "words.\n\n| h1 | h2 |\n| - | - |\n| a b | c d |",
      ],
      [
        "```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter words.",
        "a = 1",
        "After",
        "```ts\na = 1;\nconst b = 2;\n```\n\nAfter",
      ],
      ["-\talpha beta\n\n\tgamma delta", "beta", "gamma", "beta\n\ngamma"],
      [
        "10. a\n\n    second para\n\n\tthird para",
        "para\n\n\t",
        "third",
        "para\n\nthird",
      ],
      ["---\nname: Some value here\n---\n\nbody", "name", "Some", "name: Some"],
      [
        "---\na: one two\nb: three four\n---\n\nbody",
        "two",
        "three",
        "two\nb: three",
      ],
      [
        "1. Run:\n\n   ```bash\n   pnpm install\n   pnpm build\n   ```\n\n2. Then test.",
        "install",
        "Then",
        "```bash\ninstall\npnpm build\n```\n\n2. Then",
      ],
      [
        "  ```ts\n  const a = 1;\n  ```\n\nAfter words.",
        "a = 1",
        "After",
        "```ts\na = 1;\n```\n\nAfter",
      ],
      [
        "- ```ts\n  const a = 1;\n  const b = 2;\n  ```\n- After words.",
        "a = 1",
        "After",
        "- ```ts\n  a = 1;\n  const b = 2;\n  ```\n- After",
      ],
      ["- [ ] x y\n  > a b\n  >\n  > c d", "b", "c", "b\n\nc"],
      [
        "Intro words.\n\nHead words\n==========",
        "words.",
        "Head",
        "words.\n\nHead\n==========",
      ],
      [
        "Head words\n==========\n\nbody text",
        "words",
        "body",
        "words\n==========\n\nbody",
      ],
      [
        "```\nUse ```\nx\n```\n\nafter",
        "```\nx",
        "after",
        "````\n```\nx\n````\n\nafter",
      ],
    ])(
      "cuts %j, selected from %j to %j, as %j",
      (source, first, last, quote) => {
        expect(quoteOfSelection(source, span(source, first, last))).toBe(quote);
      },
    );
  });
});
