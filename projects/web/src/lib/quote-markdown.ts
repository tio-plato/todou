import type { Code, Nodes } from "mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import type { AnchorRange } from "@/components/spec/selection-entry.tsx";
import { parseMarkdown } from "./markdown-processor.ts";
import { splitRaw } from "./rehype-details.ts";
import { lineColAt, lineStartsOf, lineTextOf } from "./spec-source-index.ts";

/**
 * Turning a comment or an issue body into the markdown a reply quotes it
 * with. Everything here works on the stored source, never on rendered text:
 * bold, links and code fences have to survive into the quote.
 */

/**
 * Every line prefixed. Blank lines become a bare `>` so the whole passage
 * stays one quote block instead of breaking into several at the gaps.
 */
export function blockquote(body: string): string {
  return body
    .trimEnd()
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** A line already inside a quote, by CommonMark's reading of one. */
export const QUOTED_LINE = /^ {0,3}>/;

/** One level off every quoted line; any other line is left as it is. */
export function unquote(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^( {0,3})> ?/, "$1"))
    .join("\n");
}

/** 1-based inclusive source lines, clamped to both ends of the body. */
export function sourceLines(body: string, start: number, end: number): string {
  const lines = body.split("\n");
  return lines
    .slice(Math.max(0, start - 1), Math.min(lines.length, end))
    .join("\n");
}

/**
 * Quoted content plus where it came from. The attribution is a bare absolute
 * URL because that is the only shape the renderer draws as a rich reference
 * and the only one the server's resolve pass records a reference event for
 * (see `parseIssuePermalink`).
 */
export function quotedReference(input: {
  body: string;
  authorLogin: string;
  permalink: string;
}): string {
  const attribution = `_Originally posted by @${input.authorLogin} in ${input.permalink}_`;
  // An entry with no body still has an origin worth recording, and that is
  // the whole value here; quoting the nothing would only put a lone `>` at
  // the top of the new card.
  if (input.body.trim() === "") return attribution;
  return `${blockquote(input.body)}\n\n${attribution}`;
}

/** A node's source extent, as offsets. */
type Span = { start: number; end: number };

function spanOf(node: Nodes): Span | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : { start, end };
}

function childrenOf(node: Nodes): Nodes[] {
  return "children" in node ? (node.children as Nodes[]) : [];
}

/**
 * Blocks whose phrasing a quote may cut into: what they show is text. A
 * frontmatter field's key and value show their own source text, and a block
 * of HTML is cut into too (`leavesOf`).
 */
const LEAF_TYPES = new Set([
  "paragraph",
  "heading",
  "tableCell",
  "frontmatterKey",
  "frontmatterValue",
]);

/** Inline nodes a quote takes whole or not at all. */
const ATOMIC_TYPES = new Set([
  "inlineCode",
  "image",
  "imageReference",
  "html",
  "footnoteReference",
  "break",
]);

/** Inline nodes whose markers a quote cutting into them has to carry. */
const WRAPPER_TYPES = new Set([
  "strong",
  "emphasis",
  "delete",
  "link",
  "linkReference",
]);

/**
 * The blocks a whole-block quote widens a line to. Containers — quotes,
 * lists, tables — are not among them: a line in one widens to the block it
 * holds there, or stays itself.
 */
const UNIT_TYPES = new Set([
  "paragraph",
  "heading",
  "code",
  "html",
  "thematicBreak",
  "definition",
  "tableRow",
  "yaml",
  "toml",
  "frontmatterField",
]);

/** A leaf block, how deep in quotes it sits, and where its phrasing runs. */
type Leaf = { node: Nodes; span: Span; content: Span; depth: number };

function leavesOf(tree: Nodes): Leaf[] {
  const leaves: Leaf[] = [];
  const walk = (node: Nodes, depth: number) => {
    if (LEAF_TYPES.has(node.type)) {
      const kids = childrenOf(node);
      const span = spanOf(node);
      const first = kids[0] && spanOf(kids[0]);
      const last = kids[kids.length - 1];
      const end = last && spanOf(last);
      if (span && first && end) {
        leaves.push({
          node,
          span,
          content: { start: first.start, end: end.end },
          depth,
        });
      }
      return;
    }
    // A block of HTML shows as its own source text, so a quote cuts it as
    // text: what was selected of it, tags or not.
    if (node.type === "html") {
      const span = spanOf(node);
      if (span) leaves.push({ node, span, content: span, depth });
      return;
    }
    const inner = node.type === "blockquote" ? depth + 1 : depth;
    for (const child of childrenOf(node)) walk(child, inner);
  };
  walk(tree, 0);
  return leaves;
}

/**
 * Block syntax and nothing else: blank lines, a quote's `>`, a list item's
 * marker. An end of the selection that sits on it borders no text of its
 * own, only the text on its far side.
 */
const BLOCK_SYNTAX = /^(?:[ \t\n>]|(?:[-+*]|\d{1,9}[.)])(?=[ \t]))*$/;

