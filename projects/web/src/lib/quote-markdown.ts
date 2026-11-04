import type { Code, Nodes } from "mdast";
import type { AnchorRange } from "@/components/spec/selection-entry.tsx";
import { parseMarkdown } from "./markdown-processor.ts";
import { lineStartsOf } from "./spec-source-index.ts";

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

/** Blocks whose phrasing a quote may cut into: what they show is text. */
const LEAF_TYPES = new Set(["paragraph", "heading", "tableCell"]);

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
 * A code block's selected lines as a code block of their own. Cutting its
 * source lines instead would carry whatever container held it: a list item's
 * indent, which under the quote's `>` reads as an indented block, or the `>`
 * of a quote it sat in.
 */
function codeLines(
  source: string,
  tree: Nodes,
  anchor: AnchorRange,
): string | null {
  const code = codeBlockOf(tree, anchor);
  if (code?.position === undefined) return null;
  const { start, end } = code.position;
  const lines = code.value === "" ? [] : code.value.split("\n");
  // The lines the block spans that its body does not: one or two fence
  // markers, or none for an indented block.
  const fences = end.line - start.line + 1 - lines.length;
  if (fences < 0 || fences > 2) return null;
  const first = fences === 0 ? start.line : start.line + 1;
  let from = Math.max(anchor.lineStart - first, 0);
  let to = Math.min(anchor.lineEnd - first, lines.length - 1);
  // Only a fence marker selected: that still means this block.
  if (from > to) {
    from = 0;
    to = lines.length - 1;
  }
  const picked = lines.slice(from, to + 1);
  // The backtick is spelled `\x60` so that no scan of this file reads it as
  // a template.
  let open: string;
  let marker: string;
  if (fences === 0) {
    // A line indented up to three spaces still closes a fence.
    const longest = Math.max(
      0,
      ...picked.map((line) => /^ {0,3}(\x60*)/.exec(line)?.[1]?.length ?? 0),
    );
    marker = "\x60".repeat(Math.max(3, longest + 1));
    open = marker;
  } else {
    const lineEnd = source.indexOf("\n", start.offset ?? 0);
    open = source
      .slice(start.offset, lineEnd === -1 ? undefined : lineEnd)
      .trim();
    const found = /^(\x60{3,}|~{3,})/.exec(open)?.[1];
    if (found === undefined) return null;
    marker = found;
  }
  return [open, ...picked, marker].join("\n");
}

/**
 * The whole blocks the anchor's two lines are in, as their source lines: a
 * line outside every block (a blank one) stands for itself.
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
 * to the characters selected, formatting kept; one inside a code block takes
 * its lines and their fence; anything else takes the whole blocks its two
 * ends are in.
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
      if (from !== null && to !== null && from.leaf === to.leaf) {
        const cut = cutInLeaf(source, from.leaf, from.at, to.at);
        if (cut !== null) return cut;
      }
    }
  }
  return codeLines(source, tree, anchor) ?? wholeBlocks(source, tree, anchor);
}
