import { parseInternalHref } from "@todou/shared";
import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import type { Raw } from "./rehype-details.ts";
import {
  OLD_FLAT_ATTR,
  OLD_LINE_ATTR,
  OLD_SOURCE_ATTR,
  stampSourceLines,
} from "./rehype-source-lines.ts";
import {
  type BaselineTree,
  baselineAncestor,
  extractBaselineNode,
} from "./spec-baseline-tree.ts";
import {
  type CellPart,
  codeSpanPieces,
  flatCoverage,
  type SegmentIndex,
  type SourceRange,
  type SourceSegment,
  type TextOrigin,
  type TextPiece,
  textPieces,
} from "./spec-source-index.ts";
import type {
  StructuralBlockRef,
  StructuralDeletion,
} from "./spec-structure.ts";

/**
 * What a decorated run of text means. `ins` is word-level diff output;
 * `comment` and `draft` are the precise slice a reviewer selected, which
 * replaces the whole-block wash the annotation used to get (T-142).
 */
export type SpanKind = "ins" | "comment" | "draft";

/** Absolute source offsets, half-open, into the markdown being rendered. */
export type SpanDecoration = {
  kind: SpanKind;
  start: number;
  end: number;
  /** The annotation this mark belongs to, so a chip can flash it. */
  key?: string;
};

/**
 * Text the new version no longer has. `at` is where it used to sit, in the
 * *new* document's coordinates — a caret, not a span. `block` marks the
 * structural case (a paragraph, a table row, a whole table went away): there
 * is no line left to strike through, so it stands on its own between the
 * blocks instead of inside one.
 */
export type DeletionDecoration = {
  at: number;
  text: string;
  block: boolean;
  /** Where in the baseline `text` came from, for an inline deletion. */
  origin?: TextOrigin;
  /**
   * A block marker's content as runs of text that know where in the baseline
   * they came from, and the images between them (T-223). `text` stays what
   * it was, so every path that reads it — the inline marker, the `title`
   * attribute — is untouched.
   */
  parts?: DeletionPart[];
};

/**
 * One piece of a structural marker: removed source, or a removed image
 * (T-223). The same two runs a table cell is made of, so the two share one
 * type rather than drifting apart (T-229).
 */
export type DeletionPart = CellPart;

/** An image the new version put in another one's place (T-223). */
export type ImageSwap = {
  /** The new image's source range; how its `<img>` is recognised in the tree. */
  at: SourceRange;
  /** The one it replaced; null when only alt or title moved and the url did not. */
  old: { url: string; alt: string } | null;
};

/**
 * What a paired table's new side no longer has (T-221). A removed column or
 * row has no element on the page to strike through, so one is built and put
 * back where it stood: `at` is an index into the *final* order — the new
 * table's own rows and columns with the removed ones spliced in — so applying
 * these in ascending order is what produces that order.
 */
export type TableOverlay = {
  /** The table's source range in the new document; how its `<table>` is found. */
  table: SourceRange;
  /** Removed columns, in final column order; `cells` in rendered row order. */
  columns: Array<{ at: number; cells: CellPart[][] }>;
  /** Removed rows, in final row order (0 is the header); `cells` in final column order. */
  rows: Array<{ at: number; cells: CellPart[][] }>;
  /**
   * Content a cell that stayed no longer has — prose it was emptied of, an
   * image that went (T-229); the coordinates are pre-splice.
   */
  lost: Array<{ row: number; col: number; parts: CellPart[] }>;
};

export type Decorations = {
  spans: SpanDecoration[];
  deletions: DeletionDecoration[];
  /**
   * Source ranges that are new in their entirety (T-158). The outermost
   * element inside each gets one class and keeps its children plain —
   * "which words changed" has no answer worth rendering when it is all of
   * them.
   */
  blocks: SourceRange[];
  tables: TableOverlay[];
  images: ImageSwap[];
  /** Whole removed blocks rendered from the baseline tree when possible. */
  structures: StructuralDeletion[];
  /**
   * Annotations on the compare baseline, as offsets into its source
   * (`baselineIndex`): painted on what the comparison puts back of it.
   */
  oldSpans?: SpanDecoration[];
  baselineTree?: BaselineTree;
  /** The old and new indices retain independent ordered-list ordinals. */
  baselineIndex?: SegmentIndex;
  currentIndex?: SegmentIndex;
};

export const NO_DECORATIONS: Decorations = {
  spans: [],
  deletions: [],
  blocks: [],
  tables: [],
  images: [],
  structures: [],
};

/** Carries the annotation key so the popover can flash its exact mark. */
export const MARK_KEY_ATTR = "data-mark-key";

export const INS_BLOCK_CLASS = "spec-ins-block";

/**
 * Whole-block stand-ins for the marks, worn by an element whose insides
 * cannot carry one (T-164). Only code blocks need them so far.
 */
export const COMMENT_BLOCK_CLASS = "spec-mark-comment-block";
export const DRAFT_BLOCK_CLASS = "spec-mark-draft-block";

/**
 * The two halves of a swapped image, side by side (T-223). They carry layout
 * and nothing else: the colours come from `spec-del-block` and
 * `spec-ins-block`, which the fold pass, the ↑↓ navigation and the annotation
 * walker already know about, so a swap joins all three without being taught.
 */
export const IMG_DEL_CLASS = "spec-img-del";
export const IMG_NEW_CLASS = "spec-img-new";

const CLASS_OF: Record<SpanKind, string> = {
  ins: "spec-ins",
  comment: "spec-mark-comment",
  draft: "spec-mark-draft",
};

const TAG_OF: Record<SpanKind, string> = {
  ins: "ins",
  comment: "mark",
  draft: "mark",
};

/** Outermost first: an inserted word that also carries a comment reads as both. */
const NESTING: SpanKind[] = ["ins", "comment", "draft"];

function wrap(
  children: ElementContent[],
  kinds: SpanKind[],
  key: string | undefined,
) {
  let content = children;
  for (const kind of [...kinds].reverse()) {
    const element: Element = {
      type: "element",
      tagName: TAG_OF[kind],
      properties: {
        className: [CLASS_OF[kind]],
        ...(key !== undefined && kind !== "ins"
          ? { [MARK_KEY_ATTR]: key }
          : {}),
      },
      children: content,
    };
    content = [element];
  }
  return content;
}

/** Spans overlapping a node's half-open source range. */
function hitsOf(
  spans: SpanDecoration[],
  from: number,
  to: number,
): SpanDecoration[] {
  return spans.filter((s) => s.start < to && s.end > from);
}

function kindsOf(hits: SpanDecoration[]): SpanKind[] {
  return NESTING.filter((k) => hits.some((h) => h.kind === k));
}

function addClass(element: Element, name: string): void {
  const existing = element.properties.className;
  element.properties.className = Array.isArray(existing)
    ? [...existing, name]
    : typeof existing === "string"
      ? [existing, name]
      : [name];
}

/** Whether an element's whole source span sits inside one of `ranges`. */
function fullyInside(element: Element, ranges: SourceRange[]): boolean {
  const start = element.position?.start.offset;
  const end = element.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  return ranges.some((range) => range.start <= start && range.end >= end);
}

/** `origin` as the attribute a run of removed text carries it in. */
function originProps(origin: TextOrigin | undefined): Record<string, string> {
  if (origin === undefined) return {};
  return "flat" in origin
    ? { [OLD_FLAT_ATTR]: String(origin.flat) }
    : { [OLD_SOURCE_ATTR]: String(origin.source) };
}

