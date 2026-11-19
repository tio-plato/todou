import { render } from "@testing-library/react";
import type { Label } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { LabelRows } from "../src/components/issue/label-chip.tsx";

// Sorted by name, as a template holds them; the ids say nothing about rows.
const labels: Label[] = [
  { id: 5, name: "area:cli", color: "#0ea5e9" },
  { id: 3, name: "area:web", color: "#3b82f6" },
  { id: 1, name: "kind:bug", color: "#ef4444" },
  { id: 4, name: "needs-brainstorm", color: "#a855f7" },
  { id: 2, name: "urgent", color: "#f97316" },
];

describe("LabelRows", () => {
  it("puts each prefix on a row of its own, and the unprefixed labels on one last row", () => {
    const { container } = render(<LabelRows labels={labels} />);
    const rows = [...(container.firstElementChild?.children ?? [])];
    expect(
      rows.map((row) =>
        [...row.querySelectorAll("[title]")].map((chip) =>
          chip.getAttribute("title"),
        ),
      ),
    ).toEqual([
      ["area:cli", "area:web"],
      ["kind:bug"],
      ["needs-brainstorm", "urgent"],
    ]);
    // A prefix is written once, before the values that share it.
    expect(rows.map((row) => row.textContent)).toEqual([
      "area:cliweb",
      "kind:bug",
      "needs-brainstormurgent",
    ]);
  });
});
