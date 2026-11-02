import type { AnchorRange } from "@/components/spec/selection-entry.tsx";
import type { CodeHighlightRanges } from "@/lib/code-highlights.ts";
import {
  DELETION_LINE_TYPE,
  LINE_TYPE_ATTR,
  offsetInRow,
  rangeInRow,
  rowAt,
  rowText,
} from "@/lib/pierre-rows.ts";
import {
  composedContains,
  elementNear,
  type SelectionEndpoints,
} from "@/lib/selection-endpoints.ts";
import { columnsOfOffsets, lineStartsOf } from "@/lib/spec-source-index.ts";

/** One version of a file as the source view draws it. */
export type SourceSide = { path: string; version: number; body: string };

/**
 * The file a pierre surface draws: the viewed version, and in a diff the
 * baseline its deletion rows belong to.
 */
export type SourceFiles = { current: SourceSide; old?: SourceSide };

/** An anchor in the source view, with the file version it belongs to. */
export type SourceAnchor = AnchorRange & { path: string; version: number };

type End = {
  row: Element;
  files: SourceFiles;
  side: SourceSide;
  deletion: boolean;
  /** 1-based line in `side.body`. */
  line: number;
  /** Absolute offset in `side.body`; null when the row does not read as it. */
  offset: number | null;
};

/** The line text `body` has on 1-based `line`, without its newline. */
function lineOf(
  body: string,
  starts: number[],
  line: number,
): { start: number; text: string } | null {
  const start = starts[line - 1];
  if (start === undefined) return null;
  const next = starts[line];
  return {
    start,
    text: body.slice(start, next === undefined ? body.length : next - 1),
  };
}

/** A row's start or end, as a boundary point on the row itself. */
function edgeOf(
  row: Element,
  role: "start" | "end",
): { row: Element; node: Node; offset: number } {
  return { row, node: row, offset: role === "end" ? row.childNodes.length : 0 };
}

/**
 * The row an endpoint off every row stands for, when it is still inside one
 * file's pierre surface: on the number gutter, on an annotation hung under a
 * line, on a separator, past the last row. A selection's end steps back to
 * the end of the row before it, its start forward to the start of the row
 * after it — what a triple-click on a line with a note under it, or a drag
 * let go on the note, meant. Outside a surface (a file header, another
 * file) there is no row to stand for.
 */
function clampToRow(
  node: Node,
  offset: number,
  role: "start" | "end",
): { row: Element; node: Node; offset: number } | null {
  let at: Node = node;
  let atOffset = offset;
  let root = node.getRootNode();
  if (!(root instanceof ShadowRoot)) {
    // An annotation is light DOM, slotted into the host; where it shows is
    // where its slot sits among the rows.
    const host = elementNear(node)?.closest("diffs-container");
    if (host?.shadowRoot == null) return null;
    let child = elementNear(node);
    while (child !== null && child.parentElement !== host) {
      child = child.parentElement;
    }
    const slot = child?.assignedSlot ?? null;
    if (slot === null) return null;
    at = slot;
    atOffset = 0;
    root = host.shadowRoot;
  }
  const rows = [...(root as ShadowRoot).querySelectorAll("[data-line]")];
  // The number gutter is a column of its own, ahead of every row in the
  // DOM; a number stands for the row with its line index.
  const number = elementNear(at)?.closest("[data-column-number]");
  if (number != null) {
    const index = number.getAttribute("data-line-index");
    if (index === null) return null;
    const row = rows.find((r) => r.getAttribute("data-line-index") === index);
    return row === undefined ? null : edgeOf(row, role);
  }
  // Against a row's own boundary rather than its whole span: a point just
  // past the last row sits on that row's end, which a span counts as inside.
  const span = (root.ownerDocument ?? document).createRange();
  const versus = (row: Element, edge: "before" | "after") => {
    if (edge === "before") span.setStartBefore(row);
    else span.setStartAfter(row);
    span.collapse(true);
    return span.comparePoint(at, atOffset);
  };
  try {
    const row =
      role === "end"
        ? rows.findLast((r) => versus(r, "after") >= 0)
        : rows.find((r) => versus(r, "before") <= 0);
    return row === undefined ? null : edgeOf(row, role);
  } catch {
    return null;
  }
}

