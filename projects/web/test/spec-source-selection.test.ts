import { afterEach, describe, expect, it } from "vitest";
import {
  type SourceFiles,
  sourceAnchorForSelection,
  sourceHighlightRanges,
} from "../src/components/spec/source-selection.ts";

type Row = { line: number; text: string; type?: string };

/**
 * A file the way the source view draws it: a `data-file-diff` wrapper with
 * its header, the pierre host, and in its open shadow root the number gutter
 * ahead of the content column, which holds a `[data-line]` row per line. A
 * number and its row share a `data-line-index`.
 */
function drawFile(container: HTMLElement, path: string, rows: Row[]) {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-file-diff", path);
  const header = document.createElement("div");
  header.textContent = path;
  const host = document.createElement("diffs-container");
  wrapper.append(header, host);
  container.append(wrapper);
  const shadow = host.attachShadow({ mode: "open" });
  const gutter = document.createElement("div");
  gutter.setAttribute("data-gutter", "");
  const code = document.createElement("div");
  code.setAttribute("data-content", "");
  const drawn: Element[] = [];
  rows.forEach((row, index) => {
    const number = document.createElement("div");
    number.setAttribute("data-column-number", String(row.line));
    number.setAttribute("data-line-index", String(index));
    number.textContent = String(row.line);
    gutter.append(number);
    const el = document.createElement("div");
    el.setAttribute("data-line", String(row.line));
    el.setAttribute("data-line-index", String(index));
    if (row.type !== undefined) el.setAttribute("data-line-type", row.type);
    const span = document.createElement("span");
    span.textContent = row.text;
    el.append(span);
    code.append(el);
    drawn.push(el);
  });
  shadow.append(gutter, code);
  return {
    /** The `n`th row's text node, counted from 0; an empty row's span. */
    text: (n: number) => {
      const span = drawn[n]?.firstChild;
      return (span?.firstChild ?? span) as Node;
    },
    number: (n: number) => gutter.children[n]?.firstChild as Node,
    header: header.firstChild as Node,
    code,
    /** Hang a note under the `n`th row, as pierre slots an annotation in. */
    annotate: (n: number, text: string): Node => {
      const holder = document.createElement("div");
      holder.setAttribute("data-line-annotation", String(n));
      const slot = document.createElement("slot");
      slot.setAttribute("name", `annotation-${n}`);
      holder.append(slot);
      drawn[n]?.after(holder);
      const note = document.createElement("div");
      note.setAttribute("slot", `annotation-${n}`);
      const label = document.createElement("span");
      label.textContent = text;
      note.append(label);
      host.append(note);
      // A browser assigns the note to its slot; happy-dom does not.
      Object.defineProperty(note, "assignedSlot", { get: () => slot });
      return label.firstChild as Node;
    },
    /** A separator after the `n`th row, as for "N unmodified lines". */
    separate: (n: number): Node => {
      const separator = document.createElement("div");
      separator.setAttribute("data-separator", "");
      separator.textContent = "3 unmodified lines";
      drawn[n]?.after(separator);
      return separator.firstChild as Node;
    },
  };
}

const containers: HTMLElement[] = [];
function container(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  containers.push(el);
  return el;
}
afterEach(() => {
  for (const el of containers.splice(0)) el.remove();
});

/** `filesAt` for files kept by path, looked up through their wrapper. */
function filesBy(files: Record<string, SourceFiles>) {
  return (element: Element) => {
    const path = element
      .closest("[data-file-diff]")
      ?.getAttribute("data-file-diff");
    return path == null ? null : (files[path] ?? null);
  };
}

const ends = (start: Node, from: number, end: Node, to: number) => ({
  start: { node: start, offset: from },
  end: { node: end, offset: to },
  collapsed: false,
});

/** What an anchor's columns cut out of `body`, the way the server cuts it. */
function cut(
  body: string,
  anchor: {
    lineStart: number;
    lineEnd: number;
    colStart: number | null;
    colEnd: number | null;
  } | null,
): string {
  if (anchor === null || anchor.colStart === null || anchor.colEnd === null) {
    throw new Error("the anchor has no columns");
  }
  const lines = body.split("\n").slice(anchor.lineStart - 1, anchor.lineEnd);
  const last = lines.length - 1;
  if (last === 0)
    return (lines[0] ?? "").slice(anchor.colStart - 1, anchor.colEnd);
  lines[0] = (lines[0] ?? "").slice(anchor.colStart - 1);
  lines[last] = (lines[last] ?? "").slice(0, anchor.colEnd);
  return lines.join("\n");
}

