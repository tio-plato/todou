import type { Element, ElementContent, Root, RootContent } from "hast";
import { advance, type Raw } from "./rehype-details.ts";

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
 * Wrap each run of raw HTML at the top level in a stamped `div`.
 *
 * A block of HTML outside every container renders as text straight under the
 * root (react-markdown turns `raw` into text), in no stamped block, so a
 * selection in it had no anchor at all. A run is a `raw` node and every `raw`
 * or blank text node after it, the trailing blanks left out: `rehypeDetails`
 * leaves the tags it could not pair as `raw` nodes beside the text between
 * them, and two blocks of HTML a blank line apart have nothing between them but
 * a `"\n"`. All of that reads as one line of text today, and one wrapper keeps
 * it so where a wrapper each would break it into lines. A run of blank `raw`
 * nodes is no block.
 *
 * The wrapper is built from constants, its children are the run's nodes as they
 * were, and a `div` adds no margin, so the page looks as it did, but for one
 * thing: at the end of a body the wrapper is the last child, so the block
 * before it keeps its bottom margin, the gap a block of HTML anywhere else
 * already had above it.
 *
 * It carries the run's `position`, from its first character that is not blank
 * to its last (a run cut out after a fold opens with the ending of the fold's
 * line, and would claim that line too): a comparison folds the top-level
 * elements its changes and annotations do not reach, by their lines, and places
 * a structural deletion by their offsets; without one it would fold away under
 * an annotation. Being one, it now folds with the unchanged blocks around it,
 * where the bare text stayed out in the middle of a fold. A run whose ends have
 * no position is left unwrapped. Only the top level: a quote, a list item and a
 * fold already stamp the block their HTML sits in, and a compact list item
 * holds its inline HTML directly.
 */
function wrapRawRuns(tree: Root): void {
  const out: RootContent[] = [];
  const children = tree.children;
  for (let i = 0; i < children.length; i++) {
    const first = children[i];
    if (first?.type !== "raw") {
      if (first !== undefined) out.push(first);
      continue;
    }
    let end = i + 1;
    while (end < children.length && isRunPart(children[end])) end++;
    let last = end - 1;
    while (last > i && children[last]?.type !== "raw") last--;
    const run = children.slice(i, last + 1);
    const shown = run.filter(
      (node): node is Raw => node.type === "raw" && /\S/.test(node.value),
    );
    const head = shown[0];
    const tail = shown.at(-1);
    const from = head?.position?.start;
    const to = tail?.position?.start;
    if (head === undefined || tail === undefined || !from || !to) {
      out.push(...run);
    } else {
      const start = advance(from, head.value.slice(0, head.value.search(/\S/)));
      const end = advance(to, tail.value.trimEnd());
      out.push({
        type: "element",
        tagName: "div",
        properties: { [SOURCE_LINE_ATTR]: `${start.line}-${end.line}` },
        position: { start, end },
        children: run as ElementContent[],
      });
    }
    i = last;
  }
  tree.children = out;
}

/** Whether `node` can continue a run of raw HTML (`wrapRawRuns`). */
function isRunPart(node: RootContent | undefined): boolean {
  return (
    node?.type === "raw" || (node?.type === "text" && !/\S/.test(node.value))
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
    wrapRawRuns(tree);
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
