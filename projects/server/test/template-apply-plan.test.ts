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
  TEMPLATE_APPLY_RULES,
  templateApplyDigest,
} from "../src/services/template-apply.ts";

const BASIC = BUILTIN_TEMPLATES.basic.body;
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
    labels?: Array<{
      name: string;
      color: string;
      issues?: number;
      trashed?: number;
    }>;
  } = {},
): ProjectState {
  const statuses = specs.map((spec, i) => {
    const category =
      spec.category ??
      BASIC.statuses.find((s) => s.name === spec.name.trim())?.category ??
      "open";
    return {
      id: i + 1,
      name: spec.name,
      category,
      color: spec.color ?? colorIn(BASIC, spec.name),
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
      trashed: l.trashed ?? 0,
    })),
  };
}

const BASIC_LABELS = [
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
    const rows = planTemplateApply(state, BASIC);
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

  it("counts the trashed cards a label deletion takes it off", () => {
    const state = project(
      [
        ...FLOW.map((name) => ({ name })),
        { name: "Shipped" },
        { name: "Done" },
        { name: "Invalid" },
      ],
      {
        labels: [
          ...BASIC_LABELS,
          { name: "area:old", color: "#14b8a6", trashed: 1 },
        ],
      },
    );
    const old = state.labels.find((l) => l.name === "area:old")?.id;
    expect(
      row(planTemplateApply(state, BASIC), `label.delete:${old}`),
    ).toMatchObject({
      issues: 0,
      trashed: 1,
    });
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
      ...BASIC,
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
          color: colorIn(BASIC, "Todo"),
          chart_role: "remaining",
        },
        {
          name: "Done",
          category: "closed",
          color: colorIn(BASIC, "Done"),
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
      { labels: BASIC_LABELS },
    );
    const rows = planTemplateApply(state, BASIC);
    // Parked is left over, and where it sits is not an order difference.
    expect(ids(rows)).toEqual(["status.delete:2"]);

    const exact = project(
      [
        ...FLOW.map((name) => ({ name })),
        { name: "Shipped" },
        { name: "Done" },
        { name: "Invalid" },
      ],
      { labels: BASIC_LABELS },
    );
    expect(planTemplateApply(exact, BASIC)).toEqual([]);
  });

  it("names two statuses that differ only in whitespace by their own ids", () => {
    const state = project([
      { name: "Todo" },
      { name: "Done ", category: "closed" },
      { name: "Done  ", category: "closed" },
    ]);
    const template: TemplateBody = {
      statuses: [BASIC.statuses[1] as TemplateBody["statuses"][number]],
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
      { labels: BASIC_LABELS },
    );
    const rows = planTemplateApply(state, BASIC);
    expect(ids(rows)).toEqual(["status.recolour:7"]);
    expect(row(rows, "status.recolour:7")).toMatchObject({
      name: "Done ",
      from: "#000000",
      to: colorIn(BASIC, "Done"),
    });
  });

  it("lists a status's colour apart from what it means", () => {
    const state = project([
      ...FLOW.map((name) => ({ name })),
      { name: "Shipped" },
      { name: "Done", color: "#000000", category: "open" },
      { name: "Invalid" },
    ]);
    const rows = planTemplateApply(state, { ...BASIC, labels: [] });
    expect(ids(rows)).toEqual(["status.change:7", "status.recolour:7"]);
    expect(row(rows, "status.recolour:7")).toMatchObject({
      action: "recolour",
      from: "#000000",
      to: colorIn(BASIC, "Done"),
    });
    expect(row(rows, "status.change:7")).toMatchObject({
      action: "change",
      category: { from: "open", to: "closed" },
    });
  });

  it("lists each status out of the template's order as a move of its own", () => {
    // Todo and Next swapped, Done before Shipped: of each pair the upper one
    // moves.
    const state = project([
      { name: "Backlog" },
      { name: "Next" },
      { name: "Todo" },
      { name: "In Progress" },
      { name: "Ready to Ship" },
      { name: "Done" },
      { name: "Shipped" },
      { name: "Invalid" },
    ]);
    const rows = planTemplateApply(state, { ...BASIC, labels: [] });
    expect(ids(rows)).toEqual(["status.move:2", "status.move:6"]);
    expect(row(rows, "status.move:2")).toMatchObject({
      type: "status_move",
      action: "move",
      default_selected: true,
    });
  });

  it("pairs a project's name with the template's whatever their case", () => {
    const state = project(
      [
        ...FLOW.map((name) => ({ name })),
        { name: "Shipped" },
        { name: "done", category: "closed", color: "#000000" },
        { name: "Invalid" },
      ],
      { labels: [...BASIC_LABELS, { name: "bug", color: "#000000" }] },
    );
    const template: TemplateBody = {
      ...BASIC,
      labels: [...BASIC.labels, { name: "Bug", color: "#ef4444" }],
    };
    const rows = planTemplateApply(state, template);
    expect(ids(rows)).toEqual(["label.change:104", "status.recolour:7"]);
    expect(row(rows, "status.recolour:7")).toMatchObject({ name: "done" });
    expect(row(rows, "label.change:104")).toMatchObject({
      name: "bug",
      to: "#ef4444",
    });
  });

  it("pairs a name the database folds alike, as a capital dotted I", () => {
    const state = project(
      [
        ...FLOW.map((name) => ({ name })),
        { name: "Shipped" },
        { name: "Done" },
        { name: "Invalid" },
      ],
      { labels: [...BASIC_LABELS, { name: "iptal", color: "#000000" }] },
    );
    const template: TemplateBody = {
      ...BASIC,
      labels: [...BASIC.labels, { name: "\u0130ptal", color: "#000000" }],
    };
    const rows = planTemplateApply(state, template);
    expect(ids(rows).filter((id) => id.startsWith("label."))).toEqual([]);
  });
});

