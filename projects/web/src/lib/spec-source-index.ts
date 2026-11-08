import type { Nodes } from "mdast";
import { decodeString } from "micromark-util-decode-string";
import { trimLines } from "trim-lines";
import { parseMarkdown } from "./markdown-processor.ts";
import type { LineRange } from "./spec-changes.ts";

/**
 * Blocks that hold phrasing content directly. Everything between two of
 * them renders as a break — two paragraphs, a heading and its body, two
 * table cells — so the flattened text puts a newline there and a word
 * never straddles the boundary. Emphasis, links and the like are NOT on
 * this list: `a **b** c` is one flow and reads as "a b c".
 *
 * A fence is a leaf too and owns a group of its own (T-211), as is an image
 * since T-223, but they hold no prose and so are handled apart from these:
 * their groups never reach the flattened text.
 */
const LEAF_BLOCKS = new Set(["paragraph", "heading", "tableCell"]);

/**
 * Structure the whole-block insertion evidence can name (T-158). `code` is
 * on the list, and since T-211 it is a leaf like any other: its whole source
 * — fences included — is the text it aligns by, so a fence being added or
 * removed is decided the same way a paragraph is, and a container holding
 * one can be judged new or gone in its entirety. `image` joined it on the
 * same terms in T-223.
 */
const SOURCE_BLOCKS = new Set([
  "paragraph",
  "heading",
  "tableCell",
  "tableRow",
  "table",
  "listItem",
  "list",
  "blockquote",
  "code",
  "image",
  "frontmatter",
]);

/**
 * The node types `remarkFrontmatterTable` invents, mapped onto block types the
 * engine already has (T-240). A frontmatter block IS a two-column table as far
 * as everything downstream is concerned — rows pair by their key cell, a
 * removed row is spliced back where it stood — so its fields enter the block
 * table as `tableRow` and its cells as `tableCell`, and none of that machinery
 * has to learn a second vocabulary.
 *
 * `frontmatterBody` is deliberately absent: pushing no block for it is what
 * makes a field row's `parent` the frontmatter block itself, which is the
 * relationship `tableOf` reads to find the rows of a table.
 */
const FRONTMATTER_BLOCKS: Record<string, SourceBlockType> = {
  frontmatterField: "tableRow",
  frontmatterKey: "tableCell",
  frontmatterValue: "tableCell",
};

/** One run of prose, with both of its coordinate systems. */
export type SourceSegment = {
  /** The rendered text: entities decoded, markdown syntax already gone. */
  text: string;
  /** Offset of `text[0]` within `SegmentIndex.text`. */
  at: number;
  /** The markdown this came from, as absolute `[start, end)` offsets. */
  start: number;
  end: number;
  line: number;
  endLine: number;
  /**
   * The source span reads character-for-character like `text`, so an
   * offset inside one maps to the other by addition. False for an escape
   * or a character reference (`textPieces`), for a line ending or a table
   * cell's `\|` inside inline code (`codeSpanPieces`), and for a whole text
   * node or code span whose source could not be lined up with what it
   * shows — those segments are indivisible and get located whole.
   */
  exact: boolean;
  /** Which leaf block this flows in; a different one means a break. */
  group: number;
  /** A run of inline code rather than of prose. */
  code?: boolean;
};

export type SourceBlockType =
  | "paragraph"
  | "heading"
  | "tableCell"
  | "tableRow"
  | "table"
  | "listItem"
  | "list"
  | "blockquote"
  | "code"
  | "image"
  /**
   * A document's frontmatter (T-240). Being its own type is the whole of what
   * keeps it out of the prose word bag: `classOf` returns any type that is not
   * a prose leaf as its own class, so `title` / `status` / `owner` — key names,
   * which are syntax rather than vocabulary — can no longer compete with a
   * paragraph for a pairing. That was T-239's lesson, applied before it costs
   * anything rather than after.
   */
  | "frontmatter";

/**
 * An image node, keyed by the leaf group it owns (T-223). What mdast knows
 * about an image stops here: everything downstream takes the url and the
 * source range from this table rather than parsing `![alt](url)` a second
 * time, which a regex gets wrong the moment a title, an angle-bracketed url
 * or a parenthesis inside one turns up.
 */
export type SourceImage = {
  url: string;
  alt: string;
  title: string | null;
  /** Absolute source offsets, half-open. */
  start: number;
  end: number;
};

/**
 * A code block's body as mdast decoded it, keyed by the leaf group it owns.
 *
 * Kept rather than re-derived, because the rule that looks like it would do —
 * take `source.slice(start, end)` and drop the first and last line — only
 * holds for a fence at the top level. Inside a list item every line carries
 * the item's indent, inside a blockquote every line carries `> `, and an
 * indented block has no marker lines to drop at all, so its body comes out
 * empty. `value` is what `MarkdownView` hands pierre for all of them, which
 * is what makes it the only string two versions of a block can be compared
 * by (T-343).
 */
export type SourceFence = {
  value: string;
  /** 1-based source line the block opens on — the `data-loc` start. */
  line: number;
};

/** One block of structure, for deciding what counts as "new whole" (T-158). */
export type SourceBlock = {
  type: SourceBlockType;
  /** Absolute source offsets, half-open. */
  start: number;
  end: number;
  /** 1-based inclusive source lines. */
  line: number;
  endLine: number;
  /** Index into `SegmentIndex.blocks`; null at the top level. */
  parent: number | null;
  /**
   * Zero-based position among the indexed blocks with the same `parent`.
   * Unlike source offsets this remains useful after a block is mapped to the
   * corresponding container in another version.
   */
  childIndex: number;
  /** Whether this block is an ordered list; null for every non-list block. */
  listOrdered: boolean | null;
  /** Parsed first visible number of an ordered list; null otherwise. */
  listStart: number | null;
  /**
   * Number a reader sees beside this item. Markdown only takes the first
   * marker's numeral into account, so later values are derived from that
   * parsed start and the item's direct-child position.
   */
  listItemValue: number | null;
  /** Leaf-block groups this subtree owns, inclusive; -1 when it owns none. */
  firstGroup: number;
  lastGroup: number;
  /**
   * The subtree holds raw HTML. Coverage then says nothing about the block
   * as a whole — content nothing ever aligned would be declared new on the
   * strength of the text around it. A fence used to count here too; since
   * T-211 it owns a leaf group and can speak for itself.
   */
  opaque: boolean;
};

