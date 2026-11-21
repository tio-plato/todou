import type {
  ChangeRow,
  StatusKey,
  TemplateApplyPlan,
  TemplateStatus,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  labelTable,
  type StatusTable,
  statusTable,
} from "../src/lib/template-apply-table.ts";

type Plan = Pick<TemplateApplyPlan, "project" | "template">;

const st = (
  name: string,
  category: "open" | "closed",
  color: string,
  chart_role: TemplateStatus["chart_role"],
  marks: Partial<Pick<TemplateStatus, "is_default" | "block_clear">> = {},
): TemplateStatus => ({ name, category, color, chart_role, ...marks });

/** The seed script's Patch flow template. */
const PATCH_FLOW: Plan["template"] = {
  statuses: [
    st("Backlog", "open", "#9ca3af", "remaining"),
    st("Todo", "open", "#6b7280", "remaining", { is_default: true }),
    st("Next", "open", "#06b6d4", "remaining"),
    st("In Progress", "open", "#3b82f6", "remaining"),
    st("Ready to Ship", "open", "#f59e0b", "remaining"),
    st("Shipped", "open", "#8b5cf6", "completed", { block_clear: true }),
    st("Patch Series", "open", "#ec4899", "remaining"),
    st("Email Sent", "open", "#14b8a6", "completed"),
    st("Done", "closed", "#22c55e", "completed"),
    st("Discard", "closed", "#64748b", "excluded"),
  ],
  labels: [
    ["area:cli", "#22c55e"],
    ["area:docs", "#ef4444"],
    ["area:infra", "#22c55e"],
    ["area:server", "#ef4444"],
    ["area:shared", "#eab308"],
    ["area:web", "#ec4899"],
    ["kind:bug", "#ef4444"],
    ["kind:chore", "#22c55e"],
    ["kind:feature", "#0ea5e9"],
    ["needs-brainstorm", "#eab308"],
    ["urgent", "#ef4444"],
  ].map(([name, color]) => ({ name: name as string, color: color as string })),
};

const S = {
  backlog: 1,
  todo: 2,
  next: 3,
  inProgress: 4,
  ready: 5,
  shipped: 6,
  done: 7,
  discard: 8,
  qa: 9,
  blocked: 10,
};

/**
 * The seed script's Ops: started from Tio, then Next recoloured, Shipped
 * closed, Discard counted as completed, Backlog the default, the line on
 * Done, QA and Blocked added, In Progress above Next, kind:bug recoloured,
 * wontfix and p1 added.
 */
function ops(line: number | null = S.done): Plan["project"] {
  const s = (
    id: number,
    name: string,
    color: string,
    category: "open" | "closed" = "open",
    role: TemplateStatus["chart_role"] = category === "open"
      ? "remaining"
      : "completed",
  ) => ({ id, name, color, category, role, is_default: id === S.backlog });
  return {
    statuses: [
      s(S.backlog, "Backlog", "#9ca3af"),
      s(S.todo, "Todo", "#6b7280"),
      s(S.inProgress, "In Progress", "#3b82f6"),
      s(S.next, "Next", "#a3e635"),
      s(S.qa, "QA", "#f472b6"),
      s(S.ready, "Ready to Ship", "#f59e0b"),
      s(S.blocked, "Blocked", "#ef4444"),
      s(S.shipped, "Shipped", "#8b5cf6", "closed"),
      s(S.done, "Done", "#22c55e", "closed"),
      s(S.discard, "Discard", "#64748b", "closed"),
    ],
    line,
    labels: [
      [20, "kind:bug", "#f97316"],
      [21, "kind:chore", "#22c55e"],
      [22, "kind:feature", "#0ea5e9"],
      [23, "needs-brainstorm", "#eab308"],
      [24, "urgent", "#ef4444"],
      [25, "wontfix", "#64748b"],
      [26, "p1", "#dc2626"],
    ].map(([id, name, color]) => ({
      id: id as number,
      name: name as string,
      color: color as string,
    })),
  };
}

