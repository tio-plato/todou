import type { Nodes, Root } from "mdast";
import type { Transformer } from "unified";
import { lineColAt, lineStartsOf } from "./spec-source-index.ts";

/**
 * Restate every node's line and column the way the source's line feeds count
 * them. micromark ends a line at a lone `\r` as well, as CommonMark has it,
 * while the source index, pierre's rows and the server count lines by `\n`
 * alone; past the first lone `\r` the two would name different lines. The
 * offsets are untouched, and a source with no lone `\r` is left as it is.
 *
 * A function declaration, not a const: this module and the source index
 * import each other through `markdown-processor.ts`, and a declaration is
 * there whichever of them loads first.
 */
export function remarkLineFeedPositions(): Transformer<Root> {
  return (tree, file) => {
    const source = String(file);
    if (!/\r(?!\n)/.test(source)) return;
    const index = { lineStarts: lineStartsOf(source) };
    const visit = (node: Nodes): void => {
      for (const point of node.position === undefined
        ? []
        : [node.position.start, node.position.end]) {
        if (point.offset === undefined) continue;
        const { line, col } = lineColAt(index, point.offset);
        point.line = line;
        point.column = col;
      }
      if ("children" in node) for (const child of node.children) visit(child);
    };
    visit(tree);
  };
}
