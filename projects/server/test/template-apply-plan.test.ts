import {
  BUILTIN_TEMPLATES,
  type ChangeRow,
  defaultInsightsRole,
  type TemplateBody,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  applySelection,
  type ProjectState,
  planTemplateApply,
} from "../src/services/template-apply.ts";

const DEFAULT = BUILTIN_TEMPLATES.default.body;
const colorIn = (body: TemplateBody, name: string) =>
  body.statuses.find((s) => s.name === name)?.color ?? "#6b7280";

type StatusSpec = {
  name: string;
  category?: "open" | "closed";
  color?: string;
  isDefault?: boolean;
  issues?: number;
  trashed?: number;
  role?: "remaining" | "completed" | "excluded";
};

/** A project laid out by hand: statuses in board order, ids from 1. */
function project(
  specs: StatusSpec[],
  opts: {
    line?: string;
    labels?: Array<{ name: string; color: string; issues?: number }>;
  } = {},
): ProjectState {
  const statuses = specs.map((spec, i) => {
    const category =
      spec.category ??
      DEFAULT.statuses.find((s) => s.name === spec.name.trim())?.category ??
      "open";
    return {
      id: i + 1,
      name: spec.name,
      category,
      color: spec.color ?? colorIn(DEFAULT, spec.name),
      position: i,
      isDefault: spec.isDefault ?? spec.name === "Todo",
      role: spec.role ?? defaultInsightsRole({ name: spec.name, category }),
      issues: spec.issues ?? 0,
      trashed: spec.trashed ?? 0,
    };
  });
  return {
    statuses,
    lineId:
      statuses.find((s) => s.name === (opts.line ?? "Shipped"))?.id ?? null,
    saved: null,
    labels: (opts.labels ?? []).map((l, i) => ({
      id: 100 + i,
      name: l.name,
      color: l.color,
      issues: l.issues ?? 0,
    })),
  };
}

const DEFAULT_LABELS = [
  { name: "kind:bug", color: "#ef4444" },
  { name: "kind:chore", color: "#22c55e" },
  { name: "kind:feature", color: "#0ea5e9" },
  { name: "needs-brainstorm", color: "#eab308" },
];
const FLOW = ["Backlog", "Todo", "Next", "In Progress", "Ready to Ship"];

/** Backlog…Done with Parked and Discard, no Invalid, labels drifted. */
function drifted(): ProjectState {
  return project(
    [
      ...FLOW.map((name) => ({ name })),
      { name: "Parked", issues: 0 },
      { name: "Shipped" },
      { name: "Done" },
      { name: "Discard", category: "closed", issues: 3 },
    ],
    {
      labels: [
        { name: "kind:bug", color: "#3b82f6" },
        { name: "kind:chore", color: "#22c55e" },
        { name: "kind:feature", color: "#0ea5e9" },
        { name: "needs-brainstorm", color: "#eab308" },
        { name: "kind:docs", color: "#14b8a6", issues: 2 },
        { name: "area:web", color: "#0ea5e9", issues: 5 },
      ],
    },
  );
}

const ids = (rows: ChangeRow[]) => rows.map((r) => r.id).sort();
const row = (rows: ChangeRow[], id: string) => {
  const found = rows.find((r) => r.id === id);
  expect(found, id).toBeDefined();
  return found as ChangeRow;
};
const nameOf = (state: ProjectState, key: number | string) =>
  typeof key === "number"
    ? state.statuses.find((s) => s.id === key)?.name
    : key;