describe("sourceAnchorForSelection", () => {
  const BODY = "# Title\n\nThe quick brown fox.\nJumps over.\n";
  const single = {
    "plan.md": { current: { path: "plan.md", version: 3, body: BODY } },
  };
  const rowsOf = (body: string): Row[] =>
    body
      .split("\n")
      .slice(0, -1)
      .map((text, i) => ({ line: i + 1, text }));

  it("anchors a word in one line to the file's version and columns", () => {
    const root = container();
    const file = drawFile(root, "plan.md", rowsOf(BODY));
    const anchor = sourceAnchorForSelection(
      root,
      ends(file.text(2), 4, file.text(2), 9),
      filesBy(single),
    );
    expect(anchor).toMatchObject({ path: "plan.md", version: 3 });
    expect(anchor?.lineStart).toBe(anchor?.lineEnd);
    expect(cut(BODY, anchor)).toBe("quick");
  });

  // The source view hands pierre the whole file; whether a row keeps the
  // `\r` of its line or not, it reads as that line.
  const CRLF = BODY.replaceAll("\n", "\r\n");
  const crlf = {
    "plan.md": { current: { path: "plan.md", version: 3, body: CRLF } },
  };
  const crlfRows = (cr: string) =>
    rowsOf(BODY).map((row) => ({ ...row, text: row.text + cr }));

  it.each([
    ["without", ""],
    ["with", "\r"],
  ])(
    "anchors a word in a CRLF file's line to its columns, rows drawn %s their \\r",
    (_drawn, cr) => {
      const root = container();
      const file = drawFile(root, "plan.md", crlfRows(cr));
      const anchor = sourceAnchorForSelection(
        root,
        ends(file.text(2), 4, file.text(2), 9),
        filesBy(crlf),
      );
      expect(anchor).toMatchObject({ lineStart: 3, lineEnd: 3 });
      expect(cut(CRLF, anchor)).toBe("quick");
    },
  );

  it.each([
    ["without", ""],
    ["with", "\r"],
  ])(
    "highlights a comment's columns in a CRLF file's line, rows drawn %s their \\r",
    (_drawn, cr) => {
      const root = container();
      drawFile(root, "plan.md", crlfRows(cr));
      const ranges = sourceHighlightRanges(root, filesBy(crlf), [
        {
          kind: "comment",
          path: "plan.md",
          version: 3,
          lineStart: 3,
          colStart: 5,
          lineEnd: 3,
          colEnd: 9,
        },
      ]);
      expect(ranges.comment.map((range) => range.toString())).toEqual([
        "quick",
      ]);
    },
  );

  // An end on a CRLF line's boundary names no `\r`, as one on an LF line's
  // names no `\n`: [start row, start offset, end row, end offset, quote].
  it.each([
    ["let go at the next row's start", 2, 4, 3, 0, "quick brown fox."],
    ["opening at a row's end", 2, "The quick brown fox.".length, 3, 5, "Jumps"],
  ])(
    "anchors a selection %s in a CRLF file to the characters selected",
    (_gesture, from, fromAt, to, toAt, quote) => {
      const root = container();
      const file = drawFile(root, "plan.md", crlfRows(""));
      const anchor = sourceAnchorForSelection(
        root,
        ends(file.text(from), fromAt, file.text(to), toAt),
        filesBy(crlf),
      );
      expect(cut(CRLF, anchor)).toBe(quote);
    },
  );

  it("starts a selection that opens at a line's end on the next line", () => {
    const root = container();
    const file = drawFile(root, "plan.md", rowsOf(BODY));
    const line3 = "The quick brown fox.";
    const anchor = sourceAnchorForSelection(
      root,
      ends(file.text(2), line3.length, file.text(3), 5),
      filesBy(single),
    );
    expect(anchor).toMatchObject({ lineStart: 4, colStart: 1 });
    expect(cut(BODY, anchor)).toBe("Jumps");
  });

  // A triple-click or Shift+End can leave an end on the row element itself,
  // past its last child; the offset then counts children, not characters.
  it("reads an end on the row element as the end of its text", () => {
    const root = container();
    const file = drawFile(root, "plan.md", rowsOf(BODY));
    const text = file.text(2);
    const row = text.parentElement?.parentElement as Element;
    const anchor = sourceAnchorForSelection(
      root,
      ends(text, 4, row, row.childNodes.length),
      filesBy(single),
    );
    expect(cut(BODY, anchor)).toBe("quick brown fox.");
  });

  it.each([
    ["File", ""],
    ["CodeView and the diffs", "\n"],
  ])("puts no column on a blank line as %s draws it", (_name, blank) => {
    const root = container();
    const rows = rowsOf(BODY).map((row) =>
      row.text === "" ? { ...row, text: blank } : row,
    );
    const file = drawFile(root, "plan.md", rows);
    const anchor = sourceAnchorForSelection(
      root,
      ends(file.text(1), 0, file.text(2), 3),
      filesBy(single),
    );
    expect(anchor).toMatchObject({ lineStart: 3, colStart: 1 });
    expect(cut(BODY, anchor)).toBe("The");
  });

  const OLD = "alpha\nbeta\ngamma\n";
  const NEW = "alpha\nBETA\ngamma\n";
  const renamed = {
    "new.md": {
      current: { path: "new.md", version: 2, body: NEW },
      old: { path: "old.md", version: 1, body: OLD },
    },
  };
  const DIFF_ROWS: Row[] = [
    { line: 1, text: "alpha", type: "context" },
    { line: 2, text: "beta", type: "change-deletion" },
    { line: 2, text: "BETA", type: "change-addition" },
    { line: 3, text: "gamma", type: "context" },
  ];

  it("anchors a deletion row to the old path and version", () => {
    const root = container();
    const file = drawFile(root, "new.md", DIFF_ROWS);
    const anchor = sourceAnchorForSelection(
      root,
      ends(file.text(1), 1, file.text(1), 4),
      filesBy(renamed),
    );
    expect(anchor).toMatchObject({ path: "old.md", version: 1 });
    expect(cut(OLD, anchor)).toBe("eta");
  });

  it("anchors a drag from red into green to the new version's lines", () => {
    const root = container();
    const file = drawFile(root, "new.md", DIFF_ROWS);
    expect(
      sourceAnchorForSelection(
        root,
        ends(file.text(1), 2, file.text(3), 3),
        filesBy(renamed),
      ),
    ).toEqual({
      path: "new.md",
      version: 2,
      lineStart: 2,
      lineEnd: 3,
      colStart: null,
      colEnd: null,
    });
  });

  it("offers nothing across two files or past a file's surface", () => {
    const root = container();
    const file = drawFile(root, "plan.md", rowsOf(BODY));
    const other = drawFile(root, "new.md", DIFF_ROWS);
    const files = filesBy({ ...single, ...renamed });
    expect(
      sourceAnchorForSelection(
        root,
        ends(file.text(2), 0, other.text(0), 3),
        files,
      ),
    ).toBeNull();
    // Dragged on into the next file's header.
    expect(
      sourceAnchorForSelection(
        root,
        ends(file.text(2), 0, other.header, 3),
        files,
      ),
    ).toBeNull();
  });

  describe("an end off every row stands for the nearest row", () => {
    it("reads a line number as its row", () => {
      const root = container();
      const file = drawFile(root, "plan.md", rowsOf(BODY));
      const anchor = sourceAnchorForSelection(
        root,
        ends(file.number(2), 0, file.text(2), 3),
        filesBy(single),
      );
      expect(cut(BODY, anchor)).toBe("The");
    });

    it("ends a triple-click on the note under a line at that line's end", () => {
      const root = container();
      const file = drawFile(root, "plan.md", rowsOf(BODY));
      const note = file.annotate(2, "a draft under line 3");
      const anchor = sourceAnchorForSelection(
        root,
        ends(file.text(2), 0, note, 0),
        filesBy(single),
      );
      expect(cut(BODY, anchor)).toBe("The quick brown fox.");
    });

    it("ends a drag let go on a separator at the row above it", () => {
      const root = container();
      const file = drawFile(root, "plan.md", rowsOf(BODY));
      const separator = file.separate(2);
      const anchor = sourceAnchorForSelection(
        root,
        ends(file.text(2), 4, separator, 2),
        filesBy(single),
      );
      expect(cut(BODY, anchor)).toBe("quick brown fox.");
    });

    it("ends a drag past the last row at the last row's end", () => {
      const root = container();
      const file = drawFile(root, "plan.md", rowsOf(BODY));
      const anchor = sourceAnchorForSelection(
        root,
        ends(file.text(3), 0, file.code, file.code.childNodes.length),
        filesBy(single),
      );
      expect(cut(BODY, anchor)).toBe("Jumps over.");
    });

    it("offers nothing for a selection wholly inside a note", () => {
      const root = container();
      const file = drawFile(root, "plan.md", rowsOf(BODY));
      const note = file.annotate(2, "a comment under line 3");
      expect(
        sourceAnchorForSelection(root, ends(note, 2, note, 9), filesBy(single)),
      ).toBeNull();
    });

    it("starts a drag from a separator at the row below it", () => {
      const root = container();
      const file = drawFile(root, "plan.md", rowsOf(BODY));
      const separator = file.separate(2);
      const anchor = sourceAnchorForSelection(
        root,
        ends(separator, 0, file.text(3), 5),
        filesBy(single),
      );
      expect(cut(BODY, anchor)).toBe("Jumps");
    });
  });

  it("keeps the whole line when a row does not read as its source", () => {
    const root = container();
    const rows = rowsOf(BODY).map((row) =>
      row.line === 3 ? { ...row, text: "The quick  brown fox." } : row,
    );
    const file = drawFile(root, "plan.md", rows);
    expect(
      sourceAnchorForSelection(
        root,
        ends(file.text(2), 4, file.text(2), 9),
        filesBy(single),
      ),
    ).toEqual({
      path: "plan.md",
      version: 3,
      lineStart: 3,
      lineEnd: 3,
      colStart: null,
      colEnd: null,
    });
  });
});