export type SegmentIndex = {
  source: string;
  /** All prose in document order, leaf blocks separated by newlines. */
  text: string;
  segments: SourceSegment[];
  /** Absolute offset each 1-based source line starts at. */
  lineStarts: number[];
  /** Block structure in document order: a parent always precedes its children. */
  blocks: SourceBlock[];
  /** The leaf block each group came from, indexed by group number. */
  groupTypes: SourceBlockType[];
  /** Every image, by the leaf group it owns (T-223). */
  images: Map<number, SourceImage>;
  /** Every code block's body, by the leaf group it owns (T-343). */
  fences: Map<number, SourceFence>;
  /**
   * Raw HTML inside a leaf block, which the page shows as its own source
   * text: todou runs no HTML. Kept apart from `segments`, so `text` and the
   * word diff never weigh markup as prose; only the selection mapping reads
   * these, to line a block's text up with what it shows. Each is exact and
   * has no place in `text`, so its `at` is -1.
   */
  literals: SourceSegment[];
};

/** One run of a text node, in its value and in the source. */
export type TextPiece = {
  /** Its part of the node's value; the pieces' texts join into the value. */
  text: string;
  /** Absolute source offsets, half-open. */
  start: number;
  end: number;
  /** As `SourceSegment.exact`: false for an escape or a reference. */
  exact: boolean;
};

/**
 * A character escape or reference starting right at `lastIndex`: the
 * pattern `micromark-util-decode-string` decodes with, which does not export
 * it. The backtick in its punctuation class is written `\x60`.
 */