/** A removed run's origin, read back off the attribute `originProps` wrote. */
function originOf(element: Element): TextOrigin | null {
  const flat = element.properties[OLD_FLAT_ATTR];
  if (flat !== undefined) return { flat: Number(flat) };
  const source = element.properties[OLD_SOURCE_ATTR];
  return source === undefined ? null : { source: Number(source) };
}

/** `origin` moved on by `n` characters of the text it starts. */
function originAfter(origin: TextOrigin, n: number): TextOrigin {
  return "flat" in origin
    ? { flat: origin.flat + n }
    : { source: origin.source + n };
}

function inlineDeletion(deletion: DeletionDecoration): Element {
  return {
    type: "element",
    tagName: "del",
    properties: {
      className: ["spec-del"],
      title: deletion.text,
      ...originProps(deletion.origin),
    },
    // Plain text on purpose: the removed source may be half a markdown
    // construct, and re-rendering it would inject stray emphasis or worse.
    children: [{ type: "text", value: deletion.text }],
  };
}

/**
 * The whole removed source, line breaks and all. Nothing in the document
 * survived to be struck through, so this marker is the only place the content
 * appears at all — a preview with the rest in a `title` (what T-209 found)
 * left a removed table showing half its header row and nothing else, and put
 * every deleted paragraph out of reach of the page's own search.
 */
function blockDeletion(deletion: DeletionDecoration): Element {
  return {
    type: "element",
    tagName: "del",
    properties: { className: ["spec-del-block"] },
    // Plain text, for `inlineDeletion`'s reason and one more: a removed table
    // row is half a construct, so re-rendering it would invent a whole table
    // around it. The CSS keeps the newlines, which is what lets the rows of a
    // removed table still read as rows.
    children:
      deletion.parts === undefined
        ? [{ type: "text", value: deletion.text.trim() }]
        : deletionParts(deletion.parts),
  };
}

/**
 * A marker cut into its parts (T-223). Images are the one construct that
 * gets rendered rather than quoted, because quoting one shows the reader a url
 * where the marker's whole job is to show them what went. Everything else
 * stays source text, on the reasoning above, and a run that knows where in
 * the baseline it came from says so on a `<span>` of its own.
 *
 * The head and the tail are trimmed, which is what `text.trim()` does to the
 * undivided marker; whitespace between two parts is the document's own and is
 * left alone. A run trimmed at its head starts that much further on.
 */
function deletionParts(parts: DeletionPart[]): ElementContent[] {
  const out: ElementContent[] = [];
  parts.forEach((part, i) => {
    if (part.kind === "image") {
      out.push({
        type: "element",
        tagName: "img",
        properties: { src: part.url, alt: part.alt },
        children: [],
      });
      return;
    }
    let value = part.text;
    let origin = part.origin;
    if (i === 0) {
      value = value.trimStart();
      if (origin !== undefined) {
        origin = originAfter(origin, part.text.length - value.length);
      }
    }
    if (i === parts.length - 1) value = value.trimEnd();
    if (value === "") return;
    out.push(
      origin === undefined
        ? { type: "text", value }
        : {
            type: "element",
            tagName: "span",
            properties: originProps(origin),
            children: [{ type: "text", value }],
          },
    );
  });
  return out;
}

/**
 * The image a swap replaced, put back beside the one that replaced it (T-223).
 * It carries no `position`, so `fullyInside` refuses it and no "wholly new"
 * class can land on it — the same guard `deletedCell` relies on (T-221).
 */
function swappedOutImage(old: { url: string; alt: string }): Element {
  return {
    type: "element",
    tagName: "del",
    properties: { className: ["spec-del-block", IMG_DEL_CLASS] },
    children: [
      {
        type: "element",
        tagName: "img",
        properties: { src: old.url, alt: old.alt },
        children: [],
      },
    ],
  };
}

export const DEL_CELL_CLASS = "spec-del-cell";
export const DEL_ROW_CLASS = "spec-del-row";
/**
 * An old image a table put back into a cell (T-229). Not `IMG_DEL_CLASS`
 * above, which is the layout half of a swap's side-by-side pair: this one only
 * ever holds down a size, and it goes on the `<img>` itself because the same
 * image also lands in cells that carry neither `DEL_CELL_CLASS` nor
 * `DEL_ROW_CLASS`.
 */
export const DEL_IMG_CLASS = "spec-del-img";

/** Element children only: the `\n` text nodes between cells are not cells. */
function elementsOf(parent: Element, tagNames: string[]): Element[] {
  return parent.children.filter(
    (child): child is Element =>
      child.type === "element" && tagNames.includes(child.tagName),
  );
}

/** Where the `n`th element child sits among all children; the end past it. */
function childIndexOf(parent: Element, n: number): number {
  let seen = 0;
  for (let i = 0; i < parent.children.length; i++) {
    if (parent.children[i]?.type !== "element") continue;
    if (seen === n) return i;
    seen++;
  }
  return parent.children.length;
}

/** The element of `tagName` whose source starts exactly at `start`, or null. */
function elementStartingAt(
  parent: Root | Element,
  tagName: string,
  start: number,
): Element | null {
  for (const child of parent.children as ElementContent[]) {
    if (child.type !== "element") continue;
    if (child.tagName === tagName && child.position?.start.offset === start) {
      return child;
    }
    // A table can sit inside a list item or a blockquote, so this recurses.
    const found = elementStartingAt(child, tagName, start);
    if (found !== null) return found;
  }
  return null;
}

/**
 * What a table puts back into a cell, run by run (T-229). Prose is struck
 * through as it always was; an image is rendered rather than quoted, for
 * `deletionParts`' reason — a spec uses a screenshot as its evidence, so what
 * a reader needs from a removed one is the picture, and a url is not that.
 *
 * None of these nodes carries a `position`, so `fullyInside` refuses them all
 * and no "wholly new" class can land on one — the same guard `deletedCell` and
 * T-223's `swappedOutImage` rely on.
 */
function partNodes(parts: CellPart[]): ElementContent[] {
  return parts.map((part) =>
    part.kind === "image"
      ? {
          type: "element",
          tagName: "img",
          properties: {
            src: part.url,
            alt: part.alt,
            className: [DEL_IMG_CLASS],
          },
          children: [],
        }
      : inlineDeletion({
          at: 0,
          text: part.text,
          block: false,
          origin: part.origin,
        }),
  );
}

/**
 * A cell the new version does not have, built to stand in the column or the
 * row it was spliced into (T-221). Empty `parts` give an empty cell, which is
 * what a cell that showed nothing renders as.
 */
function deletedCell(
  tagName: "th" | "td",
  parts: CellPart[],
  className: string[],
): Element {
  return {
    type: "element",
    tagName,
    properties: { className },
    children: partNodes(parts),
  };
}

/**
 * Splice a paired table's removed columns and rows back into it (T-221).
 * Everything a diff draws elsewhere is a wrapper around content that is on
 * the page; a removed column has none, so this is the one place the pass adds
 * elements. It stays additive all the same: an overlay whose table cannot be
 * found is dropped in silence, exactly as a mark with no text node is.
 *
 * Order is load-bearing. `lost` names cells by their coordinates before any
 * splice; `columns` widen every row, which is what makes a removed row's cells
 * — which already carry a slot for each removed column — line up when they are
 * inserted last.
 */