describe("applySelection", () => {
  const apply = (
    state: ProjectState,
    selected: string[],
    labelIssues?: Record<string, number>,
  ) =>
    applySelection(
      state,
      BASIC,
      planTemplateApply(state, BASIC),
      selected,
      undefined,
      labelIssues,
    );

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

  it("changes a paired status's colour, category and role, each as ticked, keeping its name", () => {
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
    const done = colorIn(BASIC, "Done");
    const both = apply(state, ["status.recolour:7", "status.change:7"]);
    expect(both.updateStatuses).toEqual([
      { id: 7, color: done, category: "closed" },
    ]);
    expect(both.roleChanges).toEqual([
      { kind: "edited", key: 7, role: "completed" },
    ]);
    expect(apply(state, ["status.recolour:7"])).toMatchObject({
      updateStatuses: [{ id: 7, color: done }],
      roleChanges: [],
    });
    expect(apply(state, ["status.change:7"])).toMatchObject({
      updateStatuses: [{ id: 7, category: "closed" }],
      roleChanges: [{ kind: "edited", key: 7, role: "completed" }],
    });
    expect(state.statuses[6]?.name).toBe("Done ");
  });

  it("keeps the template's chart role when only the category changes", () => {
    // QA counts as remaining, by default, while open. Closed, its default
    // would be completed; the template wants it remaining all the same.
    const state = project([{ name: "QA", category: "open" }], { line: "QA" });
    const template: TemplateBody = {
      statuses: [
        {
          name: "QA",
          category: "closed",
          color: colorIn(BASIC, "QA"),
          chart_role: "remaining",
          block_clear: true,
        },
      ],
      labels: [],
    };
    const rows = planTemplateApply(state, template);
    expect(ids(rows)).toEqual(["status.change:1"]);
    const outcome = applySelection(state, template, rows, ["status.change:1"]);
    expect(outcome.updateStatuses).toEqual([{ id: 1, category: "closed" }]);
    expect(outcome.roleChanges).toEqual([
      { kind: "edited", key: 1, role: "remaining" },
    ]);
  });

  it("deletes only the label it was asked to", () => {
    const state = drifted();
    const docs = state.labels.find((l) => l.name === "kind:docs")?.id;
    const outcome = apply(state, [`label.delete:${docs}`], {
      [`label.delete:${docs}`]: 2,
    });
    expect(outcome.deleteLabelIds).toEqual([docs]);
    expect(outcome.updateLabels).toEqual([]);
  });

  it("names every label deletion sent without a count, and the first whose count moved", () => {
    const state = drifted();
    const idOf = (name: string) =>
      state.labels.find((l) => l.name === name)?.id;
    const docs = `label.delete:${idOf("kind:docs")}`;
    const web = `label.delete:${idOf("area:web")}`;
    const refusal = (labelIssues?: Record<string, number>) => {
      try {
        apply(state, [web, docs], labelIssues);
      } catch (error) {
        return error;
      }
      throw new Error("applied");
    };
    expect(refusal()).toMatchObject({
      code: "validation_failed",
      details: { missing: expect.arrayContaining([docs, web]) },
    });
    // kind:docs comes first among the rows, whatever order they are sent in.
    expect(refusal({ [docs]: 0, [web]: 0 })).toMatchObject({
      code: "conflict",
      details: { id: docs, shown: 0, now: 2 },
    });
  });

  it("moves the line down off a deleted status, unless the line row is taken", () => {
    const state = project(
      [...FLOW.map((name) => ({ name })), { name: "Gate" }, { name: "Done" }],
      { line: "Gate" },
    );
    // A template whose line is on Next rather than Shipped.
    const template: TemplateBody = {
      statuses: BASIC.statuses
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
    const rows = planTemplateApply(state, BASIC);
    const outcome = applySelection(state, BASIC, rows, ["status.delete:6"]);
    expect(outcome.deleteStatusIds).toEqual([6]);
    expect(outcome.defaultStatus).toBeUndefined();
  });
});

describe("templateApplyDigest", () => {
  it("tells apart a plan made under other rules, the project and template the same", () => {
    // A preview from before an upgrade must not match the apply after it.
    const state = drifted();
    expect(
      templateApplyDigest(state, BASIC, 0, TEMPLATE_APPLY_RULES - 1),
    ).not.toBe(templateApplyDigest(state, BASIC, 0));
  });

  it("tells two template bodies apart at the same revision", () => {
    // A built-in template is always revision 0: an upgrade that changes it
    // between a preview and its apply has to void the preview all the same.
    const state = drifted();
    const changed: TemplateBody = {
      ...BASIC,
      labels: BASIC.labels.filter((l) => l.name !== "kind:chore"),
    };
    expect(templateApplyDigest(state, changed, 0)).not.toBe(
      templateApplyDigest(state, BASIC, 0),
    );
  });
});
