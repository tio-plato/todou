import mermaid from "mermaid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DiagramPalette, renderDiagram } from "../src/lib/mermaid.ts";

// The real mermaid parses every source here, so the nesting the check reads
// is the one mermaid itself derives. Only drawing is stubbed: ELK is what
// never returns on these diagrams, so a check that stops catching one fails
// here instead of hanging the worker.
const render = vi.spyOn(mermaid, "render").mockImplementation(async () => ({
  svg: '<svg viewBox="0 0 10 10"></svg>',
  diagramType: "stub",
}));

const PALETTE: DiagramPalette = {
  dark: false,
  background: "#ffffff",
  foreground: "#000000",
  muted: "#eeeeee",
  mutedForeground: "#666666",
  border: "#dddddd",
};

beforeEach(() => {
  render.mockClear();
});

describe("renderDiagram on a nesting cycle", () => {
  it.each([
    {
      shape: "a state's line to its own child",
      source: ["stateDiagram-v2", "  state A {", "    A --> B", "  }"],
      error:
        "Nesting cycle: A inside A. Move the lines in A's block that name A out of that block.",
    },
    {
      shape: "a subgraph named in its child",
      source: [
        "flowchart TD",
        "  subgraph A",
        "    subgraph B",
        "      A --> C",
        "    end",
        "  end",
      ],
      error:
        "Nesting cycle: A inside B inside A. Move the lines in B's block that name A out of that block.",
    },
    {
      shape: "an edge into the cycle's subtree",
      source: [
        "stateDiagram-v2",
        "  X --> B",
        "  state A {",
        "    A",
        "    B",
        "  }",
      ],
      error:
        "Nesting cycle: A inside A. Move the lines in A's block that name A out of that block.",
    },
    {
      shape: "a class named like its namespace",
      source: [
        "classDiagram",
        "  namespace A {",
        "    class A",
        "  }",
        "  A --> B",
      ],
      error:
        "Nesting cycle: A inside A. Move the lines in A's block that name A out of that block.",
    },
    {
      shape: "an edge ending on the cycle",
      source: [
        "stateDiagram-v2",
        "  state A {",
        "    state B {",
        "      C --> A",
        "    }",
        "  }",
      ],
      error:
        "Nesting cycle: A inside B inside A. Move the lines in B's block that name A out of that block.",
    },
  ])("refuses $shape before drawing it", async ({ source, error }) => {
    const result = await renderDiagram(source.join("\n"), PALETTE, "serif");
    expect(result).toEqual({ ok: false, error });
    expect(render).not.toHaveBeenCalled();
    expect(document.body.childElementCount).toBe(0);
  });

  it.each([
    {
      shape: "a composite state",
      source: [
        "stateDiagram-v2",
        "  state A {",
        "    B --> C",
        "  }",
        "  A --> D",
      ],
    },
    {
      shape: "a cycle no edge touches",
      source: ["classDiagram", "  namespace A {", "    class A", "  }"],
    },
  ])("draws $shape", async ({ source }) => {
    const result = await renderDiagram(source.join("\n"), PALETTE, "serif");
    expect(result.ok).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