const base = (
  id: string,
  section: "statuses" | "labels",
  action: ChangeRow["action"],
  extra: { selectable?: boolean; requires?: string[] } = {},
) => ({
  id,
  section,
  action,
  default_selected: action !== "delete",
  selectable: extra.selectable ?? true,
  requires: extra.requires ?? [],
});

const ref = (name: string, color: string) => ({ name, color });

/** Patch flow against Ops, as the server lays it out. */
function opsRows(line: ChangeRow | null = lineRow()): ChangeRow[] {
  return [
    {
      ...base("status.add:Patch Series", "statuses", "add"),
      type: "status_add",
      name: "Patch Series",
      category: "open",
      color: "#ec4899",
      chart_role: "remaining",
      after: "Shipped",
    },
    {
      ...base("status.add:Email Sent", "statuses", "add"),
      type: "status_add",
      name: "Email Sent",
      category: "open",
      color: "#14b8a6",
      chart_role: "completed",
      after: "Patch Series",
    },
    {
      ...base(`status.recolour:${S.next}`, "statuses", "recolour"),
      type: "status_recolour",
      name: "Next",
      from: "#a3e635",
      to: "#06b6d4",
    },
    {
      ...base(`status.change:${S.shipped}`, "statuses", "change"),
      type: "status_change",
      name: "Shipped",
      color_now: "#8b5cf6",
      category: { from: "closed", to: "open" },
    },
    {
      ...base(`status.change:${S.discard}`, "statuses", "change"),
      type: "status_change",
      name: "Discard",
      color_now: "#64748b",
      chart_role: { from: "completed", to: "excluded" },
    },
    {
      ...base(`status.move:${S.inProgress}`, "statuses", "move"),
      type: "status_move",
    },
    {
      ...base("status.default", "statuses", "change"),
      type: "status_default",
      from: ref("Backlog", "#9ca3af"),
      to: ref("Todo", "#6b7280"),
    },
    ...(line ? [line] : []),
    {
      ...base(`status.delete:${S.qa}`, "statuses", "delete"),
      type: "status_delete",
      name: "QA",
      color: "#f472b6",
      issues: 0,
      trashed: 0,
    },
    {
      ...base(`status.delete:${S.blocked}`, "statuses", "delete", {
        selectable: false,
      }),
      type: "status_delete",
      name: "Blocked",
      color: "#ef4444",
      issues: 2,
      trashed: 0,
    },
    ...PATCH_FLOW.labels
      .filter((label) => label.name.startsWith("area:"))
      .map(
        (label): ChangeRow => ({
          ...base(`label.add:${label.name}`, "labels", "add"),
          type: "label_add",
          ...label,
        }),
      ),
    {
      ...base("label.change:20", "labels", "recolour"),
      type: "label_change",
      name: "kind:bug",
      from: "#f97316",
      to: "#ef4444",
    },
    {
      ...base("label.delete:25", "labels", "delete"),
      type: "label_delete",
      name: "wontfix",
      color: "#64748b",
      issues: 0,
      trashed: 0,
    },
    {
      ...base("label.delete:26", "labels", "delete"),
      type: "label_delete",
      name: "p1",
      color: "#dc2626",
      issues: 3,
      trashed: 0,
    },
  ];
}

function lineRow(
  from: string | null = "Done",
  to: string | null = "Shipped",
): ChangeRow {
  return {
    ...base("status.line", "statuses", "move"),
    type: "status_line",
    from: from === null ? null : ref(from, "#000000"),
    to: to === null ? null : ref(to, "#000000"),
  };
}

/** What the server starts selected: everything but the deletions. */
const defaults = (rows: ChangeRow[]) =>
  new Set(rows.filter((row) => row.default_selected).map((row) => row.id));

/**
 * The status the After side's line is drawn right above: the first one
 * there below the row that holds the line.
 */
