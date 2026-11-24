import { describe, expect, it } from "vitest";
import type { ChangeRow, TemplateBody } from "../src/index.ts";
import {
  type ApplyProject,
  afterCell,
  applyLayout,
  applyResult,
  type LayoutRow,
  type StatusKey,
  statusMovers,
} from "../src/template-apply.ts";

/**
 * A project with these statuses in this order, ids from 1, those named in
 * `closed` closed and the rest open.
 */
function project(
  names: string[],
  line: string | null = null,
  closed: string[] = [],
): ApplyProject {
  const statuses = names.map((name, i): ApplyProject["statuses"][number] => ({
    id: i + 1,
    name,
    category: closed.includes(name) ? "closed" : "open",
    is_default: i === 0,
  }));
  return {
    statuses,
    line: statuses.find((s) => s.name === line)?.id ?? null,
  };
}

/** A template with these statuses in this order. */
function template(names: string[], line: string | null = null): TemplateBody {
  return {
    statuses: names.map((name, i) => ({
      name,
      category: "open",
      color: "#6b7280",
      chart_role: "remaining",
      ...(i === 0 && { is_default: true as const }),
      ...(name === line && { block_clear: true as const }),
    })),
    labels: [],
  };
}

const base = (id: string, action: ChangeRow["action"]) => ({
  id,
  section: "statuses" as const,
  action,
  default_selected: action !== "delete",
  selectable: true,
  requires: [],
});

/**
 * The plan's status rows, as the server lays them out: a move for each
 * status that moves, an addition for each status the template adds, a
 * deletion for each it lacks, and the line's row when the line differs.
 */
function rowsFor(p: ApplyProject, t: TemplateBody): ChangeRow[] {
  const ids = new Map(p.statuses.map((s) => [s.name, s.id]));
  const names = new Set(t.statuses.map((s) => s.name));
  const line = t.statuses.find((s) => s.block_clear);
  const lineKey = line === undefined ? null : (ids.get(line.name) ?? line.name);
  const ref = (name: string | undefined) =>
    name === undefined ? null : { name, color: "#6b7280" };
  return [
    ...t.statuses
      .filter((s) => !ids.has(s.name))
      .map(
        (s): ChangeRow => ({
          ...base(`status.add:${s.name}`, "add"),
          type: "status_add",
          name: s.name,
          category: s.category,
          color: s.color,
          chart_role: s.chart_role,
          after: t.statuses[t.statuses.indexOf(s) - 1]?.name ?? null,
        }),
      ),
    ...[...statusMovers(p.statuses, t)].map(
      (id): ChangeRow => ({
        ...base(`status.move:${id}`, "move"),
        type: "status_move",
      }),
    ),
    ...(lineKey === p.line
      ? []
      : [
          {
            ...base("status.line", "move"),
            type: "status_line",
            from: ref(p.statuses.find((s) => s.id === p.line)?.name),
            to: ref(line?.name),
          } satisfies ChangeRow,
        ]),
    ...p.statuses
      .filter((s) => !names.has(s.name))
      .map(
        (s): ChangeRow => ({
          ...base(`status.delete:${s.id}`, "delete"),
          type: "status_delete",
          name: s.name,
          color: "#6b7280",
          issues: 0,
          trashed: 0,
        }),
      ),
  ];
}

/** The order once `selected` is applied, by name. */
function orderOf(
  p: ApplyProject,
  t: TemplateBody,
  selected: (rows: ChangeRow[]) => string[],
) {
  const rows = rowsFor(p, t);
  const result = applyResult(applyLayout(p, t, rows), new Set(selected(rows)));
  return result.order.map((key) => nameOf(p, key));
}

/**
 * The project once the rows ticked by default are applied: the status the
 * line is on, the statuses above it, and those from it down, by name.
 */
function sidesOf(p: ApplyProject, t: TemplateBody) {
  const rows = rowsFor(p, t);
  const ticked = rows.filter((r) => r.default_selected).map((r) => r.id);
  const result = applyResult(applyLayout(p, t, rows), new Set(ticked));
  const names = result.order.map((key) => nameOf(p, key));
  const at =
    result.line === null ? names.length : result.order.indexOf(result.line);
  return {
    line: result.line === null ? null : nameOf(p, result.line),
    above: names.slice(0, at),
    below: names.slice(at),
  };
}

const nameOf = (p: ApplyProject, key: StatusKey) =>
  typeof key === "number" ? p.statuses.find((s) => s.id === key)?.name : key;

const idOf = (p: ApplyProject, name: string) =>
  p.statuses.find((s) => s.name === name)?.id as number;

const FLOW = ["Backlog", "Todo", "Next", "In Progress", "Ready to Ship"];
const BASIC = template([...FLOW, "Shipped", "Done", "Invalid"], "Shipped");

