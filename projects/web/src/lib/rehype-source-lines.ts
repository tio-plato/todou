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
 * Rehype plugin stamping every block element with the markdown source line
 * range it was rendered from. This is the whole bridge between "what the
 * reviewer selected in the rendered document" and "which source lines the
 * anchor stores" — remark/rehype keep positions intact, so no offset math.
 * Links and images get their source offsets as well (`SOURCE_SPAN_ATTR`).
 */
export function rehypeSourceLines() {
  return (tree: Root) => {
    const visit = (node: Root | Element) => {
      if (
        node.type === "element" &&
        BLOCK_TAGS.has(node.tagName) &&
        node.position?.start.line !== undefined &&
        node.position.end.line !== undefined
      ) {
        node.properties[SOURCE_LINE_ATTR] =
          `${node.position.start.line}-${node.position.end.line}`;
      }
      if (
        node.type === "element" &&
        SPAN_TAGS.has(node.tagName) &&
        node.position?.start.offset !== undefined &&
        node.position.end.offset !== undefined
      ) {
        node.properties[SOURCE_SPAN_ATTR] =
          `${node.position.start.offset}-${node.position.end.offset}`;
      }
      if ("children" in node) {
        for (const child of node.children) {
          if (child.type === "element") visit(child);
        }
      }
    };
    visit(tree);
  };
}
