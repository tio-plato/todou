import type { ChangeRow, Label, Role, TemplateApplyPlan } from "@todou/shared";
import {
  type ApplyResult,
  afterCell,
  applyLayout,
  applyResult,
  pairStatuses,
  type StatusKey,
} from "@todou/shared/template-apply";
import { groupLabelsByPrefix, splitLabelName } from "@/lib/labels.ts";

/**
 * The table of a project before and after a template is applied, as data:
 * which rows it has, what each side of a row holds, where the boxes and the
 * arrows go. The rows and what each After cell holds come from the shared
 * rules the apply itself follows; this module only decides how they look.
 *
 * Everything here reads the plan's own snapshot of the project and its
 * template, never another read: the table is what the apply will work from.
 */

export type Action = ChangeRow["action"];

type Category = "open" | "closed";

/** How a status or label is drawn in its cell. */
export type Look = "solid" | "shadow" | "struck";

/** A status as one side of the table draws it. */
export type StatusFace = {
  name: string;
  color: string;
  category: Category;
  role: Role;
  isDefault: boolean;
  /** The default here only once applied. */
  defaultNew: boolean;
  /**
   * The category and chart role written out in full, as on a row whose
   * meaning the template changes, each flagged where it differs from the
   * Before side; null where the row says what a status list says.
   */
  meaning: { category: boolean; role: boolean } | null;
  look: Look;
};

export type StatusTableRow = {
  kind: "status";
  /** Unique among the rows: a moving status has two. */
  key: string;
  status: StatusKey;
  before: StatusFace | null;
  after: StatusFace | null;
  /**
   * The After side's line drawn along the top of this row: where no line
   * row sits right above the status the line ends up on.
   */
  lineAbove: boolean;
  /** The boxes in the middle, an arrow's last: the arrow runs through it. */
  ticks: ChangeRow[];
  tint: Action | null;
};

export type LineTableRow = {
  kind: "line";
  key: string;
  before: boolean;
  /** `solid` where the line ends up; a `shadow` where it would go. */
  after: "solid" | "shadow" | null;
  ticks: ChangeRow[];
};

export type TableRow = StatusTableRow | LineTableRow;

/**
 * A line from a row's Before side to another's After side: a status or the
 * block clear line moving, or the default passing to another status.
 */
export type TableArrow = {
  kind: "move" | "default";
  from: number;
  to: number;
  /** The box on it, in the `to` row; none for a line following its status. */
  tick: string | null;
  /** Drawn where it points: dashed until then. */
  ticked: boolean;
  /**
   * Its box ticked, which lights it; for one with no box of its own, a line
   * following its status, drawn where it points.
   */
  on: boolean;
  start: "status" | "line" | "default";
  end: "status" | "line";
  /**
   * Of a status's move, the status it goes in below once everything is
   * ticked; null for the top.
   */
  below?: string | null;
  /** Which vertical lane of the middle column it runs down, from the left. */
  lane: number;
};

export type StatusTable = {
  rows: TableRow[];
  arrows: TableArrow[];
  lanes: number;
  /** The project once applied: what Apply sends as drawn. */
  result: ApplyResult;
};

type Plan = Pick<TemplateApplyPlan, "project" | "template">;

/** Of each arrow, the lowest lane free over all the rows it spans. */
function laneArrows(arrows: Omit<TableArrow, "lane">[]): TableArrow[] {
  const ends: number[] = [];
  const span = (a: { from: number; to: number }) =>
    [Math.min(a.from, a.to), Math.max(a.from, a.to)] as const;
  return [...arrows]
    .sort((a, b) => span(a)[0] - span(b)[0])
    .map((arrow) => {
      const [top, bottom] = span(arrow);
      // Rows are shared at the ends too: an arrow ending in a row and one
      // starting in it would meet at the corner.
      let lane = ends.findIndex((end) => end < top);
      if (lane < 0) lane = ends.length;
      ends[lane] = bottom;
      return { ...arrow, lane };
    });
}

