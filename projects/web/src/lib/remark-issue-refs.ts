import {
  DEFAULT_REF_CONFIG,
  type RefConfig,
  type RefSegment,
  splitIssueRefs,
} from "@/lib/issue-refs.ts";
import {
  sourceOffsetsOfRendered,
  type TextPiece,
  textPieces,
} from "@/lib/spec-source-index.ts";

type Point = { line: number; column: number; offset: number };

/**
 * Minimal structural mdast shape — typed locally so we don't have to add
 * @types/mdast (react-markdown keeps it a transitive dep under pnpm).
 */
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  data?: { hProperties?: Record<string, string> };
  position?: { start: Point; end: Point };
  children?: MdNode[];
};

/**
 * Node types whose subtree must never be linkified: code by requirement
 * (T-6), links because nesting an anchor inside an anchor is invalid HTML.
 * `code` and `inlineCode` are leaves without children, but listing them
 * documents the exemption where a reader looks for it.
 *
 * `frontmatter` is here because it is the one entry that is not self-enforcing
 * (T-240). A `yaml` node has no children and so was exempt by accident; the
 * table `remarkFrontmatterTable` puts in its place has `text` children, and
 * metadata is not prose — `related: F-1` in a frontmatter value would be
 * replaced by another card's title, which is the half of that card's bug that
 * matters. Naming the container makes the whole subtree exit early whatever
 * order the plugins run in; relying on this one running first would be an
 * implicit constraint the next person to touch that array cannot see.
 */
const OPAQUE = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "frontmatter",
]);

/**
 * The fragment hrefs MarkdownLink recognises. A fragment rather than a
 * real path because the destination is only knowable after a lookup the
 * renderer does — an <a href> written here would be a promise the link
 * cannot always keep.
 */
export function refHref(segment: RefSegment): string {
  switch (segment.type) {
    case "ref":
      return segment.commentId === undefined
        ? `#issue-${segment.number}`
        : `#issue-${segment.number}/comment-${segment.commentId}`;
    case "xref":
      return segment.commentId === undefined
        ? `#xref-${segment.slug}/${segment.number}`
        : `#xref-${segment.slug}/${segment.number}/comment-${segment.commentId}`;
    case "comment":
      return `#xref-comment-${segment.commentId}`;
    case "mention":
      return `#mention-${segment.login}`;
    default:
      return "";
  }
}

export type RefPluginOptions = {
  /**
   * Leave issue tokens as plain text and linkify only external autolinks.
   *
   * What reading mode wants since T-266: a reference is resolved when it is
   * submitted and stored as a real link, so a bare `#12` still sitting in
   * stored text is one that did NOT resolve — rendering it as a link would
   * put back the guess the whole design removes. An autolink has no address
   * here to store, so it goes on being expanded at render time.
   */
  autolinksOnly?: boolean;
};

/**
 * remark plugin: turn reference tokens in text into links. Reference
 * tokens become links the MarkdownView `a` renderer recognises by their
 * fragment href and upgrades to <IssueLink>; autolink tokens become plain
 * external links. Operating on the AST (not the source) is what exempts
 * code blocks and inline code — their text lives in opaque leaf nodes.
 * Config is per-content; pass it via the remark options tuple:
 * `[remarkIssueRefs, config, options]`.
 */
export function remarkIssueRefs(
  config: RefConfig = DEFAULT_REF_CONFIG,
  options: RefPluginOptions = {},
) {
  // react-markdown hands every plugin the string it renders as `file.value`,
  // the one the positions are offsets into.
  return (tree: MdNode, file?: { value?: unknown }) =>
    visit(
      tree,
      config,
      options,
      typeof file?.value === "string" ? file.value : null,
    );
}

function visit(
  node: MdNode,
  config: RefConfig,
  options: RefPluginOptions,
  source: string | null,
): void {
  if (node.children === undefined || OPAQUE.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const segments = keep(splitIssueRefs(child.value, config), options);
      if (segments.some((s) => s.type !== "text")) {
        next.push(...split(child, segments, source));
        continue;
      }
    }
    visit(child, config, options, source);
    next.push(child);
  }
  node.children = next;
}

