import { elementNear } from "./selection-endpoints.ts";

/**
 * pierre's line rows, read as text. Every surface it draws — a code block, a
 * diff, a whole file — renders each line as a `[data-line]` element inside an
 * open shadow root, whose text content is that line and nothing else: the
 * line number sits in a separate gutter column, and token and word-diff spans
 * only wrap pieces of the text without adding to it.
 */

/** Which side of a diff one of pierre's line rows numbers itself on. */
export const LINE_TYPE_ATTR = "data-line-type";
export const DELETION_LINE_TYPE = "change-deletion";

/**
 * The row a node sits in. `closest` stays inside the node's own tree, which
 * is the point: a row never holds a shadow host, so climbing out of a shadow
 * root could only ever find somebody else's row.
 */
export function rowAt(node: Node): Element | null {
  return elementNear(node)?.closest("[data-line]") ?? null;
}

/**
 * A row's line text. An empty line is `""` in pierre's `File` but `"\n"` in
 * its CodeView and its diffs, and both mean the same line with nothing on it.
 */
export function rowText(row: Element): string {
  const text = row.textContent ?? "";
  return text === "\n" ? "" : text;
}

/**
 * A row's text as the line it shows, to compare with a source line read by
 * `lineTextOf`: a CRLF file's line may reach pierre with its `\r`, and the
 * line it is compared with has none.
 */
export function rowLineText(row: Element): string {
  const text = rowText(row);
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/**
 * Where a boundary point falls in its row's text, or null when it is not in
 * the row. The text from the row's start to the point is what precedes it,
 * whether the point names a text node and a character in it or an element
 * and a child, and a range measures exactly that.
 */
export function offsetInRow(
  row: Element,
  node: Node,
  offset: number,
): number | null {
  if (!row.contains(node)) return null;
  const range = (row.ownerDocument ?? document).createRange();
  range.setStart(row, 0);
  try {
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  // An empty line's "\n" is not text the line holds.
  return Math.min(range.toString().length, rowText(row).length);
}

/**
 * The DOM range covering `[from, to)` of a row's text, the inverse of
 * `offsetInRow`; null when that is empty or runs past the row. Each end lands
 * in the text node holding its character, so a highlight painted over it
 * starts and stops at those characters and nowhere near the row's edges.
 */
export function rangeInRow(
  row: Element,
  from: number,
  to: number,
): Range | null {
  if (from < 0 || to <= from || to > rowText(row).length) return null;
  const doc = row.ownerDocument ?? document;
  const walker = doc.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let start: { node: Node; offset: number } | null = null;
  let seen = 0;
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const length = n.nodeValue?.length ?? 0;
    // A start on a boundary belongs to the node after it, an end to the one
    // before: neither end should sit on a node it covers nothing of.
    if (start === null && from < seen + length) {
      start = { node: n, offset: from - seen };
    }
    if (start !== null && to <= seen + length) {
      const range = doc.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(n, to - seen);
      return range;
    }
    seen += length;
  }
  return null;
}
