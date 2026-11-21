import { diffArrays } from "diff";
import { lineAfterDeleting } from "./block-clear-line.ts";
import { canonicalizeLabelName } from "./schemas/project.ts";
import type {
  ChangeRow,
  TemplateBody,
  TemplateStatus,
} from "./schemas/project-template.ts";

/**
 * What applying a template does to a project's order, block clear line and
 * default status, in one place for the server that writes it and the page
 * that draws it beforehand: the two cannot disagree when both read it here,
 * from the same project and template.
 *
 * A subpath of its own, `@todou/shared/template-apply`, kept out of the
 * main entry as `spec-remap` is: it carries jsdiff, which the CLI, loading
 * the main entry only, should not.
 *
 * The rule is the table the page draws. Each status the project has or the
 * template adds is a row of it, laid out once whatever is ticked; a status
 * the project keeps but the template has elsewhere is two rows, where it is
 * and where it goes. The order once applied is the After column read top
 * down, each row's After cell filled or not by what is ticked.
 */

/**
 * A status as an apply leaves it: one the project has by its id, one the
 * template adds by its name there, having no id yet.
 */
export type StatusKey = number | string;

/** What the order rules read of a project's statuses. */
type ProjectStatus = { id: number; name: string };

/** What the order rules read of a project. */
export type ApplyProject = {
  /** In board order. */
  statuses: ReadonlyArray<ProjectStatus & { is_default: boolean }>;
  /** The status the block clear line is on; null when there is no line. */
  line: number | null;
};

/**
 * The project's entries paired with the template's by canonical name, case
 * kept. Where several entries are one name once canonical, the first one
 * pairs and the rest are left over.
 */
export function pairByName<T extends { name: string }>(
  entries: readonly T[],
  names: readonly string[],
): { paired: Map<string, T>; leftover: T[] } {
  const wanted = new Set(names);
  const paired = new Map<string, T>();
  const leftover: T[] = [];
  for (const entry of entries) {
    const key = canonicalizeLabelName(entry.name);
    if (wanted.has(key) && !paired.has(key)) paired.set(key, entry);
    else leftover.push(entry);
  }
  return { paired, leftover };
}

/**
 * The project's statuses paired with the template's: `paired` by the
 * template's name, `extras` the ones the template has no status for, and
 * `keyOf` a template status as the project will know it.
 */
export function pairStatuses<S extends ProjectStatus>(
  statuses: readonly S[],
  template: TemplateBody,
) {
  const { paired, leftover } = pairByName(
    statuses,
    template.statuses.map((s) => s.name),
  );
  const keyOf = (status: TemplateStatus): StatusKey =>
    paired.get(status.name)?.id ?? status.name;
  return { paired, extras: leftover, keyOf };
}

/**
 * Inserts every item of `incoming` that `base` lacks right after the item
 * nearest before it in `incoming` that is already placed, or first when
 * there is none; `base` keeps its order. So a run of new items stays
 * together, and each lands next to what it followed where it came from.
 */
export function mergeOrder<K>(base: readonly K[], incoming: readonly K[]): K[] {
  const result = [...base];
  const placed = new Set(base);
  for (const [index, item] of incoming.entries()) {
    if (placed.has(item)) continue;
    let at = 0;
    for (let before = index - 1; before >= 0; before -= 1) {
      const anchor = incoming[before] as K;
      if (placed.has(anchor)) {
        at = result.indexOf(anchor) + 1;
        break;
      }
    }
    result.splice(at, 0, item);
    placed.add(item);
  }
  return result;
}

/**
 * The statuses both sides have that the template puts elsewhere: those
 * outside the longest run the two orders share. `diffArrays` picks the run
 * where several are as long, so of two neighbours swapped, the upper one
 * moves.
 */
export function statusMovers(
  statuses: readonly ProjectStatus[],
  template: TemplateBody,
): Set<number> {
  const { paired } = pairStatuses(statuses, template);
  const both = new Set([...paired.values()].map((s) => s.id));
  const now = statuses.filter((s) => both.has(s.id)).map((s) => s.id);
  const wanted = template.statuses.flatMap((s) => {
    const status = paired.get(s.name);
    return status === undefined ? [] : [status.id];
  });
  const movers = new Set<number>();
  for (const part of diffArrays(now, wanted)) {
    if (part.removed) for (const id of part.value) movers.add(id);
  }
  return movers;
}

/**
 * One row of the table. A status or the block clear line stands on `both`
 * sides where it stays put; one that moves has a `from` row where it is and
 * a `to` row where it goes; a status the template adds has an `added` row.
 *
 * `tick` is the plan row whose box decides the row's After cell: a move's
 * on both its rows, an addition's, a deletion's on a status's `both` row.
 * The line's two rows carry `status.line` when the plan has that row; a
 * line that moves only because its status does carries that status's move.
 */
export type LayoutRow =
  | {
      kind: "status";
      key: StatusKey;
      place: "both" | "from" | "to" | "added";
      tick: string | null;
    }
  | { kind: "line"; place: "both" | "from" | "to"; tick: string | null };

/** The table's rows, and what the line and the default are on either side. */
export type ApplyLayout = {
  rows: LayoutRow[];
  line: { now: StatusKey | null; template: StatusKey | null };
  default: { now: StatusKey | null; template: StatusKey | null };
};