/**
 * The leaf the selection's start (or end) is in, and that end moved onto its
 * phrasing. An end on the leaf's own markup — a heading's `#`, a cell's `|` —
 * or on the block syntax in front of (behind) it borders the leaf's text.
 */
function leafAt(
  source: string,
  leaves: Leaf[],
  at: number,
  edge: "start" | "end",
): { leaf: Leaf; at: number } | null {
  if (edge === "start") {
    for (const leaf of leaves) {
      if (leaf.content.end <= at) continue;
      if (
        leaf.span.start > at &&
        !BLOCK_SYNTAX.test(source.slice(at, leaf.span.start))
      ) {
        return null;
      }
      return { leaf, at: Math.max(at, leaf.content.start) };
    }
    return null;
  }
  for (let i = leaves.length - 1; i >= 0; i--) {
    const leaf = leaves[i];
    if (leaf === undefined || leaf.content.start >= at) continue;
    if (
      leaf.span.end < at &&
      !BLOCK_SYNTAX.test(source.slice(leaf.span.end, at))
    ) {
      return null;
    }
    return { leaf, at: Math.min(at, leaf.content.end) };
  }
  return null;
}

/** Where the line holding `offset` starts. */
function lineStartOf(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

const SPACE = /[ \t\n]/;
const PREFIX_ONLY = /^[ \t>]*$/;

/**
 * Both ends stepped off what the reader cannot have selected: whitespace at
 * either edge, and the container prefix — indent, up to `depth` `>` — that
 * opens each line a leaf continues on.
 */
function trimToText(
  source: string,
  start: number,
  end: number,
  depth: number,
): Span {
  const prefix = new RegExp(`^(?:[ \\t]*>){0,${depth}}[ \\t]*`);
  let s = start;
  let e = end;
  for (;;) {
    while (s < e && SPACE.test(source[s] ?? "")) s++;
    const from = lineStartOf(source, s);
    if (!PREFIX_ONLY.test(source.slice(from, s))) break;
    const skip = from + (prefix.exec(source.slice(from))?.[0].length ?? 0);
    if (skip <= s) break;
    s = skip;
  }
  for (;;) {
    while (e > s && SPACE.test(source[e - 1] ?? "")) e--;
    const from = lineStartOf(source, e);
    if (from === e || from <= s || !PREFIX_ONLY.test(source.slice(from, e))) {
      break;
    }
    e = from;
  }
  return { start: s, end: e };
}

/** GFM's bare URLs and `<…>`: the text is the address, cut it and it breaks. */
function isAutolink(source: string, node: Nodes): boolean {
  if (node.type !== "link") return false;
  const kids = childrenOf(node);
  const only = kids.length === 1 ? kids[0] : undefined;
  const span = spanOf(node);
  const text = only?.type === "text" ? spanOf(only) : null;
  if (span === null || text === null) return false;
  return (
    text.start === span.start ||
    (text.start === span.start + 1 && source[span.start] === "<")
  );
}

/** Every inline node under `node`, parents before their children. */
function inlinesOf(node: Nodes): Nodes[] {
  const found: Nodes[] = [];
  const walk = (at: Nodes) => {
    for (const child of childrenOf(at)) {
      found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}

/** A wrapper's opening and closing markers, around its first and last child. */
function markersOf(node: Nodes): { span: Span; inner: Span } | null {
  const span = spanOf(node);
  const kids = childrenOf(node);
  const first = kids[0] && spanOf(kids[0]);
  const lastKid = kids[kids.length - 1];
  const last = lastKid && spanOf(lastKid);
  if (span === null || !first || !last) return null;
  return { span, inner: { start: first.start, end: last.end } };
}

/**
 * The selection cut out of one leaf block, with the markup it cuts through
 * made whole again: a code span, an image or an address taken entire, and the
 * markers of emphasis or a link it starts or ends inside carried along.
 */
function cutInLeaf(
  source: string,
  leaf: Leaf,
  start: number,
  end: number,
): string | null {
  let { start: s, end: e } = trimToText(source, start, end, leaf.depth);
  if (s >= e) return null;
  const inlines = inlinesOf(leaf.node);
  // A cut through a code span, an image or an address would leave its
  // syntax open; those are taken whole.
  for (let grown = true; grown; ) {
    grown = false;
    for (const node of inlines) {
      if (!ATOMIC_TYPES.has(node.type) && !isAutolink(source, node)) continue;
      const span = spanOf(node);
      if (span === null || span.start >= e || span.end <= s) continue;
      if (span.start < s) {
        s = span.start;
        grown = true;
      }
      if (span.end > e) {
        e = span.end;
        grown = true;
      }
    }
  }
  const wrappers = inlines.flatMap((node) => {
    if (!WRAPPER_TYPES.has(node.type) || isAutolink(source, node)) return [];
    const markers = markersOf(node);
    return markers === null ? [] : [markers];
  });
  // Outermost first, so that its opening marker goes first too.
  const opening: string[] = [];
  for (const { span, inner } of wrappers) {
    if (s <= span.start || s >= span.end) continue;
    if (s <= inner.start) s = span.start;
    else if (s >= inner.end) s = span.end;
    else opening.push(source.slice(span.start, inner.start));
  }
  const closing: string[] = [];
  for (const { span, inner } of [...wrappers].reverse()) {
    if (e <= span.start || e >= span.end) continue;
    if (e >= inner.end) e = span.end;
    else if (e <= inner.start) e = span.start;
    else closing.push(source.slice(inner.end, span.end));
  }
  if (s >= e) return null;
  const [first = "", ...rest] =
    `${opening.join("")}${source.slice(s, e)}${closing.join("")}`.split("\n");
  // A continuation line's indent and `>` are the leaf's container speaking,
  // and the quote is about to get a container of its own.
  const container = new RegExp(`^[ \\t]*(?:>[ \\t]*){0,${leaf.depth}}`);
  return [first, ...rest.map((line) => line.replace(container, ""))].join("\n");
}

/** The code block both of the anchor's lines are in. */
function codeBlockOf(node: Nodes, anchor: AnchorRange): Code | null {
  if (node.type === "code") {
    const at = node.position;
    return at !== undefined &&
      at.start.line <= anchor.lineStart &&
      anchor.lineEnd <= at.end.line
      ? node
      : null;
  }
  for (const child of childrenOf(node)) {
    const found = codeBlockOf(child, anchor);
    if (found !== null) return found;
  }
  return null;
}

/**
 * A code block's body: its lines as mdast reads them, without the `\r` of a
 * CRLF line ending, the source line the first of them is on, and how many
 * fence markers its source spans besides them — one or two, or none for an
 * indented block.
 */
type CodeBody = { lines: string[]; first: number; fences: number };

function codeBodyOf(code: Code): CodeBody | null {
  if (code.position === undefined) return null;
  const { start, end } = code.position;
  const lines = code.value === "" ? [] : code.value.split(/\r?\n/);
  const fences = end.line - start.line + 1 - lines.length;
  if (fences < 0 || fences > 2) return null;
  return { lines, first: fences === 0 ? start.line : start.line + 1, fences };
}

/**
 * Line `i` of a code block's body where its source has it: where the source
 * line begins, where the code it shows starts, past the prefix the line
 * holds in front of it — a list item's indent, a quote's `> `, an indented
 * block's four spaces — and where it ends. Null when the source line does
 * not end with the code.
 */
type CodeRow = { begin: number; start: number; end: number };

function codeRowOf(
  source: string,
  lineStarts: number[],
  body: CodeBody,
  i: number,
): CodeRow | null {
  const text = body.lines[i] ?? "";
  const begin = lineStarts[body.first + i - 1];
  const own = lineTextOf(source, lineStarts, body.first + i);
  if (begin === undefined || !own.endsWith(text)) return null;
  const end = begin + own.length;
  return { begin, start: end - text.length, end };
}

/**
 * The run of a fence marker a line is and nothing else, or null: such a
 * line closes a fence of that marker, if the run is as long. The backtick
 * is spelled `\x60` so that no scan of this file reads it as a template.
 */
function fenceRun(line: string): string | null {
  return /^ {0,3}(\x60+|~+)[ \t]*$/.exec(line)?.[1] ?? null;
}

/**
 * The fence a quote writes `picked`, lines of `code`, in. An indented block
 * gets backticks enough that none of its lines reads as one; a fenced block
 * keeps its opening line, info string and all, and its marker — grown when a
 * line cut out of a longer one is that marker's run alone, which would
 * close the fence. `opened` is how long the block's own marker is.
 */
function quoteFence(
  source: string,
  code: Code,
  fenced: boolean,
  picked: string[],
): { open: string; marker: string; opened: number } | null {
  if (!fenced) {
    // A line indented up to three spaces still closes a fence.
    let longest = 0;
    for (const line of picked) {
      longest = Math.max(
        longest,
        /^ {0,3}(\x60*)/.exec(line)?.[1]?.length ?? 0,
      );
    }
    const marker = "\x60".repeat(Math.max(3, longest + 1));
    return { open: marker, marker, opened: 0 };
  }
  const offset = code.position?.start.offset ?? 0;
  const lineEnd = source.indexOf("\n", offset);
  const open = source
    .slice(offset, lineEnd === -1 ? undefined : lineEnd)
    .trim();
  const found = /^(\x60{3,}|~{3,})/.exec(open)?.[1];
  if (found === undefined) return null;
  let length = found.length;
  for (const line of picked) {
    const run = fenceRun(line);
    if (run?.[0] === found[0] && run.length >= length) length = run.length + 1;
  }
  const marker = (found[0] ?? "").repeat(length);
  return {
    open: marker + open.slice(found.length),
    marker,
    opened: found.length,
  };
}

/**
 * A code block's selected lines as a code block of their own, for an anchor
 * with no columns. Cutting its source lines instead would carry whatever
 * container held it: a list item's indent, which under the quote's `>` reads
 * as an indented block, or the `>` of a quote it sat in.
 */
function codeLines(
  source: string,
  tree: Nodes,
  anchor: AnchorRange,
): string | null {
  const code = codeBlockOf(tree, anchor);
  const body = code === null ? null : codeBodyOf(code);
  if (code === null || body === null) return null;
  const { lines, first } = body;
  let from = Math.max(anchor.lineStart - first, 0);
  let to = Math.min(anchor.lineEnd - first, lines.length - 1);
  // Only a fence marker selected: that still means this block.
  if (from > to) {
    from = 0;
    to = lines.length - 1;
  }
  const picked = lines.slice(from, to + 1);
  const fence = quoteFence(source, code, body.fences > 0, picked);
  return fence === null
    ? null
    : [fence.open, ...picked, fence.marker].join("\n");
}

/**
 * The characters selected inside one code block, as the page shows them: a
 * few of one line as inline code, as `cutInLeaf` writes a cut into a code
 * span, and a run across lines as a fence of its own, its first and last
 * lines cut where the selection starts and ends. A column maps onto a line
 * past the prefix its source line holds in front of it (`codeRowOf`), and an
 * end on a fence marker onto the edge of the body it borders. Null when a
 * line's source does not end with the line, when both ends are on one
 * marker, or when only blanks are selected: the caller then takes whole
 * lines.
 */
function codeCut(
  source: string,
  code: Code,
  anchor: AnchorRange,
  lineStarts: number[],
): string | null {
  const body = codeBodyOf(code);
  if (body === null || anchor.colStart === null || anchor.colEnd === null) {
    return null;
  }
  const { lines } = body;
  const last = body.first + lines.length - 1;
  if (
    lines.length === 0 ||
    anchor.lineStart > last ||
    anchor.lineEnd < body.first
  ) {
    return null;
  }
  // Where offset `at` of source line `line` falls among the block's lines.
  const place = (line: number, at: number) => {
    if (line < body.first) return { row: 0, at: 0 };
    if (line > last) {
      return { row: lines.length - 1, at: lines.at(-1)?.length ?? 0 };
    }
    const i = line - body.first;
    const row = codeRowOf(source, lineStarts, body, i);
    if (row === null) return null;
    const prefix = row.start - row.begin;
    return {
      row: i,
      at: Math.min(Math.max(at - prefix, 0), row.end - row.start),
    };
  };
  // Columns are 1-based and inclusive; the cut is half-open.
  let from = place(anchor.lineStart, anchor.colStart - 1);
  const to = place(anchor.lineEnd, anchor.colEnd);
  if (from === null || to === null) return null;
  // A start on a line's ending selects none of that line.
  if (from.row < to.row && from.at === (lines[from.row] ?? "").length) {
    from = { row: from.row + 1, at: 0 };
  }
  if (from.row === to.row) {
    const value = (lines[from.row] ?? "").slice(from.at, to.at);
    if (value.trim() === "") return null;
    return toMarkdown({ type: "inlineCode", value }).replace(/\n$/, "");
  }
  const picked = [
    (lines[from.row] ?? "").slice(from.at),
    ...lines.slice(from.row + 1, to.row),
    (lines[to.row] ?? "").slice(0, to.at),
  ];
  const fence = quoteFence(source, code, body.fences > 0, picked);
  return fence === null
    ? null
    : [fence.open, ...picked, fence.marker].join("\n");
}

/** Containers whose prefix opens each line they hold. */
const CONTAINER_TYPES = new Set([
  "blockquote",
  "listItem",
  "footnoteDefinition",
]);

/**
 * What one end of a selection across blocks is in, the nodes that is in,
 * outermost first, and where the end falls: a leaf and a point in its
 * phrasing; a fenced code block, its body, and a point on the code line `i`
 * shows; or a table and the line of the row the end is on.
 */
type Unit = { path: Nodes[] } & (
  | { kind: "leaf"; leaf: Leaf; at: number }
  | {
      kind: "code";
      node: Code;
      span: Span;
      body: CodeBody;
      i: number;
      row: CodeRow;
      at: number;
    }
  | { kind: "table"; node: Nodes; span: Span; line: number }
);

/** Where a unit's text starts and ends: a leaf's phrasing, a block whole. */
function unitSpan(unit: Unit): Span {
  return unit.kind === "leaf" ? unit.leaf.content : unit.span;
}

/** Every node under `tree` with the nodes it sits in, outermost first. */
function pathsOf(tree: Nodes): Map<Nodes, Nodes[]> {
  const paths = new Map<Nodes, Nodes[]>();
  const walk = (node: Nodes, path: Nodes[]) => {
    paths.set(node, path);
    for (const child of childrenOf(node)) walk(child, [...path, node]);
  };
  walk(tree, []);
  return paths;
}

/** The 1-based line holding `offset`. */
function lineAt(lineStarts: number[], offset: number): number {
  return lineColAt({ lineStarts }, offset).line;
}

/** Where 1-based line `line` ends, its line ending left out. */
function lineEndAt(source: string, lineStarts: number[], line: number): number {
  return (
    (lineStarts[line - 1] ?? 0) + lineTextOf(source, lineStarts, line).length
  );
}

/**
 * The unit the selection's start (or end), at `offset` on line `line`, is
 * in. An end on a fence's opening marker is on its first line's start, one
 * on its closing marker on its last line's end; a start at the end of a code
 * line is on the next one, an end at the start of one on the line before.
 * An end that takes nothing of a code block that way — a start at its end,
 * an end at its start — is in the unit beside it, and one in a table's cell
 * in the table. Null when the end is in no unit, in an indented code block,
 * whose lines are code by their indent alone and cannot be cut, or in a
 * block of HTML holding a fold, whose tags become elements and would show
 * cut through.
 */
function unitAt(
  source: string,
  lineStarts: number[],
  leaves: Leaf[],
  paths: Map<Nodes, Nodes[]>,
  line: number,
  offset: number,
  edge: "start" | "end",
): Unit | null {
  for (const [node, path] of paths) {
    const span = spanOf(node);
    const at = node.position;
    if (span === null || at === undefined) continue;
    if (at.start.line > line || at.end.line < line) continue;
    if (node.type === "table") {
      return { kind: "table", node, span, line, path };
    }
    if (node.type !== "code") continue;
    const body = codeBodyOf(node);
    if (body === null || body.fences === 0 || body.lines.length === 0) {
      return null;
    }
    const rows = body.lines.length;
    let i = Math.min(Math.max(line - body.first, 0), rows - 1);
    let row = codeRowOf(source, lineStarts, body, i);
    if (row === null) return null;
    let point =
      line < body.first
        ? row.start
        : line >= body.first + rows
          ? row.end
          : Math.min(Math.max(offset, row.start), row.end);
    if (edge === "start" && point === row.end) {
      if (i === rows - 1) {
        const after = at.end.line + 1;
        const from = lineStarts[after - 1];
        return from === undefined
          ? null
          : unitAt(source, lineStarts, leaves, paths, after, from, edge);
      }
      i++;
      row = codeRowOf(source, lineStarts, body, i);
      if (row === null) return null;
      point = row.start;
    } else if (edge === "end" && point === row.start) {
      if (i === 0) {
        const before = at.start.line - 1;
        return before < 1
          ? null
          : unitAt(
              source,
              lineStarts,
              leaves,
              paths,
              before,
              lineEndAt(source, lineStarts, before),
              edge,
            );
      }
      i--;
      row = codeRowOf(source, lineStarts, body, i);
      if (row === null) return null;
      point = row.end;
    }
    return { kind: "code", node, span, body, i, row, at: point, path };
  }
  const found = leafAt(source, leaves, offset, edge);
  const path = found === null ? undefined : paths.get(found.leaf.node);
  if (found === null || path === undefined) return null;
  const table = path.findLast((node) => node.type === "table");
  const tableSpan = table === undefined ? null : spanOf(table);
  if (table !== undefined && tableSpan !== null) {
    const cell = lineAt(lineStarts, found.leaf.span.start);
    return { kind: "table", node: table, span: tableSpan, line: cell, path };
  }
  const { node } = found.leaf;
  if (
    node.type === "html" &&
    splitRaw({ type: "raw", value: node.value }) !== null
  ) {
    return null;
  }
  return { kind: "leaf", leaf: found.leaf, at: found.at, path };
}

/**
 * The block markers in `text` alone, as a quote's first line opens with
 * them: a quote's `>`, a list item's marker and task box, a heading's `#`,
 * one space after each. Null when the text holds anything else.
 */
function blockMarkers(text: string): string | null {
  const marker = /[ \t]*(>|(?:[-+*]|\d{1,9}[.)]|\[[ xX]\]|#{1,6})(?=[ \t]|$))/y;
  let markers = "";
  let at = 0;
  for (let match = marker.exec(text); match !== null; ) {
    markers += `${match[1]} `;
    at = marker.lastIndex;
    match = marker.exec(text);
  }
  return /^[ \t]*$/.test(text.slice(at)) ? markers : null;
}

/**
 * The containers `prefixes` stand for take their prefix off each line, in
 * the order they hold one another: a quote its `>` and the blank column
 * after it, a list item or a footnote everything in front of its first
 * child on the line that child starts on, and `width` blank columns on every
 * other line. Columns count as CommonMark counts them: a tab reaches to the
 * next multiple of four.
 */
type Prefix =
  | { quote: true }
  | { quote: false; line: number; start: number; width: number };

/** The column a character of `text` takes, starting at `column`. */
function nextColumn(text: string, at: number, column: number): number {
  return text[at] === "\t" ? column + 4 - (column % 4) : column + 1;
}

/** The column `text` reaches at character `end`. */
function columnOf(text: string, end: number): number {
  let column = 0;
  for (let i = 0; i < end; i++) column = nextColumn(text, i, column);
  return column;
}

/**
 * How much of line `line` `prefixes` take: the characters, and the column
 * they reach, short of the column after the last of them when they end
 * inside a tab. A line without the quote's `>` is a lazy one, and one short
 * of an item's blank columns a blank one: neither has the prefixes inside.
 */
function prefixOf(
  source: string,
  lineStarts: number[],
  prefixes: Prefix[],
  line: number,
): { length: number; column: number } {
  const text = lineTextOf(source, lineStarts, line);
  const begin = lineStarts[line - 1] ?? 0;
  let p = 0;
  // The column taken, and the one after character `p - 1`: past `column`
  // when a tab is cut.
  let column = 0;
  let reach = 0;
  // Up to `n` blank columns off the front, how many there were.
  const blanks = (n: number): number => {
    let taken = 0;
    while (taken < n) {
      if (column === reach) {
        if (text[p] !== " " && text[p] !== "\t") break;
        reach = nextColumn(text, p, reach);
        p++;
      }
      const take = Math.min(reach - column, n - taken);
      column += take;
      taken += take;
    }
    return taken;
  };
  for (const prefix of prefixes) {
    if (prefix.quote) {
      const was = { p, column, reach };
      blanks(3);
      if (column < reach || text[p] !== ">") {
        ({ p, column, reach } = was);
        break;
      }
      p++;
      column = ++reach;
      blanks(1);
    } else if (line === prefix.line) {
      const end = prefix.start - begin;
      if (end < p) break;
      for (; p < end; p++) reach = nextColumn(text, p, reach);
      column = reach;
    } else if (blanks(prefix.width) < prefix.width) break;
  }
  return { length: p, column };
}

/** A setext heading's underline: where its line begins, and its run. */
function underlineOf(
  source: string,
  lineStarts: number[],
  leaf: Leaf,
): { begin: number; at: number; run: string } | null {
  if (leaf.node.type !== "heading") return null;
  const line = lineAt(lineStarts, leaf.span.end - 1);
  const begin = lineStarts[line - 1] ?? 0;
  const text = source.slice(begin, leaf.span.end);
  const run = /([=-]+)[ \t]*\r?$/.exec(text);
  if (run === null || begin <= leaf.content.end - 1) return null;
  return { begin, at: begin + run.index, run: run[1] ?? "" };
}

/**
 * A selection whose ends are in different blocks, cut from its first
 * character to its last. Each end is in a unit (`unitAt`): a leaf is cut as
 * `cutInLeaf` cuts one, a code block keeps a fence around the lines it
 * takes, and a table its header around its rows, which it takes whole — a
 * few cells without it are no table. What lies between the two is copied
 * from the source as it is: blank lines, markers, whole blocks.
 *
 * The containers both ends are in — quotes, list items, footnotes — are the
 * quote's surroundings, about to be replaced by a quote of its own, and
 * their prefix comes off every line, as `cutInLeaf` takes it off a leaf's;
 * those only one end is in keep theirs, so the lists and quotes inside keep
 * their shape. The first line keeps only the block markers in front of the
 * start: nothing stands before it, and the indent it had would make it
 * code. A code block the selection starts in is written from its own lines
 * under those markers, as the indent it stood at is gone. A tab in a prefix
 * counts the columns CommonMark's tab stops give it, and what is left of one
 * a prefix ends inside stays as blanks.
 *
 * Null when an end is in no unit, when only one end is in the frontmatter
 * — the `---` between would make the text above it a heading — or in a
 * footnote, which the page shows at its end rather than where its source
 * is, or when the cut at either end is empty.
 */
function crossCut(
  source: string,
  tree: Nodes,
  leaves: Leaf[],
  lineStarts: number[],
  anchor: AnchorRange,
): string | null {
  const startLine = lineStarts[anchor.lineStart - 1];
  const endLine = lineStarts[anchor.lineEnd - 1];
  if (
    anchor.colStart === null ||
    anchor.colEnd === null ||
    startLine === undefined ||
    endLine === undefined
  ) {
    return null;
  }
  const paths = pathsOf(tree);
  // Columns are 1-based and inclusive; the cut is half-open.
  const first = unitAt(
    source,
    lineStarts,
    leaves,
    paths,
    anchor.lineStart,
    startLine + anchor.colStart - 1,
    "start",
  );
  const last = unitAt(
    source,
    lineStarts,
    leaves,
    paths,
    anchor.lineEnd,
    Math.min(endLine + anchor.colEnd, source.length),
    "end",
  );
  if (first === null || last === null) return null;
  // Both ends moved off a code block they took nothing of, into one leaf.
  if (
    first.kind === "leaf" &&
    last.kind === "leaf" &&
    first.leaf === last.leaf
  ) {
    return cutInLeaf(source, first.leaf, first.at, last.at);
  }
  const inside = (unit: Unit, type: string) =>
    unit.path.findLast((node) => node.type === type) ?? null;
  const frontmatter = inside(first, "frontmatter");
  if (frontmatter !== null && frontmatter === inside(last, "frontmatter")) {
    // The fields' own source, keys and the `: ` between them included, as
    // their cells hold it.
    return first.kind === "leaf" && last.kind === "leaf" && first.at < last.at
      ? source.slice(first.at, last.at)
      : null;
  }
  if (
    frontmatter !== inside(last, "frontmatter") ||
    inside(first, "footnoteDefinition") !== inside(last, "footnoteDefinition")
  ) {
    return null;
  }
  const oneTable =
    first.kind === "table" && last.kind === "table" && first.node === last.node;
  const between = { start: unitSpan(first).end, end: unitSpan(last).start };
  if (!oneTable && between.start > between.end) return null;

  // The containers both ends are in, outermost first.
  const prefixes: Prefix[] = [];
  for (const [i, node] of first.path.entries()) {
    if (last.path[i] !== node) break;
    if (!CONTAINER_TYPES.has(node.type)) continue;
    if (node.type === "blockquote") {
      prefixes.push({ quote: true });
      continue;
    }
    const kid = childrenOf(node)[0];
    const start = kid === undefined ? undefined : spanOf(kid)?.start;
    if (start === undefined) return null;
    const line = lineAt(lineStarts, start);
    const outer = prefixOf(source, lineStarts, prefixes, line);
    const text = lineTextOf(source, lineStarts, line);
    const begin = lineStarts[line - 1] ?? 0;
    // A task item's box is its first paragraph's, not the item's indent.
    const box =
      node.type === "listItem" && typeof node.checked === "boolean"
        ? (/\[[ xX]\][ \t]*$/.exec(source.slice(begin, start))?.[0].length ?? 0)
        : 0;
    const width = columnOf(text, start - box - begin) - outer.column;
    if (width < 0) return null;
    prefixes.push({ quote: false, line, start, width });
  }

  // The quote, as text and as stretches of the source that the shared
  // prefixes come off. A code block the selection starts in is written once
  // the first line's block markers are known.
  const parts: Array<string | Span | "head"> = [];
  // A table's header and delimiter rows, then its rows from line `from` on
  // up to `end`.
  const tableRows = (table: Span, from: number, end: number) => {
    const delimiter = lineAt(lineStarts, table.start) + 1;
    const head = lineEndAt(source, lineStarts, delimiter);
    if (from <= delimiter) {
      parts.push({ start: table.start, end: Math.max(end, head) });
    } else {
      const row = lineStarts[from - 1] ?? head;
      parts.push({ start: table.start, end: head }, "\n", { start: row, end });
    }
  };
  if (oneTable) {
    tableRows(first.span, first.line, lineEndAt(source, lineStarts, last.line));
  } else {
    if (first.kind === "leaf") {
      const cut = cutInLeaf(
        source,
        first.leaf,
        first.at,
        first.leaf.content.end,
      );
      if (cut === null) return null;
      parts.push(cut);
    } else if (first.kind === "code") {
      parts.push("head");
    } else {
      tableRows(first.span, first.line, first.span.end);
    }
    parts.push(between);
    if (last.kind === "leaf") {
      const cut = cutInLeaf(
        source,
        last.leaf,
        last.leaf.content.start,
        last.at,
      );
      if (cut === null) return null;
      parts.push(cut);
      // A setext heading's text is a heading only above its underline.
      const underline = underlineOf(source, lineStarts, last.leaf);
      if (underline !== null) {
        parts.push(
          "\n",
          { start: underline.begin, end: underline.at },
          underline.run,
        );
      }
    } else if (last.kind === "code") {
      const picked = [
        ...last.body.lines.slice(0, last.i),
        source.slice(last.row.start, last.at),
      ];
      const fence = quoteFence(source, last.node, true, picked);
      if (fence === null) return null;
      // Its source as it is, but for a marker grown to stay open.
      const opens = last.span.start + fence.opened;
      if (fence.marker.length > fence.opened) {
        parts.push(fence.marker, { start: opens, end: last.at });
      } else parts.push({ start: last.span.start, end: last.at });
      parts.push(
        "\n",
        { start: last.row.begin, end: last.row.start },
        fence.marker,
      );
    } else {
      const top = lineAt(lineStarts, last.span.start);
      tableRows(last.span, top, lineEndAt(source, lineStarts, last.line));
    }
  }

  // The first line: what stands in front of the start, its block markers
  // alone once the shared prefixes are off.
  const start = unitSpan(first).start;
  const line = lineAt(lineStarts, start);
  const front = source.slice(lineStarts[line - 1] ?? start, start);
  const own = prefixOf(source, lineStarts, prefixes, line);
  const markers = blockMarkers(front.slice(own.length));
  if (markers === null) return null;
  let quote = markers;
  for (const part of parts) {
    if (part === "head" && first.kind === "code") {
      // Its lines from the start on, each under the markers' continuation:
      // the indent of a list item they open, a quote's `>`.
      const picked = [
        source.slice(first.at, first.row.end),
        ...first.body.lines.slice(first.i + 1),
      ];
      const fence = quoteFence(source, first.node, true, picked);
      if (fence === null) return null;
      const under = markers.replace(/[^> ]/g, " ");
      quote += [fence.open, ...picked, fence.marker].join(`\n${under}`);
      continue;
    }
    if (typeof part === "string") {
      quote += part;
      continue;
    }
    for (let at = part.start; at < part.end; ) {
      const next = source.indexOf("\n", at);
      const stop = next === -1 || next >= part.end ? part.end : next + 1;
      // A line the stretch opens loses the shared prefixes, and the blanks
      // after them are written as the columns they took in the source, from
      // where the prefixes stopped: what follows lands on another column.
      const prefix =
        at === 0 || source[at - 1] === "\n"
          ? prefixOf(source, lineStarts, prefixes, lineAt(lineStarts, at))
          : null;
      if (prefix === null || (prefix.length === 0 && prefix.column === 0)) {
        quote += source.slice(at, stop);
      } else if (at + prefix.length <= stop) {
        const text = source.slice(at, stop);
        let q = prefix.length;
        let reach = columnOf(text, q);
        while (text[q] === " " || text[q] === "\t") {
          reach = nextColumn(text, q, reach);
          q++;
        }
        quote += " ".repeat(reach - prefix.column) + text.slice(q);
      }
      at = stop;
    }
  }
  return quote;
}

/**
 * The whole blocks the anchor's two lines are in, as their source lines: a
 * line outside every block (a blank one) stands for itself. What an anchor
 * with no columns quotes, and one whose ends `crossCut` cannot cut at.
 */
function wholeBlocks(source: string, tree: Nodes, anchor: AnchorRange): string {
  const units: Array<{ start: number; end: number }> = [];
  const walk = (node: Nodes) => {
    const at = node.position;
    if (UNIT_TYPES.has(node.type)) {
      if (at !== undefined) {
        // A block that runs to the end of a body with a trailing newline
        // ends at column 1 of the line after its last.
        const last =
          at.end.column === 1 && at.end.line > at.start.line
            ? at.end.line - 1
            : at.end.line;
        units.push({ start: at.start.line, end: last });
      }
      return;
    }
    for (const child of childrenOf(node)) walk(child);
  };
  walk(tree);
  const holds = (line: number) => (unit: { start: number; end: number }) =>
    unit.start <= line && line <= unit.end;
  const from = units.find(holds(anchor.lineStart))?.start ?? anchor.lineStart;
  const to = units.findLast(holds(anchor.lineEnd))?.end ?? anchor.lineEnd;
  return sourceLines(source, from, to);
}

/**
 * The markdown that quotes what the reader selected in a body rendered from
 * `source`. A selection inside one paragraph, heading or table cell is cut
 * to the characters selected, formatting kept; one inside a code block is
 * cut to them too, as code; one across blocks is cut from its first
 * character to its last, the blocks between it whole. An anchor with no
 * columns takes the whole lines of a code block and their fence, or the
 * whole blocks its two ends are in.
 */
export function quoteOfSelection(source: string, anchor: AnchorRange): string {
  const tree = parseMarkdown(source);
  if (anchor.colStart !== null && anchor.colEnd !== null) {
    const starts = lineStartsOf(source);
    const lineStart = starts[anchor.lineStart - 1];
    const lineEnd = starts[anchor.lineEnd - 1];
    if (lineStart !== undefined && lineEnd !== undefined) {
      // Columns are 1-based and inclusive; the cut is half-open.
      const leaves = leavesOf(tree);
      const from = leafAt(
        source,
        leaves,
        lineStart + anchor.colStart - 1,
        "start",
      );
      const to = leafAt(
        source,
        leaves,
        Math.min(lineEnd + anchor.colEnd, source.length),
        "end",
      );
      const oneLeaf = from !== null && to !== null && from.leaf === to.leaf;
      if (oneLeaf) {
        const cut = cutInLeaf(source, from.leaf, from.at, to.at);
        if (cut !== null) return cut;
      }
      const code = codeBlockOf(tree, anchor);
      const cut =
        code !== null
          ? codeCut(source, code, anchor, starts)
          : oneLeaf
            ? null
            : crossCut(source, tree, leaves, starts, anchor);
      if (cut !== null) return cut;
    }
  }
  return codeLines(source, tree, anchor) ?? wholeBlocks(source, tree, anchor);
}
