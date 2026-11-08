import type { Element, Root } from "hast";

/**
 * Block-level tags that make useful annotation anchors. Inline elements are
 * skipped: a selection maps to its closest block, which is the granularity
 * spec comments anchor at (redline did the same via sourcepos).
 *
 * `tr` is on the list even though it nests inside `table` (T-142). A GFM
 * table row is exactly one source line, so stamping rows is what lets one
 * edited cell highlight its own row instead of washing the whole table
 * green; the table keeps its stamp as the fallback for table-wide
 * selections. Consumers resolve nesting by taking the innermost match.
 *
 * `details` is here for a second reason on top of that one (T-385): a reader
 * who closes a fold leaves every annotation inside it with a zero rect, and
 * the chip layout walks up the stamped ancestors to find something it can
 * still measure — the fold's own header.
 */
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "pre",
  "blockquote",
  "details",
  "table",
  "tr",
  "hr",
]);

export const SOURCE_LINE_ATTR = "data-loc";

/**
 * The compare baseline's counterparts of `SOURCE_LINE_ATTR`, worn by what a
 * rendered comparison puts back of the baseline, so that a selection in
 * removed content can anchor to the baseline. A block restored whole carries
 * its baseline source lines; a run of removed text carries where its first
 * character sits, in the baseline's flattened text (`OLD_FLAT_ATTR`) or in
 * its source (`OLD_SOURCE_ATTR`), as `TextOrigin` says.
 */
export const OLD_LINE_ATTR = "data-old-loc";
export const OLD_FLAT_ATTR = "data-old-at";
export const OLD_SOURCE_ATTR = "data-old-src";

/**
 * The absolute source offsets `start-end` (half-open) a link or an image
 * was rendered from. A chip shows a title where the source says `#12`, and a
 * document card shows a file the source names by address, so neither reads
 * like its source; this is how a selection touching one still finds where
 * it lies, and takes it whole.
 */
export const SOURCE_SPAN_ATTR = "data-loc-span";

/** Inline elements whose rendered text may differ from their source. */
const SPAN_TAGS = new Set(["a", "img"]);

/**
 * Where a code block's contents begin in the source (T-52). The stamped
 * range starts at the ``` marker for fenced blocks but at the first code
 * line for indented ones; the renderer records the resolved start so
 * selection anchoring can map pierre's per-line rows back to source lines
 * without re-deriving markdown syntax.
 */
export const CODE_CONTENT_START_ATTR = "data-loc-content-start";

/**
 * The line a code block's contents begin on, for a block on source lines
 * `loc` whose body has `contentLines` lines. Whether there is a marker line
 * to skip is answered by the line count, not by reading the opening line: a
 * fence inside a blockquote opens on "> ```ts", whose `>` survives
 * trimStart().
 */
export function codeContentStart(
  loc: { start: number; end: number },
  contentLines: number,
): number {
  const span = loc.end - loc.start + 1;
  return loc.start + (span - contentLines >= 1 ? 1 : 0);
}

/**
 * Marks a code block drawn by the patch viewer. Its rows are numbered by the
 * patched files rather than by the block, so anchoring maps them back through
 * the block's own text instead of through `data-line`.
 */
export const FENCE_PATCH_ATTR = "data-fence-patch";

/** `data-loc="start-end"` → 1-based inclusive source line range. */
export function parseSourceLoc(
  value: string | null | undefined,
): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]) };
}

/**
 * Stamp every block element in `node`, itself included, with the source line
 * range it was rendered from, as `attr`: `SOURCE_LINE_ATTR` for the document
 * being rendered, `OLD_LINE_ATTR` for a block put back from the baseline.
 */
export function stampSourceLines(node: Root | Element, attr: string): void {
  if (
    node.type === "element" &&
    BLOCK_TAGS.has(node.tagName) &&
    node.position?.start.line !== undefined &&
    node.position.end.line !== undefined
  ) {
    node.properties[attr] =
      `${node.position.start.line}-${node.position.end.line}`;
  }
  for (const child of node.children) {
    if (child.type === "element") stampSourceLines(child, attr);
  }
}

/**
 * Give back the blank `mdast-util-to-hast` appends to a footnote
 * definition's last text, in front of the link back to the reference. The
 * text keeps its position, which then no longer reads as its value: a
 * highlight in it took the whole node, and a selection in it the whole line.
 * The blank goes into a text node of its own with no position, like the one
 * the renderer inserts when the definition does not end in text, which both
 * the selection mapping and the highlights already pass over. Whatever the
 * text's source holds, its last blank is the renderer's: it appends one to
 * the definition's last text every time (its `lib/footer.js`), so no blank
 * of the source is ever split off.
 */
function splitFootnoteBlank(parent: Element): void {
  const at = parent.children.findIndex(
    (child) =>
      child.type === "element" &&
      child.tagName === "a" &&
      child.properties.dataFootnoteBackref !== undefined,
  );
  const text = parent.children[at - 1];
  // One with no position is the renderer's own blank, already apart.
  if (
    text?.type !== "text" ||
    text.position === undefined ||
    !text.value.endsWith(" ")
  ) {
    return;
  }
  parent.children.splice(
    at - 1,
    1,
    { ...text, value: text.value.slice(0, -1) },
    { type: "text", value: " " },
  );
}

/**
 * Rehype plugin stamping every block element with the markdown source line
 * range it was rendered from. This is the whole bridge between "what the
 * reviewer selected in the rendered document" and "which source lines the
 * anchor stores" — remark/rehype keep positions intact, so no offset math.
 * Links and images get their source offsets as well (`SOURCE_SPAN_ATTR`).
 */
export function rehypeSourceLines() {
  return (tree: Root) => {
    stampSourceLines(tree, SOURCE_LINE_ATTR);
    const visit = (node: Root | Element) => {
      if (node.type === "element") {
        if (
          SPAN_TAGS.has(node.tagName) &&
          node.position?.start.offset !== undefined &&
          node.position.end.offset !== undefined
        ) {
          node.properties[SOURCE_SPAN_ATTR] =
            `${node.position.start.offset}-${node.position.end.offset}`;
        }
        splitFootnoteBlank(node);
      }
      for (const child of node.children) {
        if (child.type === "element") visit(child);
      }
    };
    visit(tree);
  };
}