/** Demote the segment kinds this mode does not linkify back to plain text. */
function keep(segments: RefSegment[], options: RefPluginOptions): RefSegment[] {
  if (options.autolinksOnly !== true) return segments;
  return segments.map((segment) =>
    segment.type === "text" || segment.type === "ext"
      ? segment
      : { type: "text", value: segment.text },
  );
}

/** The point `text` characters past `from`, counting the lines it crosses. */
function advance(from: Point, text: string): Point {
  const lines = text.split("\n");
  const last = lines[lines.length - 1] ?? "";
  return {
    line: from.line + lines.length - 1,
    column: lines.length > 1 ? last.length + 1 : from.column + text.length,
    offset: from.offset + text.length,
  };
}

/**
 * Replace one text node with its segments, each carrying the source span it
 * came from. The spans are what the decoration engine paints annotations
 * and word-level diffs onto (T-142/T-164): pieces without one are skipped
 * outright, so a single ref used to cost a whole paragraph its highlight.
 *
 * Entities, escapes and a list item's continuation indent stretch a node's
 * source span past its value, so an offset in the value maps to the source
 * through the node's pieces (`textPieces`), the way a selection's does: a
 * segment starting between two pieces starts where the next one does, one
 * ending there ends where the previous one does, and one starting (ending)
 * inside an escape takes its beginning (its end). Only when the pieces
 * cannot be found, or the source is not at hand for such a node, does every
 * segment claim the whole node instead — which the engine reads as
 * "indivisible" and highlights in one go, and which a selection beside an
 * autolink then took for an atom.
 */
function split(
  node: MdNode,
  segments: RefSegment[],
  source: string | null,
): MdNode[] {
  const span = node.position;
  const value = node.value ?? "";
  const placed = span === undefined ? null : placeIn(span, value, source);
  const out: MdNode[] = [];
  let at = 0;
  for (const segment of segments) {
    const length = (segment.type === "text" ? segment.value : segment.text)
      .length;
    out.push(nodeFor(segment, placed?.(at, at + length) ?? span));
    at += length;
  }
  return out;
}

/**
 * The position of `[from, to)` of a node's value, or null when the node's
 * pieces cannot be found. A node whose source reads as its value is one
 * piece, read by addition: `textPieces` would take a `&amp;` it holds as
 * written, as a plugin before this one leaves rejected link text, for a
 * reference. Without the source, a node whose span is exactly as long as its
 * value is taken for one.
 *
 * The segments are placed in order, so both the walk through the pieces and
 * the point carried along the source only move forward: a paragraph of many
 * references costs its length, not its length times their number.
 */
function placeIn(
  span: { start: Point; end: Point },
  value: string,
  source: string | null,
): ((from: number, to: number) => MdNode["position"]) | null {
  const start = span.start.offset;
  const end = span.end.offset;
  const verbatim =
    source === null
      ? end - start === value.length
      : source.slice(start, end) === value;
  const pieces: TextPiece[] | null = verbatim
    ? [{ text: value, start, end, exact: true }]
    : source === null
      ? null
      : textPieces(source, start, end, value);
  if (pieces === null) return null;
  const toSource = sourceOffsetsOfRendered(pieces);
  let at = { offset: start, point: span.start };
  const pointAt = (offset: number): Point => {
    // Two edges inside one escape or reference map out of order.
    if (offset < at.offset) at = { offset: start, point: span.start };
    const text =
      source === null
        ? value.slice(at.offset - start, offset - start)
        : source.slice(at.offset, offset);
    at = { offset, point: advance(at.point, text) };
    return at.point;
  };
  return (from, to) => {
    const a = toSource(from, "start");
    const b = toSource(to, "end");
    return a === null || b === null
      ? undefined
      : { start: pointAt(a), end: pointAt(b) };
  };
}

function nodeFor(segment: RefSegment, position: MdNode["position"]): MdNode {
  if (segment.type === "text") {
    return { type: "text", value: segment.value, position };
  }
  // The link's own text stays position-less: IssueLink throws these
  // children away and renders the fetched title in their place, so a
  // decoration painted inside would land on something nobody ever sees.
  const children = [{ type: "text", value: segment.text }];
  return segment.type === "ext"
    ? {
        type: "link",
        url: segment.href,
        title: segment.href,
        children,
        position,
      }
    : { type: "link", url: refHref(segment), children, position };
}