function resolveEnd(
  container: Element,
  point: { node: Node; offset: number },
  role: "start" | "end",
  filesAt: (element: Element) => SourceFiles | null,
): End | null {
  if (!composedContains(container, point.node)) return null;
  // Only a line row has a source line; an end anywhere else in the file
  // stands for the row nearest it on the selection's side.
  const onRow = rowAt(point.node);
  const at =
    onRow === null
      ? clampToRow(point.node, point.offset, role)
      : { row: onRow, node: point.node, offset: point.offset };
  if (at === null) return null;
  const { row, node, offset } = at;
  const root = row.getRootNode();
  const files = filesAt(root instanceof ShadowRoot ? root.host : row);
  if (files === null) return null;
  const deletion = row.getAttribute(LINE_TYPE_ATTR) === DELETION_LINE_TYPE;
  const side = deletion ? files.old : files.current;
  if (side === undefined) return null;
  const line = Number(row.getAttribute("data-line"));
  if (!Number.isInteger(line) || line < 1) return null;
  const source = lineOf(side.body, lineStartsOf(side.body), line);
  // The row is that line exactly or it says nothing about columns: a row
  // that reads otherwise keeps its line and gives up its offset.
  const inRow =
    source !== null && rowText(row) === source.text
      ? offsetInRow(row, node, offset)
      : null;
  return {
    row,
    files,
    side,
    deletion,
    line,
    offset: source === null || inRow === null ? null : source.start + inRow,
  };
}

/** Lines of the rows from `a` to `b` that are not deletions, or null. */
function newLinesBetween(
  a: Element,
  b: Element,
): { start: number; end: number } | null {
  const root = a.getRootNode();
  if (root !== b.getRootNode()) return null;
  const rows = [...(root as ParentNode).querySelectorAll("[data-line]")];
  const i = rows.indexOf(a);
  const j = rows.indexOf(b);
  if (i < 0 || j < 0) return null;
  let start: number | null = null;
  let end: number | null = null;
  for (const row of rows.slice(Math.min(i, j), Math.max(i, j) + 1)) {
    if (row.getAttribute(LINE_TYPE_ATTR) === DELETION_LINE_TYPE) continue;
    const line = Number(row.getAttribute("data-line"));
    if (!Number.isInteger(line)) continue;
    start = start === null ? line : Math.min(start, line);
    end = end === null ? line : Math.max(end, line);
  }
  return start === null || end === null ? null : { start, end };
}

/**
 * The anchor a selection in the source view points at, or null when its ends
 * do not both fall in one file's pierre surface. An end off every row stands
 * for the nearest row (`clampToRow`). `filesAt` names the file whose surface
 * an element belongs to.
 *
 * Both ends on one side of the file: columns when each end's row reads as
 * its source line, whole lines otherwise. A drag from deleted rows into kept
 * or added ones has no one version to cut columns from, so it anchors the
 * viewed version's lines it covers, and nothing when it covers none.
 */
export function sourceAnchorForSelection(
  container: Element,
  ends: SelectionEndpoints,
  filesAt: (element: Element) => SourceFiles | null,
): SourceAnchor | null {
  // The composed range is in document order, so its start is the start.
  const a = resolveEnd(container, ends.start, "start", filesAt);
  const b = resolveEnd(container, ends.end, "end", filesAt);
  if (a === null || b === null) return null;
  if (
    a.files.current.path !== b.files.current.path ||
    a.files.current.version !== b.files.current.version
  ) {
    return null;
  }
  // Ends that stood for rows on either side of what they sat in, crossing
  // over: the selection lies wholly inside a note or a separator and covers
  // no row at all.
  if (a.row !== b.row && a.row.getRootNode() === b.row.getRootNode()) {
    const rows = [
      ...(a.row.getRootNode() as ParentNode).querySelectorAll("[data-line]"),
    ];
    if (rows.indexOf(a.row) > rows.indexOf(b.row)) return null;
  }
  if (a.deletion !== b.deletion) {
    const lines = newLinesBetween(a.row, b.row);
    if (lines === null) return null;
    const { path, version } = a.files.current;
    return {
      path,
      version,
      lineStart: lines.start,
      lineEnd: lines.end,
      colStart: null,
      colEnd: null,
    };
  }
  const { path, version, body } = a.side;
  if (a.offset !== null && b.offset !== null) {
    const columns = columnsOfOffsets(
      { source: body, lineStarts: lineStartsOf(body) },
      Math.min(a.offset, b.offset),
      Math.max(a.offset, b.offset),
    );
    if (columns !== null) return { path, version, ...columns };
  }
  return {
    path,
    version,
    lineStart: Math.min(a.line, b.line),
    lineEnd: Math.max(a.line, b.line),
    colStart: null,
    colEnd: null,
  };
}