const LINE = Symbol("line");
type Slot = StatusKey | typeof LINE;

/**
 * The table's rows, whatever is ticked: the project's statuses in its order
 * down the left, and down the right the order with every row of `rows`
 * ticked, the two merged so that what both sides hold in the same place
 * shares a row.
 */
export function applyLayout(
  project: ApplyProject,
  template: TemplateBody,
  rows: readonly ChangeRow[],
): ApplyLayout {
  const has = new Set(rows.map((row) => row.id));
  const tickOf = (id: string) => (has.has(id) ? id : null);
  const { keyOf } = pairStatuses(project.statuses, template);
  const movers = statusMovers(project.statuses, template);
  const templateMark = (mark: "block_clear" | "is_default") => {
    const status = template.statuses.find((s) => s[mark]);
    return status === undefined ? null : keyOf(status);
  };
  const lineRow = tickOf("status.line");
  const lineTemplate = templateMark("block_clear");
  const lineTick =
    lineRow ??
    (project.line !== null && movers.has(project.line)
      ? `status.move:${project.line}`
      : null);

  const left: Slot[] = project.statuses.flatMap((s) =>
    s.id === project.line ? [LINE, s.id] : [s.id],
  );
  const right: Slot[] = mergeOrder<StatusKey>(
    project.statuses.filter((s) => !movers.has(s.id)).map((s) => s.id),
    template.statuses.map(keyOf),
  );
  const lineAt = lineRow === null ? project.line : lineTemplate;
  if (lineAt !== null && right.includes(lineAt)) {
    right.splice(right.indexOf(lineAt), 0, LINE);
  }

  const moving = (slot: Slot) =>
    slot === LINE
      ? lineTick !== null
      : typeof slot === "number" && movers.has(slot);
  const side = (slot: Slot, place: "from" | "to"): LayoutRow =>
    slot === LINE
      ? { kind: "line", place, tick: lineTick }
      : typeof slot === "string"
        ? {
            kind: "status",
            key: slot,
            place: "added",
            tick: `status.add:${slot}`,
          }
        : { kind: "status", key: slot, place, tick: `status.move:${slot}` };

  const out: LayoutRow[] = [];
  let l = 0;
  let r = 0;
  while (l < left.length || r < right.length) {
    const here = left[l];
    const there = right[r];
    if (here !== undefined && moving(here)) {
      out.push(side(here, "from"));
      l += 1;
    } else if (
      there !== undefined &&
      (moving(there) || typeof there === "string")
    ) {
      out.push(side(there, "to"));
      r += 1;
    } else {
      // Whatever neither moves nor is new is on both sides in one order.
      if (here === undefined || here !== there) {
        throw new Error("the two sides of the table do not line up");
      }
      out.push(
        here === LINE
          ? { kind: "line", place: "both", tick: null }
          : {
              kind: "status",
              key: here,
              place: "both",
              tick: tickOf(`status.delete:${here}`),
            },
      );
      l += 1;
      r += 1;
    }
  }
  return {
    rows: out,
    line: { now: project.line, template: lineTemplate },
    default: {
      now: project.statuses.find((s) => s.is_default)?.id ?? null,
      template: templateMark("is_default"),
    },
  };
}

/**
 * A row's After cell: the status `solid`, as it will be; a `shadow` of a
 * status that would be there were its box ticked; or `empty`.
 */
export type AfterCell = "solid" | "shadow" | "empty";

export function afterCell(
  row: LayoutRow,
  selected: ReadonlySet<string>,
): AfterCell {
  const ticked = row.tick !== null && selected.has(row.tick);
  // Where a status or the line is: it leaves when deleted or moved away.
  if (row.place === "both" || row.place === "from") {
    return ticked ? "empty" : "solid";
  }
  // Where one would go: an addition or the end of a move.
  return ticked ? "solid" : "shadow";
}

/** The project once `selected` is applied, as the table reads. */
export type ApplyResult = {
  /** Every status that stays, in board order. */
  order: StatusKey[];
  /** `order` with the deleted statuses still in place. */
  before: StatusKey[];
  line: StatusKey | null;
  lineChanged: boolean;
  default: StatusKey | null;
};

/**
 * The order is the After column top down. The line goes where the template
 * has it once its row is ticked; else it stays on its status, moving down
 * off one that is deleted. The default is the template's once its row is
 * ticked; else it stays, and a deleted default leaves none.
 */
export function applyResult(
  layout: ApplyLayout,
  selected: ReadonlySet<string>,
): ApplyResult {
  const order: StatusKey[] = [];
  const before: StatusKey[] = [];
  const deleted = new Set<StatusKey>();
  for (const row of layout.rows) {
    if (row.kind !== "status") continue;
    const cell = afterCell(row, selected);
    if (cell === "solid") {
      order.push(row.key);
      before.push(row.key);
    } else if (cell === "empty" && row.place === "both") {
      before.push(row.key);
      deleted.add(row.key);
    }
  }
  const line = selected.has("status.line")
    ? layout.line.template
    : lineAfterDeleting(before, layout.line.now, deleted);
  const now = layout.default.now;
  return {
    order,
    before,
    line,
    lineChanged: line !== layout.line.now,
    default: selected.has("status.default")
      ? layout.default.template
      : now !== null && deleted.has(now)
        ? null
        : now,
  };
}
