import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoveLines } from "../src/components/settings/template-apply-lines.tsx";
import type { TableArrow } from "../src/lib/template-apply-table.ts";

/** The box a `data-at="left,top,width,height"` puts an element in. */
const at = (el: Element | null) => {
  const value = el?.getAttribute("data-at");
  if (!value) return null;
  const [left = 0, top = 0, width = 0, height = 0] = value
    .split(",")
    .map(Number);
  return new DOMRect(left, top, width, height);
};

/**
 * Each element where its `data-at` puts it, as a browser lays it out; the
 * drawing fills its table inside the table's 1px border.
 */
function stubRects() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this.localName === "svg") {
        const table = at(this.parentElement);
        if (table) {
          return new DOMRect(
            table.left + 1,
            table.top + 1,
            table.width - 2,
            table.height - 2,
          );
        }
      }
      return at(this) ?? new DOMRect();
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

const cell = (name: string, box: string, children?: ReactNode) => (
  <div data-cell={name} data-at={box}>
    {children}
  </div>
);

const arrow = (over: Partial<TableArrow>): TableArrow => ({
  kind: "move",
  from: 1,
  to: 0,
  tick: "status.line",
  ticked: true,
  on: true,
  start: "line",
  end: "line",
  lane: 0,
  ...over,
});

const drawing = (index: number) =>
  document.querySelector(`g[data-arrow="${index}"]`);

describe("MoveLines", () => {
  it("lights an arrow by its box, though it is left dashed", () => {
    stubRects();
    render(
      <div style={{ position: "relative" }} data-at="100,200,600,300">
        <div data-row="0">
          {cell(
            "before",
            "101,201,280,36",
            <span data-rule data-at="101,218,280,2" />,
          )}
          {cell(
            "mid",
            "381,201,80,36",
            <>
              <span data-tick="first" data-at="410,209,20,20" />
              <span data-tick="second" data-at="434,209,20,20" />
            </>,
          )}
          {cell(
            "after",
            "461,201,238,36",
            <span data-rule data-at="461,218,238,2" />,
          )}
        </div>
        <div data-row="1">
          {cell(
            "before",
            "101,237,280,36",
            <span data-rule data-at="101,254,280,2" />,
          )}
          {cell("mid", "381,237,80,36")}
          {cell(
            "after",
            "461,237,238,36",
            <span data-rule data-at="461,254,238,2" />,
          )}
        </div>
        <MoveLines
          arrows={[
            arrow({ tick: "first", on: true, ticked: false, lane: 0 }),
            arrow({ tick: "second", on: false, ticked: false, lane: 1 }),
          ]}
          lanes={2}
        />
      </div>,
    );
    expect(drawing(0)?.getAttribute("data-lit")).toBe("true");
    expect(
      drawing(0)?.querySelector("path")?.getAttribute("stroke-dasharray"),
    ).toBe("4 3");
    expect(drawing(1)?.getAttribute("data-lit")).toBeNull();
  });
});
