import { DELETION_LINE_TYPE, LINE_TYPE_ATTR, rowText } from "./pierre-rows.ts";

/**
 * Which line of a ```diff / ```patch fence one of the patch viewer's rows
 * shows. The viewer numbers a diff row by the patched file's lines, not the
 * fence's, and leaves no mark in the DOM of which file or commit an item
 * belongs to — and it is virtualized, so counting items is no way to tell
 * either. What a row does carry is its kind, its number and its text, and a
 * patch line is pinned down by all three; so the fence is parsed here the way
 * the viewer parsed it, and a row is looked up by content.
 */

type HunkLine = {
  kind: "context" | "deletion" | "addition";
  /** The patched file's old-side line; set for context and deletions. */
  old: number | null;
  /** Its new-side line; set for context and additions. */
  new: number | null;
  /** The line without its one-character prefix. */
  text: string;
  /** 0-based line of the fence body. */
  index: number;
};

type ParsedFence = {
  lines: string[];
  /**
   * Hunk lines by kind and the number the viewer gives them (`placeOf`), so
   * each row is one lookup: a highlight pass places every row of a patch.
   */
  hunkLines: Map<string, HunkLine[]>;
  /**
   * Fence lines outside every file section, where a commit message lives,
   * by their trimmed text.
   */
  outside: Map<string, number[]>;
};

/** A hunk line's kind and the side's number a row of that kind shows. */
function placeOf(kind: HunkLine["kind"], number: number): string {
  return `${kind}:${number}`;
}

/** `map[key]`, grown by `value`. */
function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Extended header lines git writes between `diff --git` and the hunks. */
const FILE_HEADER =
  /^(index |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch|--- |\+\+\+ )/;

function parse(value: string): ParsedFence {
  const lines = value.split("\n");
  const hunkLines: HunkLine[] = [];
  const inFile = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("diff --git ")) {
      inFile[i++] = true;
      while (i < lines.length && FILE_HEADER.test(lines[i] ?? "")) {
        inFile[i++] = true;
      }
      continue;
    }
    // A plain unified diff has no `diff --git` line, only its own `---` and
    // `+++` pair right above the first hunk.
    if (
      line.startsWith("--- ") &&
      lines[i + 1]?.startsWith("+++ ") === true &&
      HUNK_HEADER.test(lines[i + 2] ?? "")
    ) {
      inFile[i++] = true;
      inFile[i++] = true;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header === null) {
      i++;
      continue;
    }
    inFile[i++] = true;
    let old = Number(header[1]);
    let neu = Number(header[3]);
    // An omitted count is 1. The counts, not the look of the next line, are
    // what ends a hunk: `git format-patch` signs off with `-- `, which would
    // otherwise read as one more deletion.
    let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    let newLeft = header[4] === undefined ? 1 : Number(header[4]);
    while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const body = lines[i] ?? "";
      const prefix = body[0];
      if (prefix === "\\") {
        // `\ No newline at end of file` belongs to the line above it.
        inFile[i++] = true;
        continue;
      }
      // An empty line is context whose leading space was stripped on the way.
      if ((prefix === " " || body === "") && oldLeft > 0 && newLeft > 0) {
        hunkLines.push({
          kind: "context",
          old,
          new: neu,
          text: body.slice(1),
          index: i,
        });
        old++;
        neu++;
        oldLeft--;
        newLeft--;
      } else if (prefix === "-" && oldLeft > 0) {
        hunkLines.push({
          kind: "deletion",
          old,
          new: null,
          text: body.slice(1),
          index: i,
        });
        old++;
        oldLeft--;
      } else if (prefix === "+" && newLeft > 0) {
        hunkLines.push({
          kind: "addition",
          old: null,
          new: neu,
          text: body.slice(1),
          index: i,
        });
        neu++;
        newLeft--;
      } else {
        // Counts that do not add up: what follows is no longer this hunk.
        break;
      }
      inFile[i++] = true;
    }
    while (i < lines.length && (lines[i] ?? "").startsWith("\\")) {
      inFile[i++] = true;
    }
  }
  const byPlace = new Map<string, HunkLine[]>();
  for (const line of hunkLines) {
    // A deletion numbers itself on the old side, everything else on the new.
    const number = line.kind === "deletion" ? line.old : line.new;
    if (number !== null) push(byPlace, placeOf(line.kind, number), line);
  }
  const outside = new Map<string, number[]>();
  inFile.forEach((file, index) => {
    if (!file) push(outside, (lines[index] ?? "").trim(), index);
  });
  return { lines, hunkLines: byPlace, outside };
}

/** Parsed fences by body; a page holds a handful, a session not many more. */
const PARSED = new Map<string, ParsedFence>();
const PARSED_LIMIT = 32;

function parsedFence(value: string): ParsedFence {
  const cached = PARSED.get(value);
  if (cached !== undefined) return cached;
  const parsed = parse(value);
  if (PARSED.size >= PARSED_LIMIT) {
    const oldest = PARSED.keys().next().value;
    if (oldest !== undefined) PARSED.delete(oldest);
  }
  PARSED.set(value, parsed);
  return parsed;
}

/** The one index in `hits`, or null for none or several: never a guess. */
function only(hits: number[]): number | null {
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * The 0-based fence line `row` shows, or null when no single line can be
 * named. The `pre` a row sits in says which of the viewer's three drawings it
 * belongs to: a file's diff, a commit's message, or the text as written.
 */
export function patchLineOfRow(value: string, row: Element): number | null {
  const pre = row.closest("pre");
  if (pre === null) return null;
  const number = Number(row.getAttribute("data-line"));
  if (!Number.isInteger(number)) return null;
  const text = rowText(row);
  const parsed = parsedFence(value);
  if (pre.hasAttribute("data-diff")) {
    const type = row.getAttribute(LINE_TYPE_ATTR);
    const kind =
      type === DELETION_LINE_TYPE
        ? "deletion"
        : type === "change-addition"
          ? "addition"
          : type === "context" || type === "context-expanded"
            ? "context"
            : null;
    if (kind === null) return null;
    return only(
      (parsed.hunkLines.get(placeOf(kind, number)) ?? [])
        .filter((line) => line.text === text)
        .map((line) => line.index),
    );
  }
  if (!pre.hasAttribute("data-file")) return null;
  // The raw view and the not-a-patch fallback draw the fence as written,
  // without line numbers; `data-line` still counts its lines.
  if (pre.hasAttribute("data-disable-line-numbers")) {
    const index = number - 1;
    return parsed.lines[index] === text ? index : null;
  }
  // A commit message: shown without the indent `git show` gives it, and
  // searched across every commit's, so a line two commits share — a
  // sign-off, a blank — names no single one of them.
  return only(
    (parsed.outside.get(text.trim()) ?? []).filter((index) => {
      const line = parsed.lines[index] ?? "";
      return (
        line.endsWith(text) &&
        line.slice(0, line.length - text.length).trim() === ""
      );
    }),
  );
}
