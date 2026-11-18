import { describe, expect, it } from "vitest";
import {
  ProjectCreateInput,
  ProjectTemplateCreateInput,
  TemplateBody,
} from "../src/index.ts";

const status = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  category: "open",
  color: "#6b7280",
  chart_role: "remaining",
  ...extra,
});

const body = (statuses: unknown[], labels: unknown[] = []) => ({
  statuses,
  labels,
});

describe("TemplateBody", () => {
  it("allows one default status, not two", () => {
    expect(
      TemplateBody.safeParse(body([status("A", { is_default: true })])).success,
    ).toBe(true);
    expect(
      TemplateBody.safeParse(
        body([
          status("A", { is_default: true }),
          status("B", { is_default: true }),
        ]),
      ).success,
    ).toBe(false);
  });

  it("allows one block clear status, not two", () => {
    expect(
      TemplateBody.safeParse(
        body([
          status("A", { block_clear: true }),
          status("B", { block_clear: true }),
        ]),
      ).success,
    ).toBe(false);
  });

  it("stores status names canonical and compares them that way, case-sensitively", () => {
    const parsed = TemplateBody.parse(body([status("  In  Review ")]));
    expect(parsed.statuses[0]?.name).toBe("In Review");
    expect(
      TemplateBody.safeParse(body([status("Done"), status("Done ")])).success,
    ).toBe(false);
    expect(
      TemplateBody.safeParse(body([status("Done"), status("done")])).success,
    ).toBe(true);
  });

  it("refuses two labels that are one name once canonical", () => {
    expect(
      TemplateBody.safeParse(
        body(
          [status("A")],
          [
            { name: "a  b", color: "#ef4444" },
            { name: "a b", color: "#22c55e" },
          ],
        ),
      ).success,
    ).toBe(false);
  });

  it("needs at least one status", () => {
    expect(TemplateBody.safeParse(body([])).success).toBe(false);
  });
});

describe("ProjectTemplateCreateInput", () => {
  const valid = body([status("A")]);

  it("takes a body or a project, and refuses both or neither", () => {
    expect(
      ProjectTemplateCreateInput.safeParse({ name: "t", body: valid }).success,
    ).toBe(true);
    expect(
      ProjectTemplateCreateInput.safeParse({ name: "t", from_project: "todou" })
        .success,
    ).toBe(true);
    expect(
      ProjectTemplateCreateInput.safeParse({
        name: "t",
        body: valid,
        from_project: "todou",
      }).success,
    ).toBe(false);
    expect(ProjectTemplateCreateInput.safeParse({ name: "t" }).success).toBe(
      false,
    );
  });
});

describe("ProjectCreateInput", () => {
  it("refuses a template and a source project together", () => {
    const base = { slug: "alpha", name: "Alpha" };
    expect(
      ProjectCreateInput.safeParse({ ...base, template: "default" }).success,
    ).toBe(true);
    expect(
      ProjectCreateInput.safeParse({ ...base, from_project: "todou" }).success,
    ).toBe(true);
    expect(
      ProjectCreateInput.safeParse({
        ...base,
        template: 7,
        from_project: "todou",
      }).success,
    ).toBe(false);
  });
});