describe("planTemplateApply", () => {
  it("lists one row per difference, by project id for what the project has", () => {
    const state = drifted();
    const rows = planTemplateApply(state, DEFAULT);
    const idOf = (name: string) =>
      [...state.statuses, ...state.labels].find((x) => x.name === name)?.id;

    expect(ids(rows)).toEqual(
      [
        "status.add:Invalid",
        `label.change:${idOf("kind:bug")}`,
        `label.delete:${idOf("kind:docs")}`,
        `label.delete:${idOf("area:web")}`,
        `status.delete:${idOf("Parked")}`,
        `status.delete:${idOf("Discard")}`,
      ].sort(),
    );
    for (const r of rows) {
      expect(r.default_selected, r.id).toBe(r.action !== "delete");
    }
    const discard = row(rows, `status.delete:${idOf("Discard")}`);
    expect(discard).toMatchObject({ selectable: false, issues: 3 });
    expect(row(rows, `status.delete:${idOf("Parked")}`).selectable).toBe(true);
    expect(row(rows, "status.add:Invalid")).toMatchObject({ after: "Done" });
  });

  it("will not offer to delete a status holding only trashed issues", () => {
    const state = project([
      ...FLOW.map((name) => ({ name })),
      { name: "Shipped" },
      { name: "Done" },
      { name: "Invalid" },
      { name: "Binned", trashed: 1 },
    ]);
    const rows = planTemplateApply(state, {
      ...DEFAULT,
      labels: [],
    });
    expect(row(rows, "status.delete:9")).toMatchObject({
      selectable: false,
      issues: 0,
      trashed: 1,
    });
  });

  it("makes a default on a status still to be added require that addition", () => {
    const state = project([{ name: "Todo" }, { name: "Done" }], {
      line: "Done",
    });
    const template: TemplateBody = {
      statuses: [
        {
          name: "Inbox",
          category: "open",
          color: "#9ca3af",
          chart_role: "remaining",
          is_default: true,
        },
        {
          name: "Todo",
          category: "open",
          color: colorIn(DEFAULT, "Todo"),
          chart_role: "remaining",
        },
        {
          name: "Done",
          category: "closed",
          color: colorIn(DEFAULT, "Done"),
          chart_role: "completed",
          block_clear: true,
        },
      ],
      labels: [],
    };
    const rows = planTemplateApply(state, template);
    expect(row(rows, "status.default")).toMatchObject({
      requires: ["status.add:Inbox"],
      from: { name: "Todo" },
      to: { name: "Inbox" },
    });
  });

  it("has nothing to say when the project already matches, extras aside", () => {
    const state = project(
      [
        { name: "Backlog" },
        { name: "Parked", issues: 1 },
        ...FLOW.slice(1).map((name) => ({ name })),
        { name: "Shipped" },
        { name: "Done" },
        { name: "Invalid" },
      ],
      { labels: DEFAULT_LABELS },
    );
    const rows = planTemplateApply(state, DEFAULT);
    // Parked is left over, and where it sits is not an order difference.
    expect(ids(rows)).toEqual(["status.delete:2"]);

    const exact = project(
      [
        ...FLOW.map((name) => ({ name })),
        { name: "Shipped" },
        { name: "Done" },
        { name: "Invalid" },
      ],
      { labels: DEFAULT_LABELS },
    );
    expect(planTemplateApply(exact, DEFAULT)).toEqual([]);
  });

  it("names two statuses that differ only in whitespace by their own ids", () => {
    const state = project([
      { name: "Todo" },
      { name: "Done ", category: "closed" },
      { name: "Done  ", category: "closed" },
    ]);
    const template: TemplateBody = {
      statuses: [DEFAULT.statuses[1] as TemplateBody["statuses"][number]],
      labels: [],
    };
    const rows = planTemplateApply(state, template);
    expect(
      rows.filter((r) => r.type === "status_delete").map((r) => r.id),
    ).toEqual(["status.delete:2", "status.delete:3"]);
  });

  it("pairs a project's untrimmed name with the template's", () => {
    const state = project(
      [
        ...FLOW.map((name) => ({ name })),
        { name: "Shipped" },
        { name: "Done ", color: "#000000" },
        { name: "Invalid" },
      ],
      { labels: DEFAULT_LABELS },
    );
    const rows = planTemplateApply(state, DEFAULT);
    expect(ids(rows)).toEqual(["status.change:7"]);
    expect(row(rows, "status.change:7")).toMatchObject({
      name: "Done ",
      color: { from: "#000000", to: colorIn(DEFAULT, "Done") },
    });
  });
});