describe("applying a template's order", () => {
  it("leaves the order as it is with nothing ticked", () => {
    const p = project(["Done", "Todo", "Parked", "Backlog", "Next"]);
    expect(orderOf(p, BASIC, () => [])).toEqual([
      "Done",
      "Todo",
      "Parked",
      "Backlog",
      "Next",
    ]);
  });

  it("takes the template's order with every move ticked, each extra where it was", () => {
    const p = project([
      "Backlog",
      "Next",
      "Todo",
      "In Progress",
      "Ready to Ship",
      "Shipped",
      "Discard",
      "Done",
      "Invalid",
    ]);
    expect(
      orderOf(p, BASIC, (rows) =>
        rows.map((r) => r.id).filter((id) => id.startsWith("status.move:")),
      ),
    ).toEqual([...FLOW, "Shipped", "Discard", "Done", "Invalid"]);
  });

  it("moves only the status whose move is ticked", () => {
    const p = project(["M2", "M", "A", "B"]);
    const t = template(["A", "B", "M2", "M"]);
    expect(orderOf(p, t, () => [`status.move:${idOf(p, "M")}`])).toEqual([
      "M2",
      "A",
      "B",
      "M",
    ]);
  });

  it("adds a status after an unticked move where the table has its row", () => {
    const p = project(["A", "M", "B"]);
    const t = template(["A", "B", "M", "N"]);
    expect(orderOf(p, t, () => ["status.add:N"])).toEqual(["A", "M", "B", "N"]);
  });

  it("moves the upper of two swapped neighbours", () => {
    const p = project(["Backlog", "In Progress", "Next", "Done"]);
    const t = template(["Backlog", "Next", "In Progress", "Done"]);
    expect([...statusMovers(p.statuses, t)]).toEqual([idOf(p, "In Progress")]);
  });

  it("keeps each status the template lacks on the side of the line it is on", () => {
    // Sent and Mailed are open, yet below the line: their cards are cleared.
    const p = project(
      ["Open", "Waiting", "Closed", "Sent", "Mailed"],
      "Closed",
      ["Closed"],
    );
    const { line, above, below } = sidesOf(p, BASIC);
    expect(line).toBe("Shipped");
    expect(above).toEqual(expect.arrayContaining(["Open", "Waiting"]));
    expect(below).toEqual(expect.arrayContaining(["Closed", "Sent", "Mailed"]));
  });

  it("without a line, sides them by category, inside the template's order", () => {
    const p = project(
      ["Open", "Closed", "Archived", "Waiting", "Done", "Parked"],
      null,
      ["Closed", "Archived", "Done"],
    );
    const t = template(["Backlog", "Shipped", "Done"], "Shipped");
    const { line, above, below } = sidesOf(p, t);
    expect(line).toBe("Shipped");
    expect(above).toEqual(expect.arrayContaining(["Open", "Waiting"]));
    // Done follows Shipped as in the template, and Parked, after Done, too.
    expect(below).toEqual(expect.arrayContaining(["Done", "Parked"]));
  });

  it("keeps the line on its status as the status moves, drawn right above it", () => {
    const p = project(["A", "S", "B"], "S");
    const t = template(["A", "B", "S"], "S");
    const rows = rowsFor(p, t);
    const layout = applyLayout(p, t, rows);
    const s = idOf(p, "S");
    // No line row of its own: it only follows S.
    expect(rows.map((r) => r.id)).toEqual([`status.move:${s}`]);
    const to = layout.rows.findIndex(
      (r) => r.kind === "status" && r.key === s && r.place === "to",
    );
    expect(layout.rows[to - 1]).toMatchObject({
      kind: "line",
      place: "to",
      tick: `status.move:${s}`,
    });
    for (const selected of [[], [`status.move:${s}`]]) {
      expect(applyResult(layout, new Set(selected)).line).toBe(s);
    }
  });
});

describe("afterCell", () => {
  const cell = (place: LayoutRow["place"], ticked: boolean) =>
    afterCell(
      { kind: "status", key: 1, place, tick: "x" },
      new Set(ticked ? ["x"] : []),
    );

  it("keeps a status in place until it is deleted or moved away", () => {
    expect(cell("both", false)).toBe("solid");
    expect(cell("both", true)).toBe("empty");
    expect(cell("from", false)).toBe("solid");
    expect(cell("from", true)).toBe("empty");
  });

  it("shows where a status would go until its move or addition is ticked", () => {
    expect(cell("to", false)).toBe("shadow");
    expect(cell("to", true)).toBe("solid");
    expect(cell("added", false)).toBe("shadow");
    expect(cell("added", true)).toBe("solid");
  });

  it("keeps a status nothing can take away", () => {
    expect(
      afterCell(
        { kind: "status", key: 1, place: "both", tick: null },
        new Set(),
      ),
    ).toBe("solid");
  });
});