function applyOverlay(tree: Root, overlay: TableOverlay): void {
  const table = elementStartingAt(tree, "table", overlay.table.start);
  if (table === null) return;
  const head = elementsOf(table, ["thead"])[0] ?? null;
  const body = elementsOf(table, ["tbody"])[0] ?? null;
  const sections = [head, body].filter((s): s is Element => s !== null);
  const rows = sections.flatMap((section) => elementsOf(section, ["tr"]));

  for (const cell of overlay.lost) {
    const row = rows[cell.row];
    if (row === undefined) continue;
    const target = elementsOf(row, ["th", "td"])[cell.col];
    if (target === undefined) continue;
    target.children.push(...partNodes(cell.parts));
  }

  const headRows = head === null ? 0 : elementsOf(head, ["tr"]).length;
  for (const column of [...overlay.columns].sort((a, b) => a.at - b.at)) {
    rows.forEach((row, index) => {
      row.children.splice(
        childIndexOf(row, column.at),
        0,
        deletedCell(index < headRows ? "th" : "td", column.cells[index] ?? [], [
          DEL_CELL_CLASS,
        ]),
      );
    });
  }

  let target = body;
  if (target === null && overlay.rows.length > 0) {
    target = {
      type: "element",
      tagName: "tbody",
      properties: {},
      children: [],
    };
    table.children.push(target);
  }
  if (target === null) return;
  // `row.at` counts the final order from the top of the table, `childIndexOf`
  // from the top of the `<tbody>`, and `headRows` is the difference. It used
  // to be a literal 1, which assumed a header exists and occupies exactly one
  // row of a `<thead>`; a frontmatter grid has neither, and every stand-in
  // row landed one position too high (T-240). An ordinary GFM table still has
  // `headRows === 1`, so its behaviour is unchanged byte for byte.
  for (const row of [...overlay.rows].sort((a, b) => a.at - b.at)) {
    target.children.splice(childIndexOf(target, row.at - headRows), 0, {
      type: "element",
      tagName: "tr",
      properties: { className: [DEL_ROW_CLASS] },
      // The row is coloured as a row; its cells wear no class of their own.
      children: row.cells.map((parts) => deletedCell("td", parts, [])),
    });
  }
}
function hasClass(element: Element, name: string): boolean {
  const classes = element.properties.className;
  return Array.isArray(classes) && classes.includes(name);
}

/** Offset and semantic identity together, never just the matching tag name. */
function matchesBlock(element: Element, ref: StructuralBlockRef): boolean {
  if (
    element.position?.start.offset !== ref.start ||
    element.position?.end.offset !== ref.end
  )
    return false;
  switch (ref.type) {
    case "list":
      return element.tagName === "ol" || element.tagName === "ul";
    case "listItem":
      return element.tagName === "li";
    case "heading":
      return /^h[1-6]$/.test(element.tagName);
    case "code":
      return element.tagName === "pre";
    case "frontmatter":
      return (
        element.tagName === "table" && hasClass(element, "markdown-frontmatter")
      );
    case "tableCell":
      return element.tagName === "td" || element.tagName === "th";
    default:
      return (
        element.tagName ===
        (
          {
            paragraph: "p",
            table: "table",
            tableRow: "tr",
            blockquote: "blockquote",
            image: "img",
          } as Record<string, string>
        )[ref.type]
      );
  }
}

function locatedBlock(
  tree: Root | Element,
  ref: StructuralBlockRef,
): { node: Element; parent: Root | Element } | null {
  for (const child of tree.children) {
    if (child.type !== "element") continue;
    if (matchesBlock(child, ref)) return { node: child, parent: tree };
    const nested = locatedBlock(child, ref);
    if (nested !== null) return nested;
  }
  return null;
}

/** HTML content models matter: in particular, an ol may only receive li. */
function legalChild(parent: Root | Element, child: Element): boolean {
  const tag = child.tagName;
  if (parent.type === "root") {
    return !["li", "tr", "td", "th", "thead", "tbody", "tfoot"].includes(tag);
  }
  switch (parent.tagName) {
    case "ol":
    case "ul":
      return tag === "li";
    case "thead":
    case "tbody":
    case "tfoot":
      return tag === "tr";
    case "tr":
      return tag === "td" || tag === "th";
    case "table":
      return ["thead", "tbody", "tfoot"].includes(tag);
    case "p":
    case "a":
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return tag === "img";
    case "pre":
    case "code":
    case "img":
      return false;
    case "blockquote":
    case "li":
    case "td":
    case "th":
    case "div":
    case "section":
    case "details":
      return !["li", "tr", "td", "th", "thead", "tbody", "tfoot"].includes(tag);
    default:
      return false;
  }
}

/** Preserve independent ordinal values despite splicing old li into a new ol. */
function numberItem(item: Element, value: number, old = false): void {
  item.properties.value = String(value);
  // The explicit number is visible and selectable; the li's value carries
  // the accessible ordinal without announcing the same number twice.
  item.children.unshift({
    type: "element",
    tagName: "span",
    properties: {
      className: old
        ? ["spec-list-number", "spec-list-number-old"]
        : ["spec-list-number"],
      dataAnnotationUi: "",
      ariaHidden: "true",
    },
    children: [{ type: "text", value: `${value}. ` }],
  });
}

function numberList(
  list: Element,
  values?: ReadonlyMap<Element, number>,
  old = false,
): void {
  if (list.tagName !== "ol") return;
  addClass(list, "spec-numbered-ol");
  const start = Number(list.properties.start ?? 1);
  let ordinal = 0;
  for (const child of list.children) {
    if (child.type !== "element" || child.tagName !== "li") continue;
    const value = values?.get(child) ?? start + ordinal;
    if (
      !child.children.some(
        (node) => node.type === "element" && hasClass(node, "spec-list-number"),
      )
    )
      numberItem(child, value, old);
    ordinal++;
  }
}

/** Deleted subtrees lack locations; their own ordered lists still carry start. */
function numberClonedLists(node: Element): void {
  if (node.tagName === "ol") numberList(node, undefined, true);
  for (const child of node.children) {
    if (child.type === "element") numberClonedLists(child);
  }
}

function numberCurrentList(
  list: Element,
  ref: StructuralBlockRef,
  current?: SegmentIndex,
): void {
  const values = new Map<Element, number>();
  if (current !== undefined) {
    for (const block of current.blocks) {
      if (block.parent !== ref.index || block.listItemValue === null) continue;
      const child = list.children.find(
        (node) =>
          node.type === "element" &&
          node.tagName === "li" &&
          node.position?.start.offset === block.start &&
          node.position?.end.offset === block.end,
      );
      if (child?.type === "element") values.set(child, block.listItemValue);
    }
  }
  numberList(list, values);
}

type StructureSlot = { parent: Root | Element; at: number };

/** Last direct rendered child covered by an indexed block with no own element. */
function positionalTail(
  parent: Root | Element,
  ref: StructuralBlockRef,
): RootContent | null {
  let tail: RootContent | null = null;
  for (const child of parent.children as RootContent[]) {
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (
      start === undefined ||
      end === undefined ||
      start >= ref.end ||
      end <= ref.start
    )
      continue;
    tail = child;
  }
  return tail;
}