/** A comment or draft anchored to columns of one version of a file. */
export type SourceMark = {
  kind: "comment" | "draft";
  path: string;
  version: number;
  lineStart: number;
  lineEnd: number;
  colStart: number;
  colEnd: number;
};

/**
 * Every line row under `container`: those pierre draws in its hosts' shadow
 * roots, and any drawn in the light DOM. Hosts only, rather than every open
 * shadow root below: the source diff holds the whole stack, and each of its
 * rows carries a span per token that a search for nested roots would visit.
 */
function rowsUnder(container: Element): Element[] {
  const roots: ParentNode[] = [container];
  for (const host of container.querySelectorAll("diffs-container")) {
    if (host.shadowRoot !== null) roots.push(host.shadowRoot);
  }
  return roots.flatMap((root) => [...root.querySelectorAll("[data-line]")]);
}

/**
 * The versions a row shows, each with the line it is there: a deletion the
 * baseline's, an addition the viewed version's, and an unchanged row both —
 * pierre numbers it on the viewed side and keeps the baseline's number as
 * `data-alt-line`, and a baseline annotation hangs under it by that number.
 * A row of a whole file has no alt line; its two sides read the same.
 */
function placesOf(
  row: Element,
  files: SourceFiles,
): Array<{ side: SourceSide; line: number }> {
  const line = Number(row.getAttribute("data-line"));
  const type = row.getAttribute(LINE_TYPE_ATTR);
  const alt = Number(row.getAttribute("data-alt-line") ?? line);
  const places =
    type === DELETION_LINE_TYPE
      ? [{ side: files.old, line }]
      : type === "change-addition"
        ? [{ side: files.current, line }]
        : [
            { side: files.current, line },
            { side: files.old, line: alt },
          ];
  return places.filter(
    (place): place is { side: SourceSide; line: number } =>
      place.side !== undefined && Number.isInteger(place.line),
  );
}

/**
 * The ranges that paint `marks` over the rows of the files `filesAt` names:
 * on each row of the version a mark is anchored to, within its lines, the
 * columns it covers on that line. A row that does not read as its source line
 * is left unpainted rather than painted somewhere near.
 */
export function sourceHighlightRanges(
  container: Element,
  filesAt: (element: Element) => SourceFiles | null,
  marks: SourceMark[],
): CodeHighlightRanges {
  const ranges: CodeHighlightRanges = { comment: [], draft: [] };
  if (marks.length === 0) return ranges;
  const starts = new Map<string, number[]>();
  // Every row of one host names the same file.
  const filesByHost = new Map<Element, SourceFiles | null>();
  for (const row of rowsUnder(container)) {
    const root = row.getRootNode();
    const host = root instanceof ShadowRoot ? root.host : row;
    let files = filesByHost.get(host);
    if (files === undefined) {
      files = filesAt(host);
      filesByHost.set(host, files);
    }
    if (files === null) continue;
    for (const { side, line } of placesOf(row, files)) {
      const here = marks.filter(
        (mark) =>
          mark.path === side.path &&
          mark.version === side.version &&
          mark.lineStart <= line &&
          line <= mark.lineEnd,
      );
      if (here.length === 0) continue;
      let lineStarts = starts.get(side.body);
      if (lineStarts === undefined) {
        lineStarts = lineStartsOf(side.body);
        starts.set(side.body, lineStarts);
      }
      const source = lineOf(side.body, lineStarts, line);
      if (source === null || rowText(row) !== source.text) continue;
      for (const mark of here) {
        const range = rangeInRow(
          row,
          line === mark.lineStart ? mark.colStart - 1 : 0,
          line === mark.lineEnd ? mark.colEnd : source.text.length,
        );
        if (range !== null)
          (mark.kind === "comment" ? ranges.comment : ranges.draft).push(range);
      }
    }
  }
  return ranges;
}