export function statusTable(
  plan: Plan,
  rows: readonly ChangeRow[],
  selected: ReadonlySet<string>,
): StatusTable {
  const { project, template } = plan;
  const layout = applyLayout(project, template, rows);
  const result = applyResult(layout, selected);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const on = (id: string | null) => id !== null && selected.has(id);
  const statusOf = new Map(project.statuses.map((s) => [s.id, s]));
  const { keyOf } = pairStatuses(project.statuses, template);
  const templateOf = new Map(template.statuses.map((s) => [keyOf(s), s]));

  const table: TableRow[] = layout.rows.map((row, index) => {
    const key = `${row.kind}:${row.kind === "line" ? "" : row.key}:${row.place}:${index}`;
    if (row.kind === "line") {
      return {
        kind: "line",
        key,
        before: row.place !== "to",
        // Where the line would go; the walk below finds where it does.
        after: row.place === "to" ? "shadow" : null,
        ticks: [],
      };
    }
    const current = typeof row.key === "number" && statusOf.get(row.key);
    const target = templateOf.get(row.key);
    const recolour = byId.get(`status.recolour:${row.key}`);
    const change = byId.get(`status.change:${row.key}`);
    const changed = change?.type === "status_change" && on(change.id);
    const cell = afterCell(row, selected);
    let before: StatusFace | null = null;
    let after: StatusFace | null = null;
    if (current) {
      const face = {
        name: current.name,
        color: current.color,
        category: current.category,
        role: current.role,
      };
      if (row.place === "both" || row.place === "from") {
        before = {
          ...face,
          isDefault: current.is_default,
          defaultNew: false,
          meaning: change ? { category: false, role: false } : null,
          look: row.place === "both" && on(row.tick) ? "struck" : "solid",
        };
      }
      if (cell !== "empty") {
        const category = changed && target ? target.category : face.category;
        const role = changed && target ? target.chart_role : face.role;
        after = {
          ...face,
          color:
            recolour?.type === "status_recolour" && on(recolour.id)
              ? recolour.to
              : face.color,
          category,
          role,
          isDefault: cell === "solid" && result.default === row.key,
          defaultNew:
            cell === "solid" &&
            result.default === row.key &&
            layout.default.now !== row.key,
          meaning: change
            ? {
                category: category !== face.category,
                role: role !== face.role,
              }
            : null,
          look: cell,
        };
      }
    } else if (target && cell !== "empty") {
      after = {
        name: target.name,
        color: target.color,
        category: target.category,
        role: target.chart_role,
        isDefault: cell === "solid" && result.default === row.key,
        defaultNew: cell === "solid" && result.default === row.key,
        meaning: null,
        look: cell,
      };
    }
    const own =
      row.place === "to" || row.place === "added"
        ? [byId.get(row.tick ?? "")]
        : [
            recolour,
            change,
            row.place === "both" ? byId.get(row.tick ?? "") : undefined,
          ];
    const ticks = own.filter((tick) => tick !== undefined);
    // A move is drawn by its arrow alone; a row that recolours and changes
    // what the status means takes the meaning's colour. Only a row holding
    // the box is tinted, not the status's other row.
    const tint: Action | null = ticks.some(
      (tick) => tick.type === "status_change" && on(tick.id),
    )
      ? "change"
      : ((["recolour", "add", "delete"] as const).find((action) =>
          ticks.some((tick) => tick.action === action && on(tick.id)),
        ) ?? null);
    return {
      kind: "status",
      key,
      status: row.key,
      before,
      after,
      lineAbove: false,
      ticks,
      tint,
    };
  });

  // The After side's line, right above the row of the status it ends up on:
  // in the nearest line row up from there that holds the line, over rows
  // empty or only shadows on that side; else along that row's own top.
  const lineAt = layout.rows.findIndex(
    (row) =>
      row.kind === "status" &&
      row.key === result.line &&
      afterCell(row, selected) === "solid",
  );
  if (lineAt >= 0) {
    let up = lineAt - 1;
    for (; up >= 0; up -= 1) {
      const row = layout.rows[up];
      if (row === undefined) break;
      const cell = afterCell(row, selected);
      if (row.kind === "line" && cell === "solid") break;
      if (cell === "solid") {
        up = -1;
        break;
      }
    }
    const holder = table[up < 0 ? lineAt : up];
    if (holder?.kind === "line") holder.after = "solid";
    else if (holder?.kind === "status") holder.lineAbove = true;
  }

  const arrows: Omit<TableArrow, "lane">[] = [];
  const rowsOf = (key: StatusKey) =>
    layout.rows.flatMap((row, index) =>
      row.kind === "status" && row.key === key ? [{ row, index }] : [],
    );
  const nameOf = (key: StatusKey) =>
    typeof key === "string" ? key : (statusOf.get(key)?.name ?? "");
  // Each move, its box where the status goes.
  for (const status of project.statuses) {
    const ends = rowsOf(status.id);
    const from = ends.find((end) => end.row.place === "from");
    const to = ends.find((end) => end.row.place === "to");
    if (from === undefined || to === undefined) continue;
    const above = layout.rows
      .slice(0, to.index)
      .findLast((row) => row.kind === "status" && row.place !== "from");
    arrows.push({
      kind: "move",
      from: from.index,
      to: to.index,
      tick: to.row.tick,
      ticked: on(to.row.tick),
      on: on(to.row.tick),
      start: "status",
      end: "status",
      below: above?.kind === "status" ? nameOf(above.key) : null,
    });
  }
  // The line's: a box of its own only when the template moves it.
  const lineRows = layout.rows.flatMap((row, index) =>
    row.kind === "line" && row.place !== "both" ? [{ row, index }] : [],
  );
  const lineTick = byId.get("status.line");
  if (lineTick !== undefined) {
    const holder =
      lineRows.find((end) => end.row.place === "to") ?? lineRows[0];
    if (holder) table[holder.index]?.ticks.push(lineTick);
  }
  const lineFrom = lineRows.find((end) => end.row.place === "from");
  const lineTo = lineRows.find((end) => end.row.place === "to");
  if (lineFrom && lineTo) {
    // Solid once the line is drawn where it points: a line ticked onto a
    // status whose own move is not ticked is drawn above that status where
    // it stays, and the arrow is left pointing where it would go.
    const to = table[lineTo.index];
    const drawn = to?.kind === "line" && to.after === "solid";
    arrows.push({
      kind: "move",
      from: lineFrom.index,
      to: lineTo.index,
      tick: lineTick === undefined ? null : lineTick.id,
      ticked: drawn,
      on: lineTick === undefined ? drawn : on(lineTick.id),
      start: "line",
      end: "line",
    });
  }
  // The default's: from the status that has it to the one the template
  // gives it, its box where that one goes once everything is ticked, so
  // that it stays put whatever else is; with either side missing, a box in
  // the row of the side there is.
  const defaultTick = byId.get("status.default");
  if (defaultTick !== undefined) {
    const now = layout.default.now;
    const next = layout.default.template;
    const from =
      now === null
        ? undefined
        : rowsOf(now).find((end) => end.row.place !== "to");
    const candidates = next === null ? [] : rowsOf(next);
    const to =
      candidates.find(
        (end) => end.row.place === "to" || end.row.place === "added",
      ) ?? candidates[0];
    const holder = to ?? from;
    // Before the row's own boxes: an arrow runs through its box last.
    if (holder) table[holder.index]?.ticks.unshift(defaultTick);
    if (from && to) {
      // Solid once the default is drawn where it points, as the line's.
      const target = table[to.index];
      arrows.push({
        kind: "default",
        from: from.index,
        to: to.index,
        tick: defaultTick.id,
        ticked: target?.kind === "status" && target.after?.isDefault === true,
        on: on(defaultTick.id),
        start: "default",
        end: "status",
      });
    }
  }
  // An arrow's box goes last in its row, where the arrow ends.
  for (const arrow of arrows) {
    const ticks = table[arrow.to]?.ticks;
    const at = ticks?.findIndex((tick) => tick.id === arrow.tick) ?? -1;
    if (ticks && at >= 0) ticks.push(...ticks.splice(at, 1));
  }

  const laned = laneArrows(arrows);
  return {
    rows: table,
    arrows: laned,
    lanes: laned.reduce((most, arrow) => Math.max(most, arrow.lane + 1), 0),
    result,
  };
}

