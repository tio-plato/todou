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
    {
      shape: "a subgraph with no id of its own",
      source: [
        "flowchart TD",
        "  subgraph A",
        "    subgraph inner title",
        "      A --> C",
        "    end",
        "  end",
      ],
      error:
        'Nesting cycle: A inside "inner title" inside A. Move the lines in "inner title"\'s block that name A out of that block.',
    },
    {
      shape: "a line in a concurrent region",
      source: [
        "stateDiagram-v2",
        "  state A {",
        "    C --> D",
        "    --",
        "    A --> B",
        "  }",
      ],
      error:
        "Nesting cycle: A inside A. Move the lines in A's block that name A out of that block.",
    },
    {
      shape: "an edge with both ends on the cycle",
      source: [
        "flowchart TD",
        "  subgraph A",
        "    subgraph B",
        "      B --> A",
        "    end",
        "  end",
      ],
      error:
        "Nesting cycle: B inside A inside B. Move one of these out of its block: the lines in A's block that name B or the lines in B's block that name A.",
    },
    {
      shape: "an edge walking into the cycle",
      source: [
        "stateDiagram-v2",
        "  X --> C",
        "  state A {",
        "    state B {",
        "      A",
        "      C",
        "    }",
        "  }",
      ],
      error:
        "Nesting cycle: B inside A inside B. Move one of these out of its block: the lines in A's block that name B or the lines in B's block that name A.",
    },
    {
      shape: "an edge written outside the cycle",
      source: [
        "flowchart TD",
        "  subgraph A",
        "    subgraph B",
        "      A",
        "    end",
        "  end",
        "  B --> X",
      ],
      error:
        "Nesting cycle: B inside A inside B. Move one of these out of its block: the lines in A's block that name B or the lines in B's block that name A.",
    },
    {
      shape: "a cycle of three blocks",
      source: [
        "stateDiagram-v2",
        "  Y --> X",
        "  state A {",
        "    state B {",
        "      state C {",
        "        A",
        "        X",
        "      }",
        "    }",
        "  }",
      ],
      error:
        "Nesting cycle: C inside B inside A inside C. Move one of these out of its block: the lines in B's block that name C, the lines in A's block that name B, or the lines in C's block that name A.",
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
    {
      shape: "a self-loop on a cycle",
      source: [
        "classDiagram",
        "  namespace A {",
        "    class A",
        "  }",
        "  A --> A",
      ],
    },
    {
      shape: "concurrent regions",
      source: [
        "stateDiagram-v2",
        "  state A {",
        "    B --> C",
        "    --",
        "    D --> E",
        "  }",
        "  X --> A",
      ],
    },
  ])("draws $shape", async ({ source }) => {
    const result = await renderDiagram(source.join("\n"), PALETTE, "serif");
    expect(result.ok).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