describe("applySelection", () => {
  const apply = (state: ProjectState, selected: string[]) =>
    applySelection(state, DEFAULT, planTemplateApply(state, DEFAULT), selected);

  it("puts an added status after the one it follows in the template", () => {
    const state = drifted();
    const outcome = apply(state, ["status.add:Invalid"]);
    expect(outcome.order.map((key) => nameOf(state, key))).toEqual([
      ...FLOW,
      "Parked",
      "Shipped",
      "Done",
      "Invalid",
      "Discard",
    ]);
  });

  it("takes the template's order, each extra right after what it followed", () => {
    const state = project([
      { name: "Backlog" },
      { name: "Next" },
      { name: "Todo" },
      { name: "In Progress" },
      { name: "Ready to Ship" },
      { name: "Shipped" },
      { name: "Discard", category: "closed" },
      { name: "Done" },
      { name: "Invalid" },
    ]);
    const rows = planTemplateApply(state, DEFAULT);
    expect(row(rows, "status.order").type).toBe("status_order");
    const outcome = applySelection(state, DEFAULT, rows, ["status.order"]);
    expect(outcome.order.map((key) => nameOf(state, key))).toEqual([
      ...FLOW,
      "Shipped",
      "Discard",
      "Done",
      "Invalid",
    ]);
  });

  it("changes a paired status's colour, category and role, keeping its name", () => {
    const state = project([
      ...FLOW.map((name) => ({ name })),
      { name: "Shipped" },
      {
        name: "Done ",
        color: "#000000",
        category: "open",
        role: "excluded",
      },
      { name: "Invalid" },
    ]);
    const outcome = apply(state, ["status.change:7"]);
    expect(outcome.updateStatuses).toEqual([
      { id: 7, color: colorIn(DEFAULT, "Done"), category: "closed" },
    ]);
    expect(outcome.roleChanges).toEqual([
      { kind: "edited", key: 7, role: "completed" },
    ]);
    expect(state.statuses[6]?.name).toBe("Done ");
  });

  it("deletes only the label it was asked to", () => {
    const state = drifted();
    const docs = state.labels.find((l) => l.name === "kind:docs")?.id;
    const outcome = apply(state, [`label.delete:${docs}`]);
    expect(outcome.deleteLabelIds).toEqual([docs]);
    expect(outcome.updateLabels).toEqual([]);
  });

  it("moves the line down off a deleted status, unless the line row is taken", () => {
    const state = project(
      [...FLOW.map((name) => ({ name })), { name: "Gate" }, { name: "Done" }],
      { line: "Gate" },
    );
    // A template whose line is on Next rather than Shipped.
    const template: TemplateBody = {
      statuses: DEFAULT.statuses
        .filter((s) => s.name !== "Shipped" && s.name !== "Invalid")
        .map(({ block_clear: _, ...s }) =>
          s.name === "Next" ? { ...s, block_clear: true as const } : s,
        ),
      labels: [],
    };
    const rows = planTemplateApply(state, template);
    const kept = applySelection(state, template, rows, ["status.delete:6"]);
    expect(nameOf(state, kept.line as number)).toBe("Done");
    const taken = applySelection(state, template, rows, [
      "status.delete:6",
      "status.line",
    ]);
    expect(nameOf(state, taken.line as number)).toBe("Next");
  });

  it("leaves the project without a default when its default is deleted alone", () => {
    const state = project([
      ...FLOW.map((name) => ({ name, isDefault: false })),
      { name: "Waiting", isDefault: true },
      { name: "Shipped" },
      { name: "Done" },
      { name: "Invalid" },
    ]);
    const rows = planTemplateApply(state, DEFAULT);
    const outcome = applySelection(state, DEFAULT, rows, ["status.delete:6"]);
    expect(outcome.deleteStatusIds).toEqual([6]);
    expect(outcome.defaultStatus).toBeUndefined();
  });
});
