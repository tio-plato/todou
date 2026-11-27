import type { Nodes } from "mdast";
import remarkBreaks from "remark-breaks";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { type PluggableList, unified } from "unified";
import {
  FRONTMATTER_FLAVOURS,
  remarkFrontmatterTable,
} from "./remark-frontmatter-table.ts";
import { remarkLineFeedPositions } from "./remark-line-feed-positions.ts";
import { remarkRejectedUrlsAsText } from "./remark-rejected-urls.ts";

/**
 * Static Markdown syntax shared by every parser and renderer.
 *
 * Keep runtime-dependent plugins (issue references and occurrence counting)
 * in the caller: their options belong to the project/viewer context. Keeping
 * this array at module scope also lets renderers retain plugin-list identity
 * instead of rebuilding the invariant prefix on every render.
 *
 * The order is significant. Rejected URLs are restored to source text before
 * later tokenizers see them, and `remarkFrontmatterTable` consumes the nodes
 * produced by `remarkFrontmatter`. Without that tokenizer, frontmatter lines
 * that begin with digits are parsed as ordered-list items (T-383). Lines are
 * recounted by line feeds alone first, so every later pass reads those.
 */
export const MARKDOWN_SYNTAX_PLUGINS: PluggableList = [
  remarkLineFeedPositions,
  remarkGfm,
  remarkRejectedUrlsAsText,
  [remarkFrontmatter, FRONTMATTER_FLAVOURS],
  remarkFrontmatterTable,
];

/**
 * Syntax for text a person typed into the tracker — issue bodies, comments,
 * questions, annotations — where a single newline is a line break, as on
 * github.com (T-702). Documents keep `MARKDOWN_SYNTAX_PLUGINS`, where it stays
 * a space. `remarkBreaks` goes last so that this is the document list plus
 * one pass: every pass the two share sees the same tree in both, and a
 * document never meets the breaks.
 */
export const MESSAGE_SYNTAX_PLUGINS: PluggableList = [
  ...MARKDOWN_SYNTAX_PLUGINS,
  remarkBreaks,
];

/**
 * A message's text with each lone `\r` written as `\n`. CommonMark ends a
 * line at a lone `\r` as at `\n`, so the markdown means the same; only the
 * line numbers change, and they then agree with the line feeds everything
 * after this counts by. A run of `\r` right before a `\n` stays: a CRLF, and
 * the `\r\r\n` a CRLF file's lines end in when it is pasted into a CRLF
 * message, where a code block draws that `\r` as part of its line. The
 * length stays, so every offset does.
 *
 * Messages and quotes only. A document — a spec file, an attached `.md` —
 * keeps its lone `\r`s: annotations anchor to its lines, which have to stay
 * the server's, counted by `\n` alone.
 */
export function withLineFeeds(text: string): string {
  return text.replace(/\r+(?![\r\n])/g, (run) => "\n".repeat(run.length));
}
const processor = unified().use(remarkParse).use(MARKDOWN_SYNTAX_PLUGINS);

/**
 * `runSync`, not `parse` alone: `parse` stops at the tokenizer and runs no
 * transformer, so `remarkFrontmatterTable` — which is one — would never fire
 * and the caller would hold the `yaml` leaf while the DOM held a table.
 */
export function parseMarkdown(source: string): Nodes {
  return processor.runSync(processor.parse(source), source) as Nodes;
}