function lineDrawnAbove(table: StatusTable): StatusKey | null {
  const at = table.rows.findIndex(
    (row) =>
      (row.kind === "line" && row.after === "solid") ||
      (row.kind === "status" && row.lineAbove),
  );
  if (at < 0) return null;
  const below = table.rows
    .slice(at)
    .find((row) => row.kind === "status" && row.after?.look === "solid");
  return below?.kind === "status" ? below.status : null;
}

describe("the table of statuses", () => {
  it("draws the line right above the status it moves down to off a deleted one", () => {
    const plan = { project: ops(S.qa), template: PATCH_FLOW };
    const rows = opsRows(lineRow("QA", "Shipped"));
    for (const moved of [true, false]) {
      const selected = defaults(rows);
      selected.delete("status.line");
      selected.add(`status.delete:${S.qa}`);
      if (!moved) selected.delete(`status.move:${S.inProgress}`);
      const table = statusTable(plan, rows, selected);
      expect(table.result.line, `moved: ${moved}`).toBe(S.ready);
      expect(lineDrawnAbove(table), `moved: ${moved}`).toBe(S.ready);
    }
  });

  it("draws the default passing from one status to another as an arrow with its box on it", () => {
    const rows = opsRows();
    const table = statusTable(
      { project: ops(), template: PATCH_FLOW },
      rows,
      defaults(rows),
    );
    const arrow = table.arrows.find((a) => a.kind === "default");
    const at = (key: StatusKey) =>
      table.rows.findIndex(
        (row) => row.kind === "status" && row.status === key,
      );
    expect(arrow).toMatchObject({
      from: at(S.backlog),
      to: at(S.todo),
      tick: "status.default",
      ticked: true,
    });
    expect(table.rows[at(S.todo)]?.ticks.map((t) => t.id)).toEqual([
      "status.default",
    ]);
  });

  it("puts the default's box in the one row there is when a side has none", () => {
    const withDefault = (from: string | null, to: string | null) =>
      opsRows().map((row) =>
        row.type === "status_default"
          ? {
              ...row,
              from: from === null ? null : ref(from, "#9ca3af"),
              to: to === null ? null : ref(to, "#6b7280"),
            }
          : row,
      );
    const holder = (table: StatusTable) =>
      table.rows.flatMap((row) =>
        row.ticks.some((t) => t.id === "status.default") &&
        row.kind === "status"
          ? [row.status]
          : [],
      );

    // The project has no default yet.
    const project = ops();
    const none = {
      ...project,
      statuses: project.statuses.map((s) => ({ ...s, is_default: false })),
    };
    const fromNone = withDefault(null, "Todo");
    const first = statusTable(
      { project: none, template: PATCH_FLOW },
      fromNone,
      defaults(fromNone),
    );
    expect(first.arrows.filter((a) => a.kind === "default")).toEqual([]);
    expect(holder(first)).toEqual([S.todo]);

    // The template has none.
    const template = {
      ...PATCH_FLOW,
      statuses: PATCH_FLOW.statuses.map(({ is_default: _, ...s }) => s),
    };
    const toNone = withDefault("Backlog", null);
    const second = statusTable({ project, template }, toNone, defaults(toNone));
    expect(second.arrows.filter((a) => a.kind === "default")).toEqual([]);
    expect(holder(second)).toEqual([S.backlog]);
  });

  it("gives the line one row where the template has none, and draws none once that is ticked", () => {
    const template = {
      ...PATCH_FLOW,
      statuses: PATCH_FLOW.statuses.map(({ block_clear: _, ...s }) => s),
    };
    const rows = opsRows(lineRow("Done", null));
    const plan = { project: ops(), template };
    const ticked = statusTable(plan, rows, defaults(rows));
    const lines = ticked.rows.filter((row) => row.kind === "line");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.ticks.map((t) => t.id)).toEqual(["status.line"]);
    expect(ticked.arrows.filter((a) => a.start === "line")).toEqual([]);
    expect(ticked.result.line).toBeNull();
    expect(lineDrawnAbove(ticked)).toBeNull();

    const kept = defaults(rows);
    kept.delete("status.line");
    expect(lineDrawnAbove(statusTable(plan, rows, kept))).toBe(S.done);
  });

  it("gives the line one row where the project has none, a shadow until ticked", () => {
    const rows = opsRows(lineRow(null, "Shipped"));
    const plan = { project: ops(null), template: PATCH_FLOW };
    const off = defaults(rows);
    off.delete("status.line");
    const unticked = statusTable(plan, rows, off);
    const lines = unticked.rows.filter((row) => row.kind === "line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ before: false, after: "shadow" });
    expect(lines[0]?.ticks.map((t) => t.id)).toEqual(["status.line"]);

    const ticked = statusTable(plan, rows, defaults(rows));
    expect(ticked.rows.filter((row) => row.kind === "line")).toMatchObject([
      { after: "solid" },
    ]);
    expect(lineDrawnAbove(ticked)).toBe(S.shipped);
  });

  it("tints a row that recolours and changes what a status means in the meaning's colour", () => {
    // Shipped recoloured as well as opened.
    const rows: ChangeRow[] = [
      ...opsRows(),
      {
        ...base(`status.recolour:${S.shipped}`, "statuses", "recolour"),
        type: "status_recolour",
        name: "Shipped",
        from: "#8b5cf6",
        to: "#7c3aed",
      },
    ];
    const plan = { project: ops(), template: PATCH_FLOW };
    const shipped = (selected: Set<string>) =>
      statusTable(plan, rows, selected).rows.find(
        (row) => row.kind === "status" && row.status === S.shipped,
      );
    const all = defaults(rows);
    expect(shipped(all)).toMatchObject({ tint: "change" });
    all.delete(`status.change:${S.shipped}`);
    expect(shipped(all)).toMatchObject({ tint: "recolour" });
  });
});