function pointInsideText(node: Text, cut: number) {
  const start = node.position?.start;
  if (start === undefined) return null;
  let line = start.line;
  let column = start.column;
  for (const char of node.value.slice(0, cut)) {
    if (char === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column, offset: (start.offset ?? 0) + cut };
}

/**
 * Find a source seam among a semantic parent's actual children. Tight list
 * paragraphs are text nodes here, and inline images may split one exact text
 * node; neither can be represented by an element-only predecessor.
 */
function slotAtRenderedOffset(
  parent: Root | Element,
  offset: number,
  oldNode: Element,
): StructureSlot | null {
  if (!legalChild(parent, oldNode)) return null;
  let seen = 0;
  for (let index = 0; index < parent.children.length; index++) {
    const child = parent.children[index];
    if (child === undefined) continue;
    const length = child.type === "text" ? child.value.length : 0;
    if (offset > seen + length) {
      seen += length;
      continue;
    }
    if (child.type === "text") {
      const cut = offset - seen;
      const left: Text = { type: "text", value: child.value.slice(0, cut) };
      const right: Text = { type: "text", value: child.value.slice(cut) };
      parent.children.splice(index, 1, left, right);
      return { parent, at: index + 1 };
    }
    if (child.type === "element") {
      const nested = slotAtRenderedOffset(child, offset - seen, oldNode);
      if (nested !== null) return nested;
    }
  }
  return offset === seen ? { parent, at: parent.children.length } : null;
}

function slotAtOffset(
  parent: Root | Element,
  offset: number,
  oldNode: Element,
): StructureSlot | null {
  if (!legalChild(parent, oldNode)) return null;
  const children = parent.children as RootContent[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child === undefined) continue;
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    if (offset <= start) return { parent, at: index };
    if (offset >= end) continue;
    if (
      child.type === "text" &&
      child.position !== undefined &&
      end - start === child.value.length
    ) {
      const cut = offset - start;
      const point = pointInsideText(child, cut);
      if (point === null) return null;
      const left: Text = {
        ...child,
        value: child.value.slice(0, cut),
        position: { start: child.position.start, end: point },
      };
      const right: Text = {
        ...child,
        value: child.value.slice(cut),
        position: { start: point, end: child.position.end },
      };
      children.splice(index, 1, left, right);
      return { parent, at: index + 1 };
    }
    if (child.type === "element") {
      return slotAtOffset(child, offset, oldNode);
    }
    return null;
  }
  return { parent, at: children.length };
}

/** Resolve restricted details shells by retained children, not a root ordinal. */
function detailsSlot(
  tree: Root,
  record: StructuralDeletion,
  oldNode: Element,
  baseline: BaselineTree,
): StructureSlot | null {
  const oldDetails = baselineAncestor(baseline, record.old, "details");
  if (oldDetails === null) return null;
  const targets = new Set<Element>();
  let predecessor: { oldStart: number; node: Element } | null = null;
  for (const anchor of record.retained ?? []) {
    if (baselineAncestor(baseline, anchor.old, "details") !== oldDetails)
      continue;
    const located = locatedBlock(tree, anchor.current);
    if (
      located === null ||
      located.parent.type !== "element" ||
      located.parent.tagName !== "details"
    )
      continue;
    targets.add(located.parent);
    if (
      anchor.old.end <= record.old.start &&
      (predecessor === null || anchor.old.start > predecessor.oldStart)
    )
      predecessor = { oldStart: anchor.old.start, node: located.node };
  }
  if (targets.size !== 1) return null;
  const parent = targets.values().next().value;
  if (parent === undefined || !legalChild(parent, oldNode)) return null;
  if (predecessor !== null) {
    const index = parent.children.indexOf(predecessor.node);
    return index < 0 ? null : { parent, at: index + 1 };
  }
  const summary = parent.children.findIndex(
    (child) => child.type === "element" && child.tagName === "summary",
  );
  return { parent, at: summary + 1 };
}

/** For a table row the indexed table has an unindexed thead/tbody between. */
function insertionParent(
  tree: Root,
  record: StructuralDeletion,
  oldNode: Element,
  baseline: BaselineTree | undefined,
  current?: SegmentIndex,
): StructureSlot | null {
  if (current !== undefined) {
    for (const ref of [record.parent, record.after]) {
      if (ref === null) continue;
      const block = current.blocks[ref.index];
      if (
        block === undefined ||
        block.type !== ref.type ||
        block.start !== ref.start ||
        block.end !== ref.end
      )
        return null;
    }
    if (
      record.after !== null &&
      current.blocks[record.after.index]?.parent !==
        (record.parent?.index ?? null)
    )
      return null;
  }
  if (
    baseline !== undefined &&
    baselineAncestor(baseline, record.old, "details") !== null
  )
    return detailsSlot(tree, record, oldNode, baseline);
  const target =
    record.parent === null
      ? { node: tree as Root | Element }
      : locatedBlock(tree, record.parent);
  if (target === null) return null;
  let parent = target.node;
  if (record.inlineOffset !== undefined) {
    return slotAtRenderedOffset(parent, record.inlineOffset, oldNode);
  }
  if (record.after !== null) {
    const located = locatedBlock(tree, record.after);
    if (located === null) {
      const predecessor = positionalTail(parent, record.after);
      const at =
        predecessor === null
          ? -1
          : (parent.children as RootContent[]).indexOf(predecessor);
      return at < 0 || !legalChild(parent, oldNode)
        ? null
        : { parent, at: at + 1 };
    }
    if (
      record.parent !== null &&
      target.node.type === "element" &&
      target.node.tagName === "table" &&
      oldNode.tagName === "tr"
    ) {
      if (
        located.parent.type !== "element" ||
        !["thead", "tbody", "tfoot"].includes(located.parent.tagName) ||
        !target.node.children.includes(located.parent)
      )
        return null;
      parent = located.parent;
    } else if (located.parent !== parent) {
      return null;
    }
    const at = parent.children.indexOf(located.node);
    return at < 0 || !legalChild(parent, oldNode)
      ? null
      : { parent, at: at + 1 };
  }
  if (
    record.parent !== null &&
    target.node.type === "element" &&
    target.node.tagName === "table" &&
    oldNode.tagName === "tr"
  ) {
    if (parent.type !== "element") return null;
    const section = parent.children.find(
      (child) =>
        child.type === "element" &&
        (oldNode.children.some(
          (cell) => cell.type === "element" && cell.tagName === "th",
        )
          ? child.tagName === "thead"
          : child.tagName === "tbody"),
    );
    if (section?.type !== "element") return null;
    return slotAtOffset(section, record.fallback.at, oldNode);
  }
  return slotAtOffset(parent, record.fallback.at, oldNode);
}

/** A root seam is legal even when a proposed nested parent or slot is gone. */
function fallbackStructure(
  tree: Root,
  record: StructuralDeletion,
  previous: Map<number, Element>,
): void {
  const marker = blockDeletion({
    ...record.fallback,
    block: true,
    // The marker quotes the removed block's source, which starts where the
    // block does.
    parts: record.fallback.parts ?? [
      {
        kind: "text",
        text: record.fallback.text,
        origin: { source: record.old.start },
      },
    ],
  });
  const at = record.fallback.at;
  const last = previous.get(at);
  const lastIndex = last === undefined ? -1 : tree.children.indexOf(last);
  const nextIndex = tree.children.findIndex(
    (child) => (child.position?.start.offset ?? -1) >= at,
  );
  const index = lastIndex >= 0 ? lastIndex + 1 : nextIndex;
  if (index === -1) tree.children.push(marker);
  else tree.children.splice(index, 0, marker);
  previous.set(at, marker);
}

