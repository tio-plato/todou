import { describe, expect, it } from "vitest";
import { lineAfterDeleting } from "../src/index.ts";

describe("lineAfterDeleting", () => {
  const order = ["Todo", "Doing", "Shipped", "Done", "Invalid"];

  it("moves a line in the middle to the status below it", () => {
    expect(lineAfterDeleting(order, "Shipped", new Set(["Shipped"]))).toBe(
      "Done",
    );
  });

  it("moves a line on the last status to the new last one", () => {
    expect(lineAfterDeleting(order, "Invalid", new Set(["Invalid"]))).toBe(
      "Done",
    );
  });

  it("skips a status below it that goes too", () => {
    expect(
      lineAfterDeleting(order, "Shipped", new Set(["Shipped", "Done"])),
    ).toBe("Invalid");
  });

  it("clears the line when no status is left", () => {
    expect(lineAfterDeleting(order, "Shipped", new Set(order))).toBeNull();
  });

  it("leaves the line alone when its status stays", () => {
    expect(lineAfterDeleting(order, "Shipped", new Set(["Todo", "Done"]))).toBe(
      "Shipped",
    );
  });
});