const ESCAPE_OR_REFERENCE =
  /\\([!-/:-@[-\x60{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/iy;

/** What a continuation line may open with that is not its text. */
const CONTINUATION_PREFIX = /[> \t]/;

/** A line ending, or part of one, as `trimLines` finds them. */
function isLineEnding(char: string | undefined): boolean {
  return char === "\n" || char === "\r";
}

/**
 * Line up a text node's value with its source span, `[start, end)`. A node
 * whose source is longer than its value cannot be entered by addition, and a
 * selection or a highlight ending in it used to take the whole node — a
 * whole paragraph, when the node is one. What makes the source longer is
 * always one of these, and each gets its own treatment:
 *
 * - an escape (`\*`) or a character reference (`&amp;`) becomes one
 *   indivisible piece, the `\` or the `&…;` included, holding what it decodes
 *   to — so a quote cut from the source keeps the backslash;
 * - what a continuation line opens with — a quote's `> `, an item's indent,
 *   a paragraph's leading blanks — is in no piece at all;
 * - so are the blanks a soft line break drops from the end of a line;
 * - and so are the blanks the renderer drops on either side of a line break
 *   (`trimLines`), when the value is what the page shows: those a reference
 *   decodes to, and those written beside the line break `&#10;` stands for.
 *
 * Every other character is copied from the source to the value, and runs of
 * them are exact pieces; a newline ends the one it is in. Null when the two
 * do not line up — the caller then keeps the node whole, as before.
 *
 * A continuation line's prefix is not skipped greedily: a paragraph line
 * indented four or more spaces is no quote, and its text may open with `>`.
 * The prefix is the shortest run of `>`, blanks and tabs after which the rest
 * of the line lines up, through the source newline that ends it or to the end
 * of the value. A shorter run that takes a container's `>` for text stops
 * lining up within the line, so that check is what keeps a quote's marker out
 * of the text. The runs tried end at the line's start, past each `>` of the
 * run the line opens with, and at the end of that run (`prefixEnds`).
 */
export function textPieces(
  source: string,
  start: number,
  end: number,
  value: string,
): TextPiece[] | null {
  const pieces: TextPiece[] = [];
  let i = start;
  let j = 0;
  for (let first = true; ; first = false) {
    let line: TextLine | null = null;
    for (const p of first ? [i] : prefixEnds(source, i, end)) {
      const read = textLinePieces(source, p, end, value, j);
      if (read === null) continue;
      if (read.newline || /^[ \t\r\n]*$/.test(source.slice(read.i, end))) {
        line = read;
        break;
      }
    }
    if (line === null) return null;
    pieces.push(...line.pieces);
    if (!line.newline) return pieces;
    i = line.i;
    j = line.j;
  }
}

/**
 * Where a continuation line's prefix may end, shortest first: at `from`, the
 * line's start, just past each `>` of the run of `>`, blanks and tabs it
 * opens with, and at the end of that run. Never among its blanks: the parser
 * drops the blanks a line of text opens with, so the value's line never
 * starts with one of them, and a prefix ending among them lines up only
 * where the one past them does. Trying each blank on its own made a long
 * indent cost its length squared, each try reading the rest of it.
 */
function prefixEnds(source: string, from: number, end: number): number[] {
  const ends = [from];
  let p = from;
  while (p < end && CONTINUATION_PREFIX.test(source[p] ?? "")) {
    p++;
    if (source[p - 1] === ">") ends.push(p);
  }
  if (ends.at(-1) !== p) ends.push(p);
  return ends;
}

/**
 * One line of a text node read by `textLinePieces`, and where it stopped:
 * past the source newline that ends it, or at the end of the value.
 */
type TextLine = {
  pieces: TextPiece[];
  i: number;
  j: number;
  newline: boolean;
};

/**
 * `source` from `from` lined up with `value` from `at`, by the rules of
 * `textPieces`, up to and including the first newline the two share, or to
 * the end of `value`. Null when they stop reading alike first.
 */
function textLinePieces(
  source: string,
  from: number,
  end: number,
  value: string,
  at: number,
): TextLine | null {
  const pieces: TextPiece[] = [];
  let i = from;
  let j = at;
  // The exact piece being grown, by where it starts in the source and value.
  let runStart = -1;
  let runAt = 0;
  const closeRun = () => {
    if (runStart >= 0) {
      pieces.push({
        text: value.slice(runAt, j),
        start: runStart,
        end: i,
        exact: true,
      });
    }
    runStart = -1;
  };
  while (j < value.length) {
    if (i >= end) return null;
    const char = source[i] ?? "";
    // The escape or reference starting here, and what it decodes to.
    let token = "";
    let decoded = "";
    if (char === "\\" || char === "&") {
      ESCAPE_OR_REFERENCE.lastIndex = i;
      token = ESCAPE_OR_REFERENCE.exec(source)?.[0] ?? "";
      decoded = decodeString(token);
      // `&foo;` names no character and reads as itself, like plain text.
      if (decoded === token || i + token.length > end) {
        token = "";
        decoded = "";
      }
      if (token !== "" && value.startsWith(decoded, j)) {
        closeRun();
        pieces.push({
          text: decoded,
          start: i,
          end: i + token.length,
          exact: false,
        });
        i += token.length;
        j += decoded.length;
        continue;
      }
    }
    if (char === value[j]) {
      if (runStart < 0) {
        runStart = i;
        runAt = j;
      }
      i++;
      j++;
      if (char === "\n") {
        closeRun();
        return { pieces, i, j, newline: true };
      }
      continue;
    }
    let blank = i;
    while (blank < end && (source[blank] === " " || source[blank] === "\t")) {
      blank++;
    }
    if (
      blank > i &&
      (blank === end || source[blank] === "\n" || source[blank] === "\r")
    ) {
      closeRun();
      i = blank;
      continue;
    }
    // `mdast-util-to-hast` drops the blanks on either side of every line
    // break in a value (`trimLines`), and so does `buildSegmentIndex`: what
    // the source holds there — blanks, or a reference to them — shows nowhere.
    if (isLineEnding(value[j]) || isLineEnding(value[j - 1])) {
      const skip =
        blank > i ? blank - i : /^[ \t]+$/.test(decoded) ? token.length : 0;
      if (skip > 0) {
        closeRun();
        i += skip;
        continue;
      }
    }
    return null;
  }
  closeRun();
  return { pieces, i, j, newline: false };
}

/**
 * The code an inline code span shows: every line ending in `value` turned
 * into one space, as `mdast-util-to-hast` writes it. Text that already went
 * through it comes out the same, so an mdast value and a hast value give
 * one answer.
 */
export function shownCode(value: string): string {
  return value.replace(/\r\n|\n|\r/g, " ");
}

/**
 * One line of a code span, `source[from, to)`, lined up with `shown` from
 * `j`: each character copied, except a table cell's `\|`, which shows as `|`
 * and is one indivisible piece. Null when the line reads differently or runs
 * past the end of `shown`.
 */
function codeLinePieces(
  source: string,
  from: number,
  to: number,
  shown: string,
  j: number,
): { pieces: TextPiece[]; j: number } | null {
  const pieces: TextPiece[] = [];
  let at = j;
  let runStart = -1;
  let runAt = 0;
  const closeRun = (i: number) => {
    if (runStart >= 0) {
      pieces.push({
        text: shown.slice(runAt, at),
        start: runStart,
        end: i,
        exact: true,
      });
    }
    runStart = -1;
  };
  for (let i = from; i < to; ) {
    if (at >= shown.length) return null;
    if (source[i] === shown[at]) {
      if (runStart < 0) {
        runStart = i;
        runAt = at;
      }
      i++;
      at++;
      continue;
    }
    if (source[i] === "\\" && source[i + 1] === "|" && shown[at] === "|") {
      closeRun(i);
      pieces.push({ text: "|", start: i, end: i + 2, exact: false });
      i += 2;
      at++;
      continue;
    }
    return null;
  }
  closeRun(to);
  return { pieces, j: at };
}

/**
 * The content of a code span, `source[from, to)`, lined up with `shown` as a
 * whole, line by line. A line ending shows as one space and is a piece of its
 * own, `\r\n` included, so the offsets after it stay right.
 *
 * What a continuation line opens with — a quote's `>`, an item's indent — is
 * in no piece, but it is not skipped greedily the way `textPieces` skips it:
 * blanks past the container's own indent are code, and a code span keeps
 * them. The prefix is the shortest run of `>`, blanks and tabs after which
 * the rest of the line reads as `shown` does there and stops right on the
 * space of the next line ending, or on the end of `shown` on the last line.
 */
function codeContentPieces(
  source: string,
  from: number,
  to: number,
  shown: string,
): TextPiece[] | null {
  const pieces: TextPiece[] = [];
  let i = from;
  let j = 0;
  for (let first = true; ; first = false) {
    let lineEnd = i;
    while (
      lineEnd < to &&
      source[lineEnd] !== "\n" &&
      !(source[lineEnd] === "\r" && source[lineEnd + 1] === "\n")
    ) {
      lineEnd++;
    }
    const last = lineEnd >= to;
    let line: { pieces: TextPiece[]; j: number } | null = null;
    for (let p = i; p <= lineEnd && line === null; p++) {
      if (p > i && (first || !CONTINUATION_PREFIX.test(source[p - 1] ?? ""))) {
        break;
      }
      const read = codeLinePieces(source, p, lineEnd, shown, j);
      if (read === null) continue;
      if (last ? read.j === shown.length : shown[read.j] === " ") line = read;
    }
    if (line === null) return null;
    pieces.push(...line.pieces);
    j = line.j;
    if (last) return pieces;
    const ending = source[lineEnd] === "\r" ? 2 : 1;
    pieces.push({
      text: " ",
      start: lineEnd,
      end: lineEnd + ending,
      exact: false,
    });
    j++;
    i = lineEnd + ending;
  }
}

/**
 * Line up an inline code span, `source[start, end)` with its backticks, with
 * the code it shows. Its source is longer than its code by the backticks at
 * least, so taken as one piece a selection, a highlight or a word diff
 * touching it could only take the whole span; and a span folded onto a
 * second line shows a space where its value holds the line ending, so the
 * paragraph around it did not line up with the page at all.
 *
 * `value` is the mdast value or the hast text's: both go through `shownCode`
 * first, so every caller gets the same pieces. CommonMark drops one space
 * from each end of code that starts and ends with one (or with a line
 * ending) and is not all spaces; the content is read that way first, and as
 * the code itself when that does not line up. Null when neither does, and
 * the caller keeps the span whole, as before. Two known shapes do not: a
 * lone `\r` for a line ending, and a continuation line whose container
 * prefix ends in a tab, which the value holds as the blanks it expands to.
 */
export function codeSpanPieces(
  source: string,
  start: number,
  end: number,
  value: string,
): TextPiece[] | null {
  let fence = 0;
  while (start + fence < end && source[start + fence] === "\x60") fence++;
  const from = start + fence;
  const to = end - fence;
  if (fence === 0 || to <= from) return null;
  if (source.slice(to, end) !== "\x60".repeat(fence)) return null;
  const shown = shownCode(value);
  const padded = codeContentPieces(source, from, to, ` ${shown} `);
  if (padded === null) return codeContentPieces(source, from, to, shown);
  // The padding is the first and the last character: a space in an exact
  // piece, or a line ending's piece of its own.
  const head = padded[0];
  if (head?.exact === true && head.text.length > 1) {
    padded[0] = { ...head, text: head.text.slice(1), start: head.start + 1 };
  } else padded.shift();
  const tail = padded.at(-1);
  if (tail?.exact === true && tail.text.length > 1) {
    padded[padded.length - 1] = {
      ...tail,
      text: tail.text.slice(0, -1),
      end: tail.end - 1,
    };
  } else padded.pop();
  return padded;
}

/** Absolute offset each 1-based line of `source` starts at. */
export function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * Index a markdown source for the decoration engine (T-142): what prose it
 * contains, and where each run of it lives in the source. Both directions
 * are needed — source offsets in, to place a word-diff range on the page;
 * rendered offsets in, to turn a reader's selection into an anchor.
 *
 * Fenced and indented code is deliberately absent from the prose: those
 * blocks are handed to pierre's CodeView as plain text (T-31), and injecting
 * anything into them would corrupt the extraction. They keep block-level
 * treatment, and own a leaf group so the alignment can still place them.
 */
export function buildSegmentIndex(source: string): SegmentIndex {
  const segments: SourceSegment[] = [];
  const blocks: SourceBlock[] = [];
  const groupTypes: SourceBlockType[] = [];
  const images = new Map<number, SourceImage>();
  const fences = new Map<number, SourceFence>();
  let text = "";
  let groups = 0;
  let group = -1;
  let lastGroup: number | null = null;
  let parent: number | null = null;
  const childCounts = new Map<number | null, number>();
  const lineStarts = lineStartsOf(source);
  const literals: SourceSegment[] = [];
  // Inside a node whose text reaches the page through `hChildren`.
  let verbatim = false;

  const pushBlock = (node: Nodes, type: SourceBlockType): number | null => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return null;
    const childIndex = childCounts.get(parent) ?? 0;
    childCounts.set(parent, childIndex + 1);
    const list = node.type === "list" ? node : null;
    const parentBlock = parent === null ? undefined : blocks[parent];
    blocks.push({
      type,
      start,
      end,
      line: node.position?.start.line ?? 1,
      endLine: node.position?.end.line ?? 1,
      parent,
      childIndex,
      listOrdered: list?.ordered ?? null,
      listStart: list?.start ?? null,
      listItemValue:
        type === "listItem" && parentBlock?.listOrdered === true
          ? (parentBlock.listStart ?? 1) + childIndex
          : null,
      firstGroup: -1,
      lastGroup: -1,
      opaque: false,
    });
    return blocks.length - 1;
  };

  const markOpaque = (): void => {
    for (let i = parent; i !== null; ) {
      const block = blocks[i];
      if (block === undefined) return;
      block.opaque = true;
      i = block.parent;
    }
  };

  const visit = (node: Nodes): void => {
    if (node.type === "html") {
      markOpaque();
      // Inline HTML only: a block of its own shows outside every stamped
      // block. One whose source is not its value — it spans a line a
      // container prefixes — is left out, and its block keeps the line.
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (
        group >= 0 &&
        start !== undefined &&
        end !== undefined &&
        end - start === node.value.length
      ) {
        literals.push({
          text: node.value,
          at: -1,
          start,
          end,
          line: node.position?.start.line ?? 1,
          endLine: node.position?.end.line ?? 1,
          exact: true,
          group,
        });
      }
      return;
    }
    // A fence is a leaf that owns a group but contributes no prose: nothing
    // enters `text` or `segments`, so annotation anchoring and selection
    // mapping never see it, while the alignment gets a block it can pair,
    // insert or remove whole (T-211).
    if (node.type === "code") {
      const index = pushBlock(node, "code");
      if (index === null) return;
      const own = groups++;
      groupTypes[own] = "code";
      const block = blocks[index];
      if (block !== undefined) {
        block.firstGroup = own;
        block.lastGroup = own;
        fences.set(own, { value: node.value, line: block.line });
      }
      return;
    }
    // An image is a leaf on exactly the fence's terms (T-223). It holds no
    // prose either — url, alt and title are attributes, not children — so it
    // owns a group the alignment can pair, insert or remove whole while
    // nothing of it enters `text` or `segments`. Feeding `![](…)` to the
    // flattened text instead would paint word-level marks onto markdown
    // syntax, and would throw `sourceOffsetOfRendered` off by the whole
    // construct, since an `<img>` contributes no rendered text at all.
    // `imageReference` stays out: resolving it means reading the definition
    // table, which is a different job.
    if (node.type === "image") {
      const index = pushBlock(node, "image");
      const block = index === null ? undefined : blocks[index];
      if (block === undefined) return;
      const own = groups++;
      groupTypes[own] = "image";
      block.firstGroup = own;
      block.lastGroup = own;
      images.set(own, {
        url: node.url,
        alt: node.alt ?? "",
        title: node.title ?? null,
        start: block.start,
        end: block.end,
      });
      return;
    }
    if (node.type === "text" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      if (node.value === "") return;
      if (lastGroup !== null && lastGroup !== group) text += "\n";
      lastGroup = group;
      // A text node whose source is longer than its value goes in as the
      // runs `textPieces` finds, so that only an escape or a reference stays
      // indivisible rather than the whole node; inline code as the runs
      // `codeSpanPieces` finds. Both go in as the page shows them, so that a
      // node that could not be lined up still leaves the rest of its
      // paragraph aligned: code with its line endings as spaces, and text
      // with the blanks around its line breaks dropped, as
      // `mdast-util-to-hast` drops them. Text a node hands to the page
      // through `hChildren` skips that step — a frontmatter cell's
      // (`remarkFrontmatterTable`) — and goes in as it is.
      const value =
        node.type === "inlineCode"
          ? shownCode(node.value)
          : verbatim
            ? node.value
            : trimLines(node.value);
      const pieces =
        node.type === "inlineCode"
          ? codeSpanPieces(source, start, end, node.value)
          : end - start !== value.length
            ? textPieces(source, start, end, value)
            : null;
      if (pieces !== null) {
        for (const piece of pieces) {
          segments.push({
            ...piece,
            at: text.length,
            line: lineColAt({ lineStarts }, piece.start).line,
            endLine: lineColAt({ lineStarts }, piece.end - 1).line,
            group,
            ...(node.type === "inlineCode" ? { code: true } : {}),
          });
          text += piece.text;
        }
        return;
      }
      segments.push({
        text: value,
        at: text.length,
        start,
        end,
        line: node.position?.start.line ?? 1,
        endLine: node.position?.end.line ?? 1,
        exact: end - start === value.length,
        group,
        ...(node.type === "inlineCode" ? { code: true } : {}),
      });
      text += value;
      return;
    }
    if (!("children" in node)) return;
    const outerGroup = group;
    const outerParent = parent;
    const outerVerbatim = verbatim;
    if ((node.data?.hChildren?.length ?? 0) > 0) verbatim = true;
    const type =
      FRONTMATTER_BLOCKS[node.type] ?? (node.type as SourceBlockType);
    const index = SOURCE_BLOCKS.has(type) ? pushBlock(node, type) : null;
    if (index !== null) parent = index;
    const firstGroup = groups;
    if (LEAF_BLOCKS.has(type)) {
      group = groups++;
      groupTypes[group] = type;
    }
    for (const child of node.children) visit(child);
    const block = index === null ? undefined : blocks[index];
    if (block !== undefined && groups > firstGroup) {
      block.firstGroup = firstGroup;
      block.lastGroup = groups - 1;
    }
    group = outerGroup;
    parent = outerParent;
    verbatim = outerVerbatim;
  };

  visit(parseMarkdown(source));
  return {
    source,
    text,
    segments,
    lineStarts,
    blocks,
    groupTypes,
    images,
    fences,
    literals,
  };
}

/** Segments whose source span touches a 1-based inclusive line range. */
export function segmentsInLines(
  index: SegmentIndex,
  range: LineRange,
): SourceSegment[] {
  return index.segments.filter(
    (s) => s.line <= range.end && s.endLine >= range.start,
  );
}

export type SourceRange = { start: number; end: number };

/**
 * Source offsets covered by `[from, to)` of the flattened text, clipped to
 * one range per segment. Clipping is the point: the markdown *between*
 * segments — `**`, `|`, the newline joining two cells — is never part of
 * the answer, so a highlight can't leak onto syntax or onto a neighbouring
 * table cell that didn't change.
 */
export function sourceRangesOfText(
  index: SegmentIndex,
  from: number,
  to: number,
): SourceRange[] {
  const ranges: SourceRange[] = [];
  for (const segment of index.segments) {
    const segEnd = segment.at + segment.text.length;
    if (segEnd <= from) continue;
    if (segment.at >= to) break;
    const localFrom = Math.max(from, segment.at) - segment.at;
    const localTo = Math.min(to, segEnd) - segment.at;
    if (localTo <= localFrom) continue;
    const range = segment.exact
      ? { start: segment.start + localFrom, end: segment.start + localTo }
      : { start: segment.start, end: segment.end };
    const last = ranges.at(-1);
    if (last !== undefined && last.end >= range.start) {
      last.end = Math.max(last.end, range.end);
    } else {
      ranges.push(range);
    }
  }
  return ranges;
}

/**
 * Which characters of `[flat, flat + length)` of the flattened text come
 * from source inside `span`, as ranges relative to `flat`: the other way
 * round from `sourceRangesOfText`. An exact segment is cut at the span's
 * edges; an indivisible one is taken whole when its source reaches into the
 * span at all. What lies between segments — the newline joining two blocks —
 * comes from no source and is never covered.
 */
export function flatCoverage(
  index: SegmentIndex,
  flat: number,
  length: number,
  span: SourceRange,
): SourceRange[] {
  const covered: SourceRange[] = [];
  const { segments } = index;
  // Segments run in flattened order, so the first the run reaches is found
  // by halving, and the walk stops at the first past its end.
  let first = 0;
  for (let high = segments.length; first < high; ) {
    const mid = (first + high) >> 1;
    const segment = segments[mid];
    if (segment !== undefined && segment.at + segment.text.length <= flat) {
      first = mid + 1;
    } else high = mid;
  }
  for (let i = first; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) continue;
    if (segment.at >= flat + length) break;
    const segEnd = segment.at + segment.text.length;
    const from = Math.max(flat, segment.at);
    const to = Math.min(flat + length, segEnd);
    if (to <= from) continue;
    let start = from;
    let end = to;
    if (segment.exact) {
      const sourceStart = Math.max(
        span.start,
        segment.start + (from - segment.at),
      );
      const sourceEnd = Math.min(span.end, segment.start + (to - segment.at));
      if (sourceEnd <= sourceStart) continue;
      start = segment.at + (sourceStart - segment.start);
      end = segment.at + (sourceEnd - segment.start);
    } else if (segment.end <= span.start || segment.start >= span.end) {
      continue;
    }
    const last = covered.at(-1);
    if (last !== undefined && last.end >= start - flat) {
      last.end = Math.max(last.end, end - flat);
    } else {
      covered.push({ start: start - flat, end: end - flat });
    }
  }
  return covered;
}

/** Flattened-text extent of each leaf group; holes where a group has no prose. */
function groupRangesOf(index: SegmentIndex): Array<SourceRange | undefined> {
  const ranges: Array<SourceRange | undefined> = [];
  for (const segment of index.segments) {
    const end = segment.at + segment.text.length;
    const existing = ranges[segment.group];
    if (existing === undefined) {
      ranges[segment.group] = { start: segment.at, end };
    } else existing.end = end;
  }
  return ranges;
}

/**
 * Where a run of removed text came from in the baseline, so that a selection
 * in it can anchor there: `flat` is where its first character sits in the
 * baseline's `SegmentIndex.text`, `source` where it sits in the baseline's
 * source. Prose a word diff removed is a slice of the flattened text, which
 * runs on across `**` and the like; a marker quoting the removed source shows
 * that source character for character.
 */
export type TextOrigin = { flat: number } | { source: number };

/** One run of a table cell's content, in source order (T-229). */
export type CellPart =
  | { kind: "text"; text: string; origin?: TextOrigin }
  | { kind: "image"; url: string; alt: string };

/**
 * An image as a string, shaped like an image leaf's own text — that leaf
 * carries `source.slice(start, end)` of `![alt](url)` — so the two read alike
 * wherever they meet. The title stays out on T-223's terms: a picture whose
 * title changed is the same picture.
 */
export function imageText(image: { url: string; alt: string }): string {
  return `![${image.alt}](${image.url})`;
}

/**
 * Everything a cell shows, as one string. The alignment weighs strings and
 * nothing else — a leaf's text, a row's pairing key — so a cell holding only
 * an image reads as empty and gets paired by position alone (T-230). For a
 * cell with no image in it this is exactly `TableCell.text`, which is what
 * keeps every image-free table aligning byte for byte the way it did.
 */
export function partsText(parts: CellPart[]): string {
  return parts
    .map((part) => (part.kind === "image" ? imageText(part) : part.text))
    .join("");
}

/**
 * The leaf groups of the images a table cell shows, in source order (T-229).
 * A cell's own group is its prose, and every group after it up to `lastGroup`
 * was handed out inside the cell — group numbers go out in document order, so
 * the walk comes out sorted. A GFM cell holds phrasing content only, so an
 * image nested in a link or in emphasis is inside that span too.
 */
export function cellImageGroups(
  index: SegmentIndex,
  cell: SourceBlock,
): number[] {
  if (cell.firstGroup < 0) return [];
  const groups: number[] = [];
  for (let g = cell.firstGroup + 1; g <= cell.lastGroup; g++) {
    if (index.images.has(g)) groups.push(g);
  }
  return groups;
}

/** One cell of a table, as the row × column alignment sees it (T-221). */
export type TableCell = {
  group: number;
  /** The cell's slice of `SegmentIndex.text`; "" when it holds no prose. */
  text: string;
  /** Offset of `text[0]` in that same flattened text; -1 when there is none. */
  at: number;
  /**
   * Everything the cell shows, images included (T-229). `text` is what the
   * alignment pairs by and what a word diff maps onto, so it stays exactly the
   * flattened prose it always was — an image contributes nothing to it. This
   * is the second view, and the only one a stand-in cell can be rebuilt from.
   */
  parts: CellPart[];
  block: SourceBlock;
};

/**
 * What one cell shows, in source order. Prose and images live in two separate
 * tables — the flattened text has no image in it at all — so the two are
 * merged by source offset here rather than by walking the tree a second time.
 */
function cellPartsOf(
  index: SegmentIndex,
  cell: SourceBlock,
  prose: SourceSegment[],
): CellPart[] {
  const runs: Array<[number, CellPart]> = prose.map((segment) => [
    segment.start,
    { kind: "text", text: segment.text, origin: { flat: segment.at } },
  ]);
  for (const group of cellImageGroups(index, cell)) {
    const image = index.images.get(group);
    if (image === undefined) continue;
    runs.push([image.start, { kind: "image", url: image.url, alt: image.alt }]);
  }
  runs.sort((a, b) => a[0] - b[0]);
  const parts: CellPart[] = [];
  for (const [, part] of runs) {
    const last = parts.at(-1);
    // Two prose segments of one cell — an entity, an escape, inline code —
    // read as one run; only an image between them divides the cell's text.
    if (part.kind === "text" && last?.kind === "text") {
      last.text += part.text;
      continue;
    }
    parts.push(part);
  }
  // `text` arrives trimmed because remark eats the padding around a cell, but
  // not the space an image beside it left behind; trimming here is what keeps
  // an image-free cell's one part identical to its `text`.
  for (const part of parts) {
    if (part.kind !== "text") continue;
    const start = part.text.length - part.text.trimStart().length;
    part.text = part.text.trim();
    if (part.origin !== undefined && "flat" in part.origin) {
      part.origin = { flat: part.origin.flat + start };
    }
  }
  return parts.filter((part) => part.kind !== "text" || part.text !== "");
}

/** One row, always as wide as the header: short rows are padded with null. */
export type TableRow = { block: SourceBlock; cells: Array<TableCell | null> };

export type TableMatrix = { block: SourceBlock; rows: TableRow[] };

/**
 * One table regrouped as a matrix; null when `blockIndex` names anything else.
 * The block table already holds the shape — a `table` owns `tableRow`s, each
 * owning `tableCell`s, all in document order — so this reads it rather than
 * parsing a second time (T-221).
 *
 * The header row sets the width, because that is the width the page has:
 * `mdast-util-to-hast` pads a short row with position-less `<td>`s and drops
 * whatever a long row carries past the header. A cell nothing renders can hold
 * no decoration, so it does not compete for a pairing either.
 */
export function tableOf(
  index: SegmentIndex,
  blockIndex: number,
): TableMatrix | null {
  const table = index.blocks[blockIndex];
  // Frontmatter answers here too (T-240): its fields are `tableRow`s and its
  // cells `tableCell`s, so the matrix below reads it without a second path.
  if (
    table === undefined ||
    (table.type !== "table" && table.type !== "frontmatter")
  ) {
    return null;
  }
  const ranges = groupRangesOf(index);
  const prose = new Map<number, SourceSegment[]>();
  for (const segment of index.segments) {
    const run = prose.get(segment.group);
    if (run === undefined) prose.set(segment.group, [segment]);
    else run.push(segment);
  }
  const rows: TableRow[] = [];
  const rowAt = new Map<number, TableRow>();
  // A parent always precedes its children, so every row is registered before
  // the cells that name it.
  for (let i = 0; i < index.blocks.length; i++) {
    const block = index.blocks[i];
    if (block === undefined) continue;
    if (block.type === "tableRow" && block.parent === blockIndex) {
      const row: TableRow = { block, cells: [] };
      rowAt.set(i, row);
      rows.push(row);
      continue;
    }
    if (block.type !== "tableCell" || block.parent === null) continue;
    const range = ranges[block.firstGroup];
    rowAt.get(block.parent)?.cells.push({
      group: block.firstGroup,
      text: range === undefined ? "" : index.text.slice(range.start, range.end),
      at: range?.start ?? -1,
      parts: cellPartsOf(index, block, prose.get(block.firstGroup) ?? []),
      block,
    });
  }
  const width = rows[0]?.cells.length ?? 0;
  for (const row of rows) {
    if (row.cells.length > width) row.cells.length = width;
    while (row.cells.length < width) row.cells.push(null);
  }
  return { block: table, rows };
}

/** Blocks with no qualifying ancestor, i.e. the outermost of each nest. */
function outermost(index: SegmentIndex, qualifies: boolean[]): SourceBlock[] {
  return index.blocks.filter((block, i) => {
    if (qualifies[i] !== true) return false;
    for (let p = block.parent; p !== null; ) {
      if (qualifies[p] === true) return false;
      p = index.blocks[p]?.parent ?? null;
    }
    return true;
  });
}

/**
 * Leaves that hold no prose and yet vote: they were aligned in their own
 * right, so they can say whether the block around them is new or gone —
 * T-211's fence, and T-223's image.
 */
const VOTING_EMPTY_LEAVES = new Set<SourceBlockType>(["code", "image"]);

/**
 * Outermost blocks every one of whose leaf groups is in `groups`. This is the
 * evidence the alignment carries (T-163): a group nothing on the old side
 * matched is new, and a block built only out of such groups was born whole.
 *
 * Groups holding no prose abstain rather than veto — an empty table cell says
 * nothing about whether its table is new. `VOTING_EMPTY_LEAVES` is the
 * exception: those hold no prose either, but each is a leaf that was aligned,
 * so it votes, and that is what lets a list item carrying a code block be
 * taken or given up in one piece (T-211), and a paragraph holding nothing but
 * an image be seen at all (T-223).
 */
export function blocksWhollyInGroups(
  index: SegmentIndex,
  groups: ReadonlySet<number>,
): SourceBlock[] {
  const groupRanges = groupRangesOf(index);
  const qualifies = index.blocks.map((block) => {
    if (block.opaque || block.firstGroup < 0) return false;
    let any = false;
    for (let g = block.firstGroup; g <= block.lastGroup; g++) {
      const type = index.groupTypes[g];
      if (
        (type === undefined || !VOTING_EMPTY_LEAVES.has(type)) &&
        groupRanges[g] === undefined
      ) {
        continue;
      }
      if (!groups.has(g)) return false;
      any = true;
    }
    return any;
  });
  return outermost(index, qualifies);
}

/**
 * The outermost block a leaf group sits in; null when no block owns it.
 * Blocks sharing a group are always nested and a parent always precedes its
 * children, so the first match in document order is the top of that nest.
 */
export function outermostBlockOfGroup(
  index: SegmentIndex,
  group: number,
): SourceBlock | null {
  return (
    index.blocks.find(
      (block) =>
        block.firstGroup >= 0 &&
        block.firstGroup <= group &&
        block.lastGroup >= group,
    ) ?? null
  );
}

/**
 * Source offset for a caret sitting at `pos` in the flattened text.
 *
 * With an `edge`, the caret is one end of a range, read the way
 * `sourceOffsetOfRendered` reads one: between two segments — either side of
 * a `**`, the newline joining two blocks — a start takes the next segment's
 * beginning and an end the previous one's end, so the range takes in no
 * markdown on either side; inside an indivisible segment a start takes its
 * beginning and an end its end.
 */
export function sourceOffsetOfText(
  index: SegmentIndex,
  pos: number,
  edge?: "start" | "end",
): number | null {
  if (edge === "start") {
    const segment = index.segments.find((s) => pos < s.at + s.text.length);
    if (segment === undefined) return null;
    if (pos <= segment.at || !segment.exact) return segment.start;
    return segment.start + (pos - segment.at);
  }
  if (edge === "end") {
    const segment = index.segments.findLast((s) => s.at < pos);
    if (segment === undefined) return null;
    if (pos >= segment.at + segment.text.length || !segment.exact) {
      return segment.end;
    }
    return segment.start + (pos - segment.at);
  }
  for (const segment of index.segments) {
    const segEnd = segment.at + segment.text.length;
    if (pos < segment.at || pos > segEnd) continue;
    if (!segment.exact) return pos === segEnd ? segment.end : segment.start;
    return segment.start + (pos - segment.at);
  }
  return null;
}

/**
 * Map an offset into a block's *rendered* text onto a source offset. The
 * DOM has no separator between leaf blocks — `textContent` of a table row
 * is just its cells run together — so this walks segment lengths rather
 * than reading `SegmentIndex.text`.
 *
 * A non-exact segment can't be entered: an offset inside one collapses to
 * whichever of its edges the caller is looking for.
 */
export function sourceOffsetOfRendered(
  segments: Pick<SourceSegment, "text" | "start" | "end" | "exact">[],
  offset: number,
  edge: "start" | "end",
): number | null {
  return sourceOffsetsOfRendered(segments)(offset, edge);
}

/**
 * `sourceOffsetOfRendered` for offsets that never go back, such as the edges
 * of the runs a text node is cut into, taken in order: each call goes on
 * from where the last one stopped, so mapping all of them walks the
 * segments once.
 */
export function sourceOffsetsOfRendered(
  segments: Pick<SourceSegment, "text" | "start" | "end" | "exact">[],
): (offset: number, edge: "start" | "end") => number | null {
  let i = 0;
  let seen = 0;
  return (offset, edge) => {
    for (; i < segments.length; i++) {
      const segment = segments[i];
      if (segment === undefined) continue;
      const next = seen + segment.text.length;
      // On a boundary the two sides disagree about who owns the offset: a
      // selection's start reaches forward into the next segment, its end
      // back into this one. The last segment owns its own far edge.
      const owns =
        offset < next ||
        (offset === next && (edge === "end" || i === segments.length - 1));
      if (owns) {
        if (!segment.exact) {
          return edge === "start" ? segment.start : segment.end;
        }
        return segment.start + (offset - seen);
      }
      seen = next;
    }
    return null;
  };
}

/** 1-based line and UTF-16 code-unit column of a source offset. */
export function lineColAt(
  index: Pick<SegmentIndex, "lineStarts">,
  offset: number,
): { line: number; col: number } {
  let low = 0;
  let high = index.lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((index.lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, col: offset - (index.lineStarts[low] ?? 0) + 1 };
}

/** Inverse of `lineColAt`; null when the position is off the end. */
export function offsetAt(
  index: SegmentIndex,
  line: number,
  col: number,
): number | null {
  const start = index.lineStarts[line - 1];
  if (start === undefined) return null;
  const nextLine = index.lineStarts[line];
  const end = nextLine === undefined ? index.source.length : nextLine - 1;
  const offset = start + col - 1;
  return offset > end ? null : offset;
}

/** A selection's source columns: 1-based lines, 1-based inclusive columns. */
export type SourceColumns = {
  lineStart: number;
  lineEnd: number;
  colStart: number;
  colEnd: number;
};

/**
 * The columns the half-open source range `[start, end)` names, or null when
 * no column can (T-142). Columns name a real character, inclusively (the
 * contract lives in shared/schemas/spec.ts), so `len + 1` is never one — the
 * server measures lines without their newline. Both ends therefore step off
 * a newline they landed on, which makes a selection starting at a line end
 * mean column 1 of the next line rather than one past the end of this one.
 *
 * `hidden` names any other offsets the reader could not have selected: the
 * part of a code line in front of what its row shows. Both ends step off
 * those too, or a selection ending at the start of an indented row would end
 * on its indent.
 */
export function columnsOfOffsets(
  text: Pick<SegmentIndex, "source" | "lineStarts">,
  start: number,
  end: number,
  hidden: (offset: number) => boolean = () => false,
): SourceColumns | null {
  if (end <= start) return null;
  const skip = (offset: number) =>
    text.source[offset] === "\n" || hidden(offset);
  let first = start;
  let last = end - 1;
  while (first < last && skip(first)) first++;
  while (last > first && skip(last)) last--;
  // Nothing visible: no column can name that, so the whole-line anchor stands.
  if (skip(first)) return null;
  const from = lineColAt(text, first);
  const to = lineColAt(text, last);
  if (to.line < from.line || (to.line === from.line && to.col < from.col)) {
    return null;
  }
  return {
    lineStart: from.line,
    lineEnd: to.line,
    colStart: from.col,
    colEnd: to.col,
  };
}