function applyStructures(tree: Root, options: Decorations): void {
  const { baselineTree, baselineIndex, currentIndex } = options;
  const consumed = new Set<number>();
  const planned = new Set(options.structures.map((record) => record.old.index));
  const lastAtSeam = new Map<string, Element>();
  const fallbackAtSeam = new Map<number, Element>();
  const records = [...options.structures].sort(
    (a, b) =>
      (a.parent?.index ?? -1) - (b.parent?.index ?? -1) ||
      (a.after?.index ?? -1) - (b.after?.index ?? -1) ||
      a.order - b.order ||
      a.old.start - b.old.start,
  );
  for (const record of records) {
    // A parent's semantic clone (or its fallback) already contains its children.
    let ancestor = baselineIndex?.blocks[record.old.index]?.parent ?? null;
    let covered = false;
    while (ancestor !== null && baselineIndex !== undefined) {
      if (planned.has(ancestor) || consumed.has(ancestor)) {
        covered = true;
        break;
      }
      ancestor = baselineIndex.blocks[ancestor]?.parent ?? null;
    }
    if (covered || consumed.has(record.old.index)) continue;
    consumed.add(record.old.index);
    const oldBlock = baselineIndex?.blocks[record.old.index];
    const oldNode =
      baselineTree !== undefined &&
      (oldBlock === undefined ||
        (oldBlock.start === record.old.start &&
          oldBlock.end === record.old.end &&
          oldBlock.type === record.old.type))
        ? extractBaselineNode(baselineTree, record.old, (clone) => {
            stampSourceLines(clone, OLD_LINE_ATTR);
            paintRestored(clone, options.oldSpans ?? [], baselineIndex);
          })
        : null;
    if (oldNode === null) {
      fallbackStructure(tree, record, fallbackAtSeam);
      continue;
    }
    const slot = insertionParent(
      tree,
      record,
      oldNode,
      baselineTree,
      currentIndex,
    );
    if (slot === null) {
      fallbackStructure(tree, record, fallbackAtSeam);
      continue;
    }
    const seam = `${record.parent?.index ?? "root"}:${record.after?.index ?? "front"}:${record.old.type === "image" ? record.fallback.at : ""}`;
    const preceding = lastAtSeam.get(seam);
    const at =
      preceding === undefined
        ? slot.at
        : slot.parent.children.indexOf(preceding) + 1;
    if (
      at < 0 ||
      (preceding !== undefined && !slot.parent.children.includes(preceding))
    ) {
      fallbackStructure(tree, record, fallbackAtSeam);
      continue;
    }
    addClass(oldNode, "spec-del-structure");
    if (oldNode.tagName === "li") {
      if (
        slot.parent.type === "element" &&
        slot.parent.tagName === "ol" &&
        record.parent !== null
      )
        numberCurrentList(slot.parent, record.parent, currentIndex);
      const value = oldBlock?.listItemValue;
      if (value !== null && value !== undefined) {
        if (record.parent === null) {
          fallbackStructure(tree, record, fallbackAtSeam);
          continue;
        }
        if (slot.parent.type === "element" && slot.parent.tagName === "ul") {
          // This one old ordered item keeps its numeral without replacing
          // the current unordered list's marker semantics.
          addClass(oldNode, "spec-old-ordered-item");
        }
        numberItem(oldNode, value, true);
      } else if (
        slot.parent.type === "element" &&
        slot.parent.tagName === "ol"
      ) {
        addClass(oldNode, "spec-old-unordered-item");
      }
    }
    numberClonedLists(oldNode);
    slot.parent.children.splice(at, 0, oldNode);
    lastAtSeam.set(seam, oldNode);
  }
}

/**
 * Annotations on the baseline painted onto a block put back from it, while
 * the clone still has the baseline positions they are offsets into. A root
 * around it lets the clone itself be what is marked whole, as a code block
 * or an image is.
 */
function paintRestored(
  clone: Element,
  spans: SpanDecoration[],
  baseline: SegmentIndex | undefined,
): void {
  if (spans.length === 0) return;
  decorateTree(
    { type: "root", children: [clone] },
    {
      spans,
      inline: [],
      placed: new Set(),
      blocks: [],
      images: [],
      source: baseline?.source ?? null,
      baseline,
    },
    false,
  );
}

/**
 * Where `span` covers a run of removed text, relative to the run: a run of
 * the baseline's flattened text through `flatCoverage`, a run of its source
 * by plain overlap.
 */
export function coverageOf(
  origin: TextOrigin,
  length: number,
  span: SpanDecoration,
  baseline: SegmentIndex | undefined,
): SourceRange[] {
  if ("flat" in origin) {
    return baseline === undefined
      ? []
      : flatCoverage(baseline, origin.flat, length, span);
  }
  const start = Math.max(span.start, origin.source) - origin.source;
  const end = Math.min(span.end, origin.source + length) - origin.source;
  return end > start ? [{ start, end }] : [];
}

/** `value` cut at the edges of `cuts`, each part in the marks covering it. */
function marked(
  value: string,
  cuts: Array<SourceRange & { span: SpanDecoration }>,
): ElementContent[] {
  const points = [
    ...new Set([0, value.length, ...cuts.flatMap((c) => [c.start, c.end])]),
  ].sort((a, b) => a - b);
  const out: ElementContent[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const at = points[i];
    const next = points[i + 1];
    if (at === undefined || next === undefined || next <= at) continue;
    const covering = cuts
      .filter((cut) => cut.start <= at && cut.end >= next)
      .map((cut) => cut.span);
    const piece: Text = { type: "text", value: value.slice(at, next) };
    const kinds = kindsOf(covering);
    if (kinds.length === 0) out.push(piece);
    else {
      out.push(
        ...wrap([piece], kinds, covering.find((h) => h.key !== undefined)?.key),
      );
    }
  }
  return out;
}

/**
 * Annotations on the baseline painted onto the runs of removed text that
 * say where in the baseline they start: an inline deletion, a table's
 * stand-in text, a run of a marker. Each holds its text alone, so the marks
 * are cut out of that one text node.
 */
function paintRemoved(
  parent: Root | Element,
  spans: SpanDecoration[],
  baseline: SegmentIndex | undefined,
): void {
  for (const child of parent.children) {
    if (child.type !== "element") continue;
    const origin = originOf(child);
    const text = child.children[0];
    if (
      origin === null ||
      child.children.length !== 1 ||
      text?.type !== "text"
    ) {
      paintRemoved(child, spans, baseline);
      continue;
    }
    const cuts = spans.flatMap((span) =>
      coverageOf(origin, text.value.length, span, baseline).map((range) => ({
        ...range,
        span,
      })),
    );
    if (cuts.length > 0) child.children = marked(text.value, cuts);
  }
}

/**
 * Where a source offset falls in a node's value, through the node's pieces.
 * Inside an exact piece it maps by addition; inside an escape or a reference
 * the start of a range takes the piece's beginning and the end its end, so a
 * highlight touching one wraps all of it. On a character no piece holds — a
 * continuation prefix, the blanks before a soft break — a start moves on to
 * the next piece and an end back to the previous one.
 */