/**
 * One side of a label row: the labels as the label list draws them, ids
 * only telling them apart, in one look.
 */
export type LabelSide = { labels: Label[]; look: Look };

export type LabelTableRow = {
  key: string;
  before: LabelSide | null;
  after: LabelSide | null;
  ticks: ChangeRow[];
  tint: Action | null;
  /**
   * A prefix the project has no label under and the template adds several
   * under: one row for them all, its box ticking each, `members` one row
   * apiece for ticking them one by one.
   */
  group?: {
    prefix: string;
    ids: string[];
    checked: boolean;
    indeterminate: boolean;
    members: LabelTableRow[];
  };
};

/** A label a row names, as the label list takes it; `index` tells it apart. */
export const labelOf = (
  label: { name: string; color: string },
  index: number,
): Label => ({ id: index + 1, name: label.name, color: label.color });

const side = (
  labels: ReadonlyArray<{ name: string; color: string }>,
  look: Look,
): LabelSide => ({ labels: labels.map(labelOf), look });

/**
 * The labels, by name: one row for each the template adds, recolours or
 * would delete, the labels left as they are one row to a prefix, those
 * without a prefix together last.
 */
export function labelTable(
  plan: Plan,
  rows: readonly ChangeRow[],
  selected: ReadonlySet<string>,
): LabelTableRow[] {
  const on = (id: string) => selected.has(id);
  const touched = new Set<number>();
  const single: Array<{ sort: string; row: LabelTableRow }> = [];
  const adds: Extract<ChangeRow, { type: "label_add" }>[] = [];
  for (const row of rows) {
    if (row.type === "label_add") {
      adds.push(row);
    } else if (row.type === "label_change") {
      touched.add(Number(row.id.slice("label.change:".length)));
      const ticked = on(row.id);
      single.push({
        sort: row.name,
        row: {
          key: row.id,
          before: side([{ name: row.name, color: row.from }], "solid"),
          after: side(
            [{ name: row.name, color: ticked ? row.to : row.from }],
            "solid",
          ),
          ticks: [row],
          tint: ticked ? "recolour" : null,
        },
      });
    } else if (row.type === "label_delete") {
      touched.add(Number(row.id.slice("label.delete:".length)));
      const ticked = on(row.id);
      single.push({
        sort: row.name,
        row: {
          key: row.id,
          before: side([row], ticked ? "struck" : "solid"),
          after: ticked ? null : side([row], "solid"),
          ticks: [row],
          tint: ticked ? "delete" : null,
        },
      });
    }
  }

  const addRow = (row: (typeof adds)[number]): LabelTableRow => ({
    key: row.id,
    before: null,
    after: side([row], on(row.id) ? "solid" : "shadow"),
    ticks: [row],
    tint: on(row.id) ? "add" : null,
  });
  const prefixes = new Set(
    plan.project.labels.map((label) => splitLabelName(label.name).prefix),
  );
  const byPrefix = new Map<string, typeof adds>();
  for (const row of adds) {
    const { prefix } = splitLabelName(row.name);
    if (prefix === null || prefixes.has(prefix)) {
      single.push({ sort: row.name, row: addRow(row) });
    } else {
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), row]);
    }
  }
  for (const [prefix, members] of byPrefix) {
    const sorted = members.sort((a, b) => compare(a.name, b.name));
    const [first] = sorted;
    if (first === undefined) continue;
    if (sorted.length === 1) {
      single.push({ sort: first.name, row: addRow(first) });
      continue;
    }
    const ids = sorted.map((row) => row.id);
    const ticked = ids.filter(on).length;
    single.push({
      sort: first.name,
      row: {
        key: `label.group:${prefix}`,
        before: null,
        // Drawn as it is: which of them are left out shows once unfolded.
        after: side(sorted, ticked > 0 ? "solid" : "shadow"),
        ticks: [],
        tint: ticked > 0 ? "add" : null,
        group: {
          prefix,
          ids,
          checked: ticked === ids.length,
          indeterminate: ticked > 0 && ticked < ids.length,
          members: sorted.map(addRow),
        },
      },
    });
  }

  const kept = plan.project.labels
    .filter((label) => !touched.has(label.id))
    .sort((a, b) => compare(a.name, b.name));
  const { groups, plain } = groupLabelsByPrefix(kept);
  const keptRow = (key: string, labels: typeof kept): LabelTableRow => ({
    key,
    before: side(labels, "solid"),
    after: side(labels, "solid"),
    ticks: [],
    tint: null,
  });
  for (const group of groups) {
    single.push({
      sort: group.labels[0]?.name ?? group.prefix,
      row: keptRow(`label.kept:${group.prefix}`, group.labels),
    });
  }
  const out = single
    .sort((a, b) => compare(a.sort, b.sort))
    .map((entry) => entry.row);
  if (plain.length > 0) out.push(keptRow("label.kept", plain));
  return out;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
