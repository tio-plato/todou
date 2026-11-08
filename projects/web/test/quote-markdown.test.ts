import { describe, expect, it } from "vitest";
import type { AnchorRange } from "../src/components/spec/selection-entry.tsx";
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
      ["run `pnpm test` first", "test`", "fir", "`test` fir"],
      ["run `pnpm test` first", "npm", "npm", "`npm`"],
      ["run `pnpm test` first", "run", "pn", "run `pn`"],
      // Covering all of the code takes the span as written, not rewritten.
      ["a `` x`y `` b", "x", "y", "`` x`y ``"],
      ["a `` x`y `` b", "`y", "`y", "`` `y ``"],
      ["a ` code ` b", "od", "od", "`od`"],
      ["x **a `code` b** y", "od", "od", "**`od`**"],
      // What the page shows: a space for the line ending, no `>`.
      ["> a `co\n> de` b", "o", "d", "`o d`"],
      ["a `code` b", "o", "o", "`o`"],
      // What the page shows: `|`, not the table's `\|`.
      ["| `a\\|b` | c |\n| - | - |", "\\|b", "\\|b", "`|b`"],
      // The page collapses a run of blanks in code, and WebKit starts a drag
      // from the word after one at the run's start: the blanks are not quoted.
      ["- a `co\n      de` b", "    de", "de", "`de`"],
      ["go to https://x.test/a/b now", "x.test", "/a", "https://x.test/a/b"],
      [
        "see <https://x.test/a/b> now",
        "x.test",
        "x.test",
        "<https://x.test/a/b>",
      ],
      ["## Install the CLI", "the", "CLI", "the CLI"],
      ["| a b | c |\n| --- | --- |", "b |", "b", "b"],
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

  describe("inside a code block", () => {
    const quoted = "```ts\nconst b = 2;\nconst c = 3;\n```";

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
      "quotes the selected lines of %s as a fence of their own",
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
        "```\nconst b = 2;\nconst c = 3;\n```",
      );
    });

    it("fences an indented block holding a fence with a longer one", () => {
      const source = "Intro.\n\n    ```\n    const b = 2;\n";
      expect(quoteOfSelection(source, span(source, "```", "const b"))).toBe(
        "````\n```\nconst b = 2;\n````",
      );
    });

    it("fences an indented block holding an indented fence with a longer one", () => {
      const source = "Intro.\n\n      ```\n    x";
      expect(quoteOfSelection(source, span(source, "```", "x"))).toBe(
        "````\n  ```\nx\n````",
      );
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
    it("takes both paragraphs whole when columns span the two", () => {
      const source = "First para here.\n\nSecond one here.\n\nThird.";
      expect(quoteOfSelection(source, span(source, "para", "Second"))).toBe(
        "First para here.\n\nSecond one here.",
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
        "Intro words.\n\n```ts\nconst a = 1;\nconst b = 2;\n```",
      );
    });
  });
});