function valueOffsetIn(
  pieces: TextPiece[],
  offset: number,
  edge: "start" | "end",
): number {
  let at = 0;
  for (const piece of pieces) {
    if (edge === "start" && offset < piece.end) {
      return piece.exact && offset > piece.start
        ? at + (offset - piece.start)
        : at;
    }
    if (edge === "end" && offset <= piece.start) return at;
    if (edge === "end" && offset < piece.end && piece.exact) {
      return at + (offset - piece.start);
    }
    at += piece.text.length;
  }
  return at;
}

/**
 * Split one text node around the decorations that touch it. Returns null
 * when nothing applies, so untouched nodes keep their identity (T-60: a
 * rebuilt text node collapses any live selection sitting in it).
 *
 * `source` is the markdown the tree was rendered from, needed only for a
 * node whose source is longer than its value.
 */
function decorateText(
  node: Text,
  spans: SpanDecoration[],
  deletions: DeletionDecoration[],
  placed: Set<DeletionDecoration>,
  source: string | null,
  inCode: boolean,
): ElementContent[] | null {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (from === undefined || to === undefined) return null;

  const hits = hitsOf(spans, from, to);
  const cuts = deletions.filter(
    (d) => !placed.has(d) && d.at >= from && d.at <= to,
  );
  if (hits.length === 0 && cuts.length === 0) return null;

  const length = node.value.length;
  let toValue = (offset: number, _edge: "start" | "end") =>
    Math.max(0, Math.min(length, offset - from));
  // Escapes, references and continuation prefixes make the source span
  // longer than the value, and so do the backticks of inline code, whose
  // one text node carries the whole span's position; offsets inside the
  // node map through its pieces. Only a node whose pieces cannot be found
  // is decorated whole.
  if (to - from !== length) {
    const pieces =
      source === null
        ? null
        : inCode
          ? codeSpanPieces(source, from, to, node.value)
          : textPieces(source, from, to, node.value);
    if (pieces === null) {
      if (hits.length === 0) return null;
      return wrap(
        [{ type: "text", value: node.value }],
        kindsOf(hits),
        hits.find((h) => h.key !== undefined)?.key,
      );
    }
    toValue = (offset, edge) => valueOffsetIn(pieces, offset, edge);
  }
  return paintRuns(
    node.value,
    { from, to, hits, cuts, placed, toValue },
    (value): Text => ({ type: "text", value }),
  );
}

/**
 * `value`, the text a node with the source span `[from, to)` shows, cut at
 * the edges of the spans in `hits` and at the removed runs in `cuts`: each
 * run of it, made into a node by `run`, wrapped in the marks covering it,
 * and each removed run put back in place. `toValue` maps a source offset to
 * one in `value`. Null when every hit fell on characters `value` does not
 * show, such as a quote's prefix, and there is nothing to put back.
 */
function paintRuns(
  value: string,
  {
    from,
    to,
    hits,
    cuts,
    placed,
    toValue,
  }: {
    from: number;
    to: number;
    hits: SpanDecoration[];
    cuts: DeletionDecoration[];
    placed: Set<DeletionDecoration>;
    toValue: (offset: number, edge: "start" | "end") => number;
  },
  run: (value: string) => ElementContent,
): ElementContent[] | null {
  const points = new Set<number>([0, value.length]);
  const spanAt = new Map<SpanDecoration, [number, number]>();
  for (const span of hits) {
    const start = toValue(Math.max(from, span.start), "start");
    const end = toValue(Math.min(to, span.end), "end");
    if (end <= start) continue;
    spanAt.set(span, [start, end]);
    points.add(start);
    points.add(end);
  }
  // A removed run is put back where a range starting there would start.
  const cutAt = new Map<DeletionDecoration, number>();
  for (const cut of cuts) {
    const at = toValue(cut.at, "start");
    cutAt.set(cut, at);
    points.add(at);
  }
  if (spanAt.size === 0 && cuts.length === 0) return null;
  const ordered = [...points].sort((a, b) => a - b);

  const out: ElementContent[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const at = ordered[i];
    if (at === undefined) continue;
    for (const cut of cuts) {
      if (cutAt.get(cut) !== at || placed.has(cut)) continue;
      placed.add(cut);
      out.push(inlineDeletion(cut));
    }
    const next = ordered[i + 1];
    if (next === undefined || next <= at) continue;
    const covering = hits.filter((h) => {
      const range = spanAt.get(h);
      return range !== undefined && range[0] <= at && range[1] >= next;
    });
    const kinds = kindsOf(covering);
    const piece = run(value.slice(at, next));
    if (kinds.length === 0) out.push(piece);
    else
      out.push(
        ...wrap([piece], kinds, covering.find((h) => h.key !== undefined)?.key),
      );
  }
  return out;
}

/**
 * Paint the marks reaching into raw HTML, which the page shows as its own
 * source text: react-markdown turns every `raw` node into text after the
 * last rehype pass. Cut at the marks' edges, each run is still a `raw` node,
 * so it still reaches the page as text and never as markup, and the marks
 * around it are built like any other. A node whose position reads as its
 * value is cut by addition; one a line's container prefix cuts into, inline
 * HTML in a list item say, through the runs `textPieces` lines it up in,
 * as `buildSegmentIndex` records them. A node that lines up neither way is
 * left alone: `rehypeDetails` places the pieces it cuts out of a raw node
 * inside a container short by the container's prefix, and those keep no
 * mark. A removed run is never put back inside one; the text beside it
 * takes it, as it always did.
 */
function decorateRaw(
  node: Raw,
  spans: SpanDecoration[],
  source: string | null,
): ElementContent[] | null {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (from === undefined || to === undefined || source === null) return null;
  const hits = hitsOf(spans, from, to);
  if (hits.length === 0) return null;
  let toValue = (offset: number, _edge: "start" | "end") =>
    Math.max(0, Math.min(to - from, offset - from));
  if (source.slice(from, to) !== node.value) {
    const pieces = textPieces(source, from, to, node.value, false);
    if (pieces === null) return null;
    toValue = (offset, edge) => valueOffsetIn(pieces, offset, edge);
  }
  return paintRuns(
    node.value,
    { from, to, hits, cuts: [], placed: new Set(), toValue },
    (value): Raw => ({ type: "raw", value }),
  );
}

/**
 * Decorate an element without entering it — the whole thing is marked, or
 * none of it is. Returns null when nothing applies, so untouched elements
 * keep their identity the way untouched text nodes do.
 *
 * The links `paintedWhole` picks take this route, because their rendered
 * contents are not their source contents: `IssueLink` drops the children
 * and renders the title it fetched, so a mark painted inside is thrown away
 * with them (T-164).
 */
function decorateAtomic(
  element: Element,
  spans: SpanDecoration[],
  deletions: DeletionDecoration[],
  placed: Set<DeletionDecoration>,
): ElementContent[] | null {
  const from = element.position?.start.offset;
  const to = element.position?.end.offset;
  if (from === undefined || to === undefined) return null;

  const hits = hitsOf(spans, from, to);
  // Strictly inside: a caret on either edge belongs to the neighbouring
  // text node, which claims it under the same closed interval as always.
  const cuts = deletions.filter(
    (d) => !placed.has(d) && d.at > from && d.at < to,
  );
  if (hits.length === 0 && cuts.length === 0) return null;

  const out: ElementContent[] = wrap(
    [element],
    kindsOf(hits),
    hits.find((h) => h.key !== undefined)?.key,
  );
  for (const cut of cuts) {
    placed.add(cut);
    out.push(inlineDeletion(cut));
  }
  return out;
}

