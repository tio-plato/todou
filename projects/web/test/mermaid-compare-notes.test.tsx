import { act, waitFor } from "@testing-library/react";
import type { SpecCommentItem } from "@todou/shared";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnnotatedMarkdown,
  type DisplayedAnnotation,
} from "../src/components/spec/annotated-markdown.tsx";
import { renderWithProviders } from "./render.tsx";

// pierre draws code in a shadow root happy-dom cannot lay out; this one puts
// a row per line in it, as pierre does, so a side drawn as source really has
// rows of the current version in the block.
vi.mock("@pierre/diffs/react", () => {
  const draw = (node: HTMLElement | null, contents: string) => {
    if (node === null || node.querySelector("diffs-container") !== null) return;
    const host = document.createElement("diffs-container");
    const shadow = host.attachShadow({ mode: "open" });
    contents.split("\n").forEach((text, i) => {
      const row = document.createElement("div");
      row.dataset.line = String(i + 1);
      row.textContent = text;
      shadow.append(row);
    });
    node.append(host);
  };
  return {
    CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
      <div ref={(node) => draw(node, items[0]?.file.contents ?? "")} />
    ),
    MultiFileDiff: () => null,
    WorkerPoolContextProvider: ({ children }: { children: ReactNode }) =>
      children,
    useWorkerPool: () => undefined,
  };
});

// mermaid cannot lay anything out under happy-dom (no getBBox), so the
// renderer is the seam: a source with no answer here does not parse.
type Result =
  | { ok: true; svg: string; width: number; height: number }
  | { ok: false; error: string };
const answers = vi.hoisted(() => new Map<string, Result>());
vi.mock("../src/lib/mermaid.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mermaid.ts")>()),
  renderDiagram: vi.fn(
    async (source: string) =>
      answers.get(source) ?? { ok: false, error: "Parse error on line 2" },
  ),
}));

beforeEach(() => answers.clear());

const ITEM: SpecCommentItem = {
  comment_id: 1,
  author: {
    id: 1,
    login: "bot-one",
    display_name: "Bot One",
    kind: "machine",
    avatar_url: null,
    owner: null,
  },
  created_at: "2026-01-06T00:00:00Z",
  body: "look here",
  anchor: {
    path: "plan.md",
    version: 1,
    line_start: 1,
    line_end: 1,
    col_start: null,
    col_end: null,
    quote: "",
  },
  resolved: null,
  outdated: false,
  current_line_start: null,
  current_line_end: null,
};

/** A comment on whole lines `start`–`end`, or on columns of line `start`. */
function comment(
  start: number,
  end = start,
  colStart: number | null = null,
  colEnd: number | null = null,
): DisplayedAnnotation {
  return {
    key: `c${start}-${end}-${colStart}`,
    kind: "comment",
    item: ITEM,
    start,
    end,
    colStart,
    colEnd,
  };
}

const drawn = (text: string): Result => ({
  ok: true,
  svg: `<svg viewBox="0 0 100 40"><text>${text}</text></svg>`,
  width: 100,
  height: 40,
});

const OLD = "flowchart LR\n  A[Start] --> B[End]";
const NEW = "flowchart LR\n  A[Start] --> B[Finish]";
// v1: lines 5-8 are the block, 7 its edge; v2: lines 3-6, 5 its edge.
const BEFORE = `Intro.\n\nExtra paragraph.\n\n\`\`\`mermaid\n${OLD}\n\`\`\`\n`;
const AFTER = `Intro.\n\n\`\`\`mermaid\n${NEW}\n\`\`\`\n`;
// The same block opening a list item, in both versions.
const BEFORE_ITEM = `Intro.\n\nExtra paragraph.\n\n- \`\`\`mermaid\n  flowchart LR\n    A[Start] --> B[End]\n  \`\`\`\n`;
const AFTER_ITEM = `Intro.\n\n- \`\`\`mermaid\n  flowchart LR\n    A[Start] --> B[Finish]\n  \`\`\`\n`;
// The block in place, a paragraph after it losing a word: v1 lines 3-6 are
// the block, 8 the paragraph.
const BEFORE_TAIL = `Intro.\n\n\`\`\`mermaid\n${OLD}\n\`\`\`\n\nTail old word.\n`;
const AFTER_TAIL = `Intro.\n\n\`\`\`mermaid\n${NEW}\n\`\`\`\n\nTail word.\n`;

/**
 * The comparison of `before` with `after`, once `diagrams` diagrams and, with
 * `sourceRows`, the rows of a side drawn as source are in, and a reader of
 * the comment count on each of its chips. A v2 comment on the block's opening
 * fence names the block's chip; the v1 `notes` are under test, by default
 * one on the edge the block changed and one on `Intro.`, in no code block.
 */
async function renderCompare(
  before: string,
  after: string,
  diagrams: number,
  { sourceRows = false, notes = [comment(7), comment(1)] } = {},
): Promise<() => number[]> {
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={after}
      baselineBody={before}
      annotations={[comment(3, 3, 1, 3)]}
      baselineAnnotations={notes}
      onStage={() => {}}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
  );
  await waitFor(() =>
    expect(
      view.container.querySelectorAll(".mermaid-compare-diagram svg"),
    ).toHaveLength(diagrams),
  );
  if (sourceRows) {
    await waitFor(() =>
      expect(
        view.container
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelector("[data-line]"),
      ).not.toBeNull(),
    );
  }
  // happy-dom's ResizeObserver never calls back: without this the chips
  // are those of the layout run before anything was drawn.
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
  });
  // The count alone: how a chip spells the rest of its name is not at issue.
  return () =>
    view
      .queryAllByRole("button", { name: /^\d+ comment/ })
      .map((chip) =>
        Number(/^\d+/.exec(chip.getAttribute("aria-label") ?? "")?.[0]),
      );
}

describe("baseline notes on a code block drawn without its baseline rows", () => {
  it("hangs a baseline note on a changed diagram drawn on both sides", async () => {
    answers.set(OLD, drawn("End"));
    answers.set(NEW, drawn("Finish"));
    const counts = await renderCompare(BEFORE, AFTER, 2);
    await waitFor(() => expect(counts()).toEqual([2]));
  });

  it("hangs it there when the new version does not parse", async () => {
    answers.set(OLD, drawn("End"));
    const counts = await renderCompare(BEFORE, AFTER, 1, { sourceRows: true });
    await waitFor(() => expect(counts()).toEqual([2]));
  });

  it("hangs it on the code block, not the list item it opens", async () => {
    answers.set(OLD, drawn("End"));
    answers.set(NEW, drawn("Finish"));
    const counts = await renderCompare(BEFORE_ITEM, AFTER_ITEM, 2);
    await waitFor(() => expect(counts()).toEqual([2]));
  });

  it("leaves a note that also reaches removed text where that text is", async () => {
    // Paragraphs well below the block, so that their chips are not drawn
    // over the block's, which would join them.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return DOMRect.fromRect({ y: this.tagName === "P" ? 200 : 0 });
      },
    );
    try {
      answers.set(OLD, drawn("End"));
      answers.set(NEW, drawn("Finish"));
      const counts = await renderCompare(BEFORE_TAIL, AFTER_TAIL, 2, {
        notes: [comment(3, 8)],
      });
      await waitFor(() => expect(counts()).toEqual([1, 1]));
    } finally {
      vi.restoreAllMocks();
    }
  });
});