describe("the table of labels", () => {
  const plan = { project: ops(), template: PATCH_FLOW };

  it("gives each recolour, addition and deletion a row, the labels left alone one to a prefix", () => {
    const rows = opsRows();
    const table = labelTable(plan, rows, defaults(rows));
    const names = (side: { labels: { name: string }[] } | null) =>
      side?.labels.map((label) => label.name) ?? [];
    expect(
      table.map((row) => ({
        before: names(row.before),
        after: names(row.after),
        ticks: row.ticks.map((t) => t.id),
      })),
    ).toEqual([
      {
        before: [],
        after: [
          "area:cli",
          "area:docs",
          "area:infra",
          "area:server",
          "area:shared",
          "area:web",
        ],
        ticks: [],
      },
      { before: ["kind:bug"], after: ["kind:bug"], ticks: ["label.change:20"] },
      {
        before: ["kind:chore", "kind:feature"],
        after: ["kind:chore", "kind:feature"],
        ticks: [],
      },
      { before: ["p1"], after: ["p1"], ticks: ["label.delete:26"] },
      { before: ["wontfix"], after: ["wontfix"], ticks: ["label.delete:25"] },
      {
        before: ["needs-brainstorm", "urgent"],
        after: ["needs-brainstorm", "urgent"],
        ticks: [],
      },
    ]);
  });

  it("folds a prefix the template alone has into one row, half-ticked while some are left out", () => {
    const rows = opsRows();
    const selected = defaults(rows);
    selected.delete("label.add:area:docs");
    const [group] = labelTable(plan, rows, selected);
    expect(group?.group).toMatchObject({
      prefix: "area:",
      checked: false,
      indeterminate: true,
    });
    expect(group?.group?.members.map((m) => m.after?.look)).toEqual([
      "solid",
      "shadow",
      "solid",
      "solid",
      "solid",
      "solid",
    ]);
  });
});