/**
 * Whether a link is painted whole (`decorateAtomic`) rather than entered
 * like any other element. Whole: one `MarkdownLink` draws as something
 * other than its children — a card, a user or an attachment of this
 * deployment, or any `#…` address, the shape `remarkIssueRefs` writes its
 * chips and mentions in — and one holding text with no source position,
 * which a mark has no place in: a link a project's autolink rule made out
 * of `JIRA-42`, a footnote reference's number. Every other link shows its
 * children as they are, and a mark goes on the characters inside it.
 */
function paintedWhole(link: Element): boolean {
  const href = link.properties.href;
  if (typeof href !== "string" || href.startsWith("#")) return true;
  if (parseInternalHref(href, globalThis.location?.origin) !== null) {
    return true;
  }
  const unplaced = (node: ElementContent): boolean =>
    node.type === "text"
      ? node.position === undefined
      : node.type === "element" && node.children.some(unplaced);
  return link.children.some(unplaced);
}

/**
 * The removed runs a link the walk enters puts back beside itself: those at
 * the first character of its text or in front of it, and at the last or
 * past it. Prose removed beside a link lands on the edge of its text, as a
 * run removed from the text's own ends would, and the offset cannot tell
 * the two apart; both went beside the link while links were painted whole,
 * and still do. Each is marked placed. A run strictly inside the text is
 * left to the text node that holds it. A link with no text, an image's,
 * has its own start for both edges.
 */
function besideLink(
  link: Element,
  inline: DeletionDecoration[],
  placed: Set<DeletionDecoration>,
): BesideCode {
  const beside: BesideCode = { before: [], after: [] };
  const from = link.position?.start.offset;
  const to = link.position?.end.offset;
  if (from === undefined || to === undefined) return beside;
  const texts: Text[] = [];
  const collect = (node: ElementContent) => {
    if (node.type === "text") texts.push(node);
    else if (node.type === "element") node.children.forEach(collect);
  };
  link.children.forEach(collect);
  const first = texts[0]?.position?.start.offset ?? from;
  const last = texts.at(-1)?.position?.end.offset ?? from;
  for (const cut of inline) {
    if (placed.has(cut) || cut.at < from || cut.at > to) continue;
    if (cut.at > first && cut.at < last) continue;
    placed.add(cut);
    (cut.at <= first ? beside.before : beside.after).push(cut);
  }
  return beside;
}

/**
 * Whether a removed run was code taken off the ends of a code span that
 * survived, by the baseline it came from: all of the run lies in the span's
 * code, and some of that code lies outside the run. A whole span removed, or
 * a run reaching into the prose beside one, is not; neither belongs in the
 * code of a span that is still there.
 */
function removedFromCode(
  deletion: DeletionDecoration,
  baseline: SegmentIndex | undefined,
): boolean {
  const origin = deletion.origin;
  if (baseline === undefined || origin === undefined || !("flat" in origin)) {
    return false;
  }
  const from = origin.flat;
  const to = from + deletion.text.length;
  const { segments } = baseline;
  const at = segments.findIndex((s) => from < s.at + s.text.length);
  const holder = segments[at];
  if (holder?.code !== true || holder.at > from) return false;
  // One span's pieces run on in the flattened text with nothing between.
  const joined = (a?: SourceSegment, b?: SourceSegment) =>
    a?.code === true && b?.code === true && a.at + a.text.length === b.at;
  let first = at;
  while (joined(segments[first - 1], segments[first])) first--;
  let last = at;
  while (joined(segments[last], segments[last + 1])) last++;
  const start = segments[first]?.at ?? from;
  const end = (segments[last]?.at ?? 0) + (segments[last]?.text.length ?? 0);
  return to <= end && (start < from || to < end);
}

/** Removed runs an inline `<code>` puts back beside itself. */
type BesideCode = { before: DeletionDecoration[]; after: DeletionDecoration[] };

/**
 * Where the removed runs at the ends of each inline `<code>` among `parent`'s
 * children go. A run at the first character of a span's code or before it,
 * or at the last or after it, is as often prose removed beside the code as
 * code removed from its ends, and its offset cannot tell which; the baseline
 * can (`removedFromCode`). Prose is returned to be put back beside the span,
 * and is marked placed. Code is left to the span's text node to put back at
 * that end, and returned in `kept`, which the prose in front must not claim.
 * A run strictly inside the code is left to the text node too.
 */
function besideCode(
  parent: Root | Element,
  paint: TreePaint,
): { spans: Map<Element, BesideCode>; kept: Set<DeletionDecoration> } {
  const spans = new Map<Element, BesideCode>();
  const kept = new Set<DeletionDecoration>();
  const codes = (parent.children as ElementContent[]).filter(
    (child): child is Element =>
      child.type === "element" && child.tagName === "code",
  );
  if (codes.length === 0 || paint.source === null) return { spans, kept };
  const open = paint.inline.filter((d) => !paint.placed.has(d));
  if (open.length === 0) return { spans, kept };
  for (const code of codes) {
    const text = code.children[0];
    const from = text?.position?.start.offset;
    const to = text?.position?.end.offset;
    if (text?.type !== "text" || from === undefined || to === undefined) {
      continue;
    }
    const pieces = codeSpanPieces(paint.source, from, to, text.value);
    const first = pieces?.[0];
    const last = pieces?.at(-1);
    if (first === undefined || last === undefined) continue;
    const beside: BesideCode = { before: [], after: [] };
    for (const cut of open) {
      if (cut.at < from || cut.at > to) continue;
      if (cut.at > first.start && cut.at < last.end) continue;
      if (removedFromCode(cut, paint.baseline)) {
        kept.add(cut);
        continue;
      }
      paint.placed.add(cut);
      (cut.at <= first.start ? beside.before : beside.after).push(cut);
    }
    spans.set(code, beside);
  }
  return { spans, kept };
}

/**
 * The whole-block class a `<pre>` or an `<img>` wears when a mark reaches
 * into it, or null. pierre owns the inside of a code block (T-31), and an
 * image has no inside, so a span crossing one has no text node to land on
 * and the block itself has to say it.
 * Insertions are already covered: a wholly-new fence gets INS_BLOCK_CLASS
 * from `blocks`, and word-level diffs only ever map onto prose.
 */
function markBlockClass(
  element: Element,
  spans: SpanDecoration[],
): string | null {
  const from = element.position?.start.offset;
  const to = element.position?.end.offset;
  if (from === undefined || to === undefined) return null;
  const kinds = kindsOf(hitsOf(spans, from, to));
  // Outermost of NESTING wins, as it would if the two could nest here.
  if (kinds.includes("comment")) return COMMENT_BLOCK_CLASS;
  return kinds.includes("draft") ? DRAFT_BLOCK_CLASS : null;
}

/** What `decorateTree` paints, and the source the tree's positions are in. */
type TreePaint = {
  spans: SpanDecoration[];
  /** Inline deletions, and those of them already put back. */
  inline: DeletionDecoration[];
  placed: Set<DeletionDecoration>;
  blocks: SourceRange[];
  images: ImageSwap[];
  source: string | null;
  /** The version `inline` was removed from, when there is one. */
  baseline?: SegmentIndex;
};

/**
 * Paint spans, inline deletions, wholly-new blocks and image swaps onto the
 * children of `parent`, a tree whose positions are offsets into
 * `paint.source`: the document being rendered, or a block put back from
 * its baseline (`paintRestored`).
 */
function decorateTree(
  parent: Root | Element,
  paint: TreePaint,
  insideAdded: boolean,
): void {
  const next: ElementContent[] = [];
  let changed = false;
  const beside = besideCode(parent, paint);
  // Removed code kept for a `<code>` is not for the text around it.
  const inline =
    beside.kept.size === 0
      ? paint.inline
      : paint.inline.filter((d) => !beside.kept.has(d));
  for (const child of parent.children as ElementContent[]) {
    if (child.type === "element") {
      // The class goes on the outermost element of a wholly-new range
      // and nowhere below it, but the walk carries on regardless: an
      // annotation anchored inside still has its mark to paint.
      let added = insideAdded;
      if (!added && fullyInside(child, paint.blocks)) {
        addClass(child, INS_BLOCK_CLASS);
        added = true;
      }
      if (child.tagName === "a" && paintedWhole(child)) {
        const pieces = decorateAtomic(
          child,
          paint.spans,
          paint.inline,
          paint.placed,
        );
        if (pieces === null) next.push(child);
        else {
          next.push(...pieces);
          changed = true;
        }
        continue;
      }
      if (child.tagName === "a") {
        const edges = besideLink(child, inline, paint.placed);
        for (const cut of edges.before) next.push(inlineDeletion(cut));
        decorateTree(child, paint, added);
        next.push(child);
        for (const cut of edges.after) next.push(inlineDeletion(cut));
        if (edges.before.length + edges.after.length > 0) changed = true;
        continue;
      }
      if (child.tagName === "pre") {
        const wash = markBlockClass(child, paint.spans);
        if (wash !== null) addClass(child, wash);
        next.push(child);
        continue;
      }
      const edges = beside.spans.get(child);
      if (edges !== undefined) {
        for (const cut of edges.before) next.push(inlineDeletion(cut));
        decorateTree(child, paint, added);
        next.push(child);
        for (const cut of edges.after) next.push(inlineDeletion(cut));
        if (edges.before.length + edges.after.length > 0) changed = true;
        continue;
      }
      // A swapped image is marked on the `<img>` itself, never through
      // `blocks` and `fullyInside` (T-223): those put the class on the
      // outermost element of the range, which is the `<p>` when the image
      // has a paragraph to itself and the `<img>` when it does not — and
      // the `<p>` would then wrap the old image's `<del>` in the green
      // that means "new". No wrapper element either: `markdown-view.tsx`
      // decides whether a paragraph carries an embed card by asking
      // whether an `<img>` is a direct child of the `<p>`, and a flex
      // container in between would both break that test and produce a
      // `<div>` inside a `<p>`. Side by side is two `inline-block`s.
      if (child.tagName === "img") {
        // An image shows no text to put a mark in, and a mark reaching
        // into one — a selection made inside a document card anchors
        // to the whole `![…](…)` — would show nowhere but the rail. It
        // wears the block class a `<pre>` does, which reaches a
        // document card or a picture through its `className`.
        const wash = markBlockClass(child, paint.spans);
        if (wash !== null) addClass(child, wash);
        const swap = paint.images.find(
          (image) => image.at.start === child.position?.start.offset,
        );
        if (swap === undefined) {
          next.push(child);
          continue;
        }
        if (!added) addClass(child, INS_BLOCK_CLASS);
        if (swap.old !== null) {
          addClass(child, IMG_NEW_CLASS);
          next.push(swappedOutImage(swap.old));
          // Only now: `addClass` edits in place and leaves the node's
          // identity alone, but splicing a sibling in means `next` has to
          // replace `parent.children` or the new element is lost (T-60 is
          // why that distinction is worth keeping).
          changed = true;
        }
        next.push(child);
        continue;
      }
      decorateTree(child, paint, added);
      next.push(child);
      continue;
    }
    if (child.type === "raw") {
      const pieces = decorateRaw(child, paint.spans, paint.source);
      if (pieces === null) next.push(child);
      else {
        next.push(...pieces);
        changed = true;
      }
      continue;
    }
    if (child.type !== "text") {
      next.push(child);
      continue;
    }
    // The walk never enters a `<pre>`, so a `<code>` here is inline code.
    const pieces = decorateText(
      child,
      paint.spans,
      inline,
      paint.placed,
      paint.source,
      parent.type === "element" && parent.tagName === "code",
    );
    if (pieces === null) next.push(child);
    else {
      next.push(...pieces);
      changed = true;
    }
  }
  if (changed) parent.children = next as typeof parent.children;
}

/**
 * Rehype plugin painting source-offset decorations onto the rendered tree
 * (T-142). Text spans without a host are left alone, but structural removals
 * that cannot be restored as semantic nodes leave one source marker instead.
 *
 * Two kinds of element are decorated whole instead of entered — code
 * blocks, whose contents belong to pierre, and links, whose contents
 * belong to `IssueLink`. Both still carry an outer class or wrapper, which
 * is how a mark reaching into either still shows (T-164).
 *
 * A fence is walled off twice over, and opening either wall alone changes
 * nothing. Its text never enters `SegmentIndex.text` or `segments` (T-211),
 * so no decoration is ever computed for one; and `MarkdownPre` builds what it
 * hands pierre's CodeView out of the `<pre>`'s text children alone, so an
 * injected `<ins>` takes the code it wraps out of the display with it (T-31).
 * Which line of a fence moved is answered outside this plugin entirely, by
 * handing pierre both versions of the body (T-343).
 */
export function rehypeDecorations(options: Decorations = NO_DECORATIONS) {
  const spans = options.spans;
  const deletions = options.deletions;
  const blocks = options.blocks;
  const tables = options.tables;
  const images = options.images;
  // react-markdown hands every plugin the string it renders as `file.value`,
  // the same string the segment index was built from.
  return (tree: Root, file?: { value?: unknown }) => {
    const source = typeof file?.value === "string" ? file.value : null;
    if (
      spans.length === 0 &&
      deletions.length === 0 &&
      blocks.length === 0 &&
      tables.length === 0 &&
      images.length === 0 &&
      options.structures.length === 0
    ) {
      return;
    }
    decorateTree(
      tree,
      {
        spans,
        inline: deletions.filter((d) => !d.block),
        placed: new Set(),
        blocks,
        images,
        source,
        baseline: options.baselineIndex,
      },
      false,
    );

    // Structural deletions have no host inside the text; they go between
    // the blocks, at the seam the removed content left behind. Placed back
    // to front so earlier splices don't move later insertion points.
    const structural = deletions
      .filter((d) => d.block)
      .sort((a, b) => b.at - a.at);
    for (const deletion of structural) {
      const index = (tree.children as RootContent[]).findIndex(
        (child) => (child.position?.start.offset ?? -1) >= deletion.at,
      );
      const marker = blockDeletion(deletion);
      if (index === -1) tree.children.push(marker);
      else tree.children.splice(index, 0, marker);
    }

    for (const overlay of tables) applyOverlay(tree, overlay);
    applyStructures(tree, options);
    if (options.oldSpans !== undefined && options.oldSpans.length > 0) {
      paintRemoved(tree, options.oldSpans, options.baselineIndex);
    }
  };
}
