import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { SpecComments, SpecFiles, SpecInfo } from "@todou/shared";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { testQueryClient } from "./render.tsx";

/** Every options object the mocked `File` was handed, in render order. */
const fileOptions = vi.hoisted(() => [] as unknown[]);

type MockRow = { line: number; alt?: number; text: string; type: string };

// The real diff renders in a shadow root happy-dom cannot lay out. These draw
// what the page reads back: a `[data-line]` row per line, typed as pierre
// types it, and the annotations it was handed. The rows are light DOM; what
// changes inside a shadow root is the source-selection unit's to cover.
vi.mock("@pierre/diffs/react", async () => {
  const { diffLines } = await import("diff");
  const lines = (text: string) => text.replace(/\n$/, "").split("\n");
  const Rows = ({ rows }: { rows: MockRow[] }) => (
    <code>
      {rows.map((row) => (
        <div
          key={`${row.type}-${row.line}`}
          data-line={row.line}
          data-alt-line={row.alt}
          data-line-type={row.type}
        >
          <span>{row.text}</span>
        </div>
      ))}
    </code>
  );
  return {
    MultiFileDiff: ({
      oldFile,
      newFile,
      lineAnnotations,
      renderAnnotation,
    }: {
      oldFile: { contents: string };
      newFile: { contents: string };
      lineAnnotations?: Array<{
        side: string;
        lineNumber: number;
        metadata: unknown;
      }>;
      renderAnnotation?: (a: { metadata: unknown }) => ReactNode;
    }) => {
      const rows: MockRow[] = [];
      let old = 1;
      let neu = 1;
      for (const part of diffLines(oldFile.contents, newFile.contents)) {
        for (const text of lines(part.value)) {
          if (part.removed) {
            rows.push({ line: old++, text, type: "change-deletion" });
          } else if (part.added) {
            rows.push({ line: neu++, text, type: "change-addition" });
          } else {
            rows.push({ line: neu++, alt: old++, text, type: "context" });
          }
        }
      }
      return (
        <div data-testid="diff">
          <Rows rows={rows} />
          {(lineAnnotations ?? []).map((annotation, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: several annotations can share a line
              key={index}
              data-testid="diff-annotation"
              data-side={annotation.side}
              data-annotation-line={annotation.lineNumber}
            >
              {renderAnnotation?.(annotation)}
            </div>
          ))}
        </div>
      );
    },
    File: ({
      file,
      options,
      lineAnnotations,
      renderAnnotation,
    }: {
      file: { contents: string };
      options: unknown;
      lineAnnotations?: Array<{ lineNumber: number; metadata: unknown }>;
      renderAnnotation?: (a: { metadata: unknown }) => ReactNode;
    }) => {
      fileOptions.push(options);
      return (
        <div data-testid="file-view">
          <Rows
            rows={lines(file.contents).map((text, i) => ({
              line: i + 1,
              text,
              type: "context",
            }))}
          />
          {(lineAnnotations ?? []).map((annotation, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: several annotations can share a line
              key={index}
              data-testid="file-annotation"
              data-annotation-line={annotation.lineNumber}
            >
              {renderAnnotation?.(annotation)}
            </div>
          ))}
        </div>
      );
    },
    CodeView: () => null,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  fileOptions.length = 0;
  window.getSelection()?.removeAllRanges();
});

const AUTHOR = {
  id: 1,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

/**
 * Five versions carrying every class the source stack has to draw:
 * v1→v2 renames one file untouched and one with an edit, removes a file and
 * adds an empty one; v2→v3 changes a single file; v3→v4 removes the empty
 * one; v5 repeats v4 byte for byte.
 */
const V2: Record<string, string> = {
  "also-keep.md": "steady\n",
  "drifted.md": "alpha\nbeta\ngamma\nomega\n",
  "empty.md": "",
  "keep.md": "keep one\n",
  "new-name.md": "moved body\nline two\n",
};
const V3: Record<string, string> = { ...V2, "keep.md": "keep two\n" };
const V4: Record<string, string> = Object.fromEntries(
  Object.entries(V3).filter(([path]) => path !== "empty.md"),
);

const BODIES: Record<number, Record<string, string>> = {
  1: {
    "also-keep.md": "steady\n",
    "doomed.md": "doomed\n",
    "drift.md": "alpha\nbeta\ngamma\ndelta\n",
    "keep.md": "keep one\n",
    "old-name.md": "moved body\nline two\n",
  },
  2: V2,
  3: V3,
  4: V4,
  5: V4,
};

const comment = (
  path: string,
  version: number,
  line: number,
  body: string,
  end = line,
) => ({
  comment_id: version * 100 + line,
  author: AUTHOR,
  created_at: "2026-01-06T00:00:00Z",
  body,
  anchor: {
    path,
    version,
    line_start: line,
    line_end: end,
    col_start: null,
    col_end: null,
    quote: "",
  },
  resolved: null,
  outdated: false,
  current_line_start: line,
  current_line_end: end,
});

function mockSpec(
  items: SpecComments["items"] = [],
  bodies: Record<number, Record<string, string>> = BODIES,
) {
  const versions = Object.keys(bodies).map(Number);
  const current = Math.max(...versions);
  const info: SpecInfo = {
    current_version: current,
    current_version_cursor: `c${current}`,
    review_status: "unreviewed",
    unresolved_comments: 0,
    unresolved_carried_comments: 0,
    files: Object.entries(bodies[current] ?? {}).map(([path, body]) => ({
      path,
      size: body.length,
    })),
    versions: versions.map((number) => ({
      number,
      author: AUTHOR,
      message: `v${number}`,
      created_at: `2026-01-0${number}T00:00:00Z`,
    })),
  };
  vi.spyOn(api, "getSpec").mockResolvedValue(info);
  vi.spyOn(api, "getSpecFiles").mockImplementation(
    (_slug, _number, version): Promise<SpecFiles> => {
      const v = version ?? current;
      return Promise.resolve({
        version: v,
        files: Object.entries(bodies[v] ?? {}).map(([path, body]) => ({
          path,
          body,
          size: body.length,
        })),
      });
    },
  );
  const comments: SpecComments = { current_version: current, items };
  vi.spyOn(api, "getSpecComments").mockResolvedValue(comments);
  vi.spyOn(api, "getReferenceConfig").mockResolvedValue({
    format: { prefix: "T-", history: [] },
    autolinks: [],
  });
}

function renderSpecView(search: string) {
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
  });
  const specRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number/spec",
    component: SpecViewPage,
    validateSearch: parseSpecSearch,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([issueRoute, specRoute]),
      ]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/projects/demo/issues/1/spec${search}`],
    }),
    defaultPendingMs: 0,
  });
  const client = testQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

/** The stack has rendered once the first entry box is on screen. */
async function stack(search: string) {
  const view = renderSpecView(search);
  await view.findByRole("button", { name: /finish review/i });
  await waitFor(() =>
    expect(
      view.container.querySelectorAll("[data-file-diff],[data-file-unchanged]")
        .length,
    ).toBeGreaterThan(0),
  );
  return view;
}

const marks = (view: { container: HTMLElement }, attribute: string) =>
  [...view.container.querySelectorAll(`[${attribute}]`)].map((el) =>
    el.getAttribute(attribute),
  );

describe("source stack draws every file (T-203)", () => {
  it("gives an untouched file a foldable block that loads its source", async () => {
    mockSpec();
    const view = await stack("?v=2&compare=1");
    expect(marks(view, "data-file-unchanged")).toEqual([
      "also-keep.md",
      "keep.md",
    ]);
    expect(view.getAllByText(/unchanged since v1/)).toHaveLength(2);
    expect(view.queryAllByTestId("file-view")).toHaveLength(0);

    fireEvent.click(view.getAllByRole("button", { name: /show file/ })[0]!);
    await waitFor(() =>
      expect(view.getAllByTestId("file-view")).toHaveLength(1),
    );
  });

  it("unfolds the file a link points at", async () => {
    mockSpec();
    const view = await stack("?v=2&compare=1&file=keep.md");
    await waitFor(() =>
      expect(view.getAllByTestId("file-view")).toHaveLength(1),
    );
  });

  it("carries an unfolded file's comments from both versions", async () => {
    mockSpec([
      comment("keep.md", 1, 1, "was this line always here?"),
      comment("keep.md", 2, 1, "yes, since v1"),
      comment("also-keep.md", 2, 1, "belongs to the other block"),
    ]);
    const view = await stack("?v=2&compare=1&file=keep.md");
    const block = view.container.querySelector(
      '[data-file-unchanged="keep.md"]',
    ) as HTMLElement;
    await waitFor(() =>
      expect(
        block.querySelectorAll('[data-testid="file-annotation"]'),
      ).toHaveLength(2),
    );
    expect(block.textContent).toContain("was this line always here?");
    expect(block.textContent).toContain("yes, since v1");
    expect(block.textContent).not.toContain("belongs to the other block");
  });

  // Card by card, not block by block: both carry the same author, so a
  // block-wide query would stay satisfied by whichever card kept its link
  // (T-391).
  it("links each annotation's author to their page", async () => {
    mockSpec([
      comment("keep.md", 1, 1, "was this line always here?"),
      comment("keep.md", 2, 1, "yes, since v1"),
    ]);
    const view = await stack("?v=2&compare=1&file=keep.md");
    const block = view.container.querySelector(
      '[data-file-unchanged="keep.md"]',
    ) as HTMLElement;
    const cards = await waitFor(() => {
      const els = block.querySelectorAll('[data-testid="file-annotation"]');
      expect(els).toHaveLength(2);
      return [...els];
    });

    for (const card of cards) {
      expect(
        [...card.querySelectorAll('a[href^="/users/"]')].map((a) =>
          a.getAttribute("href"),
        ),
      ).toEqual(["/users/bot-one"]);
    }
  });

  // A comment anchored to the file rather than to any line: the rendered
  // view gives it its own section, and that section is the only place the
  // reader meets its author (T-391).
  it("links the author of a comment with no line to sit on", async () => {
    const fileLevel = comment("keep.md", 2, 1, "about the file as a whole");
    mockSpec([
      {
        ...fileLevel,
        anchor: { ...fileLevel.anchor, line_start: null, line_end: null },
        current_line_start: null,
        current_line_end: null,
      },
    ]);
    const view = renderSpecView("?v=2&view=rendered&file=keep.md");
    const section = (await view.findByText("File comments"))
      .parentElement as HTMLElement;

    expect(
      [...section.querySelectorAll('a[href^="/users/"]')].map((a) =>
        a.getAttribute("href"),
      ),
    ).toEqual(["/users/bot-one"]);
  });

  it("keeps ↑↓ on the differing files only", async () => {
    mockSpec();
    // v2→v3 touches keep.md and nothing else; four blocks sit around it.
    const view = await stack("?v=3&compare=2");
    expect(marks(view, "data-file-diff")).toEqual(["keep.md"]);
    expect(marks(view, "data-file-unchanged")).toHaveLength(4);
    const next = view.getByRole("button", { name: /^next / });
    expect(next.hasAttribute("disabled")).toBe(true);
    expect(next.getAttribute("aria-label")).toContain("Only one file differs");
  });

  it("states an empty file's arrival and departure instead of dropping it", async () => {
    mockSpec();
    const added = await stack("?v=2&compare=1");
    expect(added.getByText(/Empty file — added in v2\./)).toBeTruthy();
    expect(added.queryByText(/are identical/)).toBeNull();
    added.unmount();

    const removed = await stack("?v=4&compare=3");
    expect(removed.getByText(/Empty file — removed in v4\./)).toBeTruthy();
    expect(removed.queryByText(/are identical/)).toBeNull();
  });

  it("still says two identical versions are identical, blocks and all", async () => {
    mockSpec();
    const view = await stack("?v=5&compare=4");
    expect(view.getByText("v4 and v5 are identical.")).toBeTruthy();
    expect(marks(view, "data-file-diff")).toHaveLength(0);
    expect(marks(view, "data-file-unchanged")).toHaveLength(4);
  });
});

describe("rename detection on the spec page (T-203)", () => {
  it("draws a pure rename as one entry and drops the old rail row", async () => {
    mockSpec();
    const view = await stack("?v=2&compare=1");
    expect(marks(view, "data-file-diff")).toEqual([
      "doomed.md",
      "drifted.md",
      "empty.md",
      "new-name.md",
    ]);
    expect(view.getByText(/renamed from old-name\.md/)).toBeTruthy();
    const rail = view
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.includes("file="));
    expect(rail.some((href) => href.includes("new-name.md"))).toBe(true);
    expect(rail.some((href) => href.includes("old-name.md"))).toBe(false);
  });

  it("keeps a renamed file's edits as a diff under both paths", async () => {
    mockSpec();
    const view = await stack("?v=2&compare=1");
    const entry = view.container.querySelector(
      '[data-file-diff="drifted.md"]',
    ) as HTMLElement;
    expect(entry.textContent).toContain("drift.md");
    expect(entry.textContent).toContain("drifted.md");
    expect(entry.querySelector('[data-testid="diff"]')).toBeTruthy();
  });

  it("reads a renamed file against its old path in the rendered view", async () => {
    mockSpec();
    const view = renderSpecView("?v=2&file=drifted.md&compare=1&view=rendered");
    await view.findByRole("button", { name: /finish review/i });
    await view.findByText(/renamed from drift\.md/);
    // The baseline followed the old path, so the edit washes up as a change
    // rather than the whole file reading as new.
    await waitFor(() =>
      expect(
        view.container.querySelectorAll(".spec-changed, .spec-ins-block")
          .length,
      ).toBeGreaterThan(0),
    );
  });
});

describe("the paths out of a removed file (T-203)", () => {
  it("opens the source diff when compare has fallen behind the version", async () => {
    mockSpec();
    const view = await stack("?v=2&compare=2&file=doomed.md");
    expect(view.queryByText(/was removed in v2/)).toBeNull();
    expect(marks(view, "data-file-diff")).toContain("doomed.md");
  });

  it("still hands a removed file to the notice in the rendered view", async () => {
    mockSpec();
    const view = renderSpecView("?v=2&file=doomed.md");
    await view.findByRole("button", { name: /finish review/i });
    await view.findByText(/was removed in v2/);
    expect(
      view
        .getByRole("link", { name: /open the source diff/i })
        .getAttribute("href"),
    ).toBe("/projects/demo/issues/1/spec?file=doomed.md&v=2&compare=1");
  });

  it("drops the orphaned file when comparing is switched off there", async () => {
    mockSpec();
    const view = renderSpecView("?v=2&file=doomed.md");
    await view.findByRole("button", { name: /finish review/i });
    await view.findByText(/was removed in v2/);
    fireEvent.click(
      screen.getByRole("button", { name: /turn comparing off$/i }),
    );
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({ v: 2 }),
    );
    expect(view.queryByText(/File not found/)).toBeNull();
  });
});

/** Select `[from, to)` of one row's text, the way a reader's drag would. */
function selectInRow(row: Element, from: number, to: number) {
  const text = row.querySelector("span")?.firstChild;
  if (!text) throw new Error("no text in the row");
  const range = document.createRange();
  range.setStart(text, from);
  range.setEnd(text, to);
  const selection = window.getSelection();
  if (!selection) throw new Error("no selection support");
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * One version's whole source, which no URL opens: v1 has nothing to compare
 * against, and "source" while not comparing is the reader's session stance.
 */
async function singleSource(file: string) {
  const view = renderSpecView(`?v=1&file=${file}`);
  await view.findByRole("button", { name: /finish review/i });
  fireEvent.click(await view.findByRole("button", { name: "source" }));
  await view.findByTestId("file-view");
  return view;
}

describe("selecting text in the source view", () => {
  it("offers the selected words and stages them with their quote", async () => {
    mockSpec();
    const view = await singleSource("drift.md");
    const row = await waitFor(() => {
      const el = view.container.querySelector(
        '[data-testid="file-view"] [data-line="2"]',
      );
      if (el === null) throw new Error("not drawn");
      return el;
    });
    // drift.md v1 line 2 is "beta"; "eta" is columns 2 through 4.
    selectInRow(row, 1, 4);
    fireEvent.click(await view.findByText(/Comment L2:2–4/));
    expect(await view.findByText("L2:2–4 · v1")).toBeTruthy();
    expect(view.getByText("eta", { selector: "div" })).toBeTruthy();
  });

  it("offers it in a file unfolded in the source diff", async () => {
    mockSpec();
    const view = renderSpecView("?v=2&view=source&file=new-name.md");
    const row = await waitFor(() => {
      const el = view.container.querySelector(
        '[data-testid="file-view"] [data-line="2"]',
      );
      if (el === null) throw new Error("not drawn");
      return el;
    });
    // "line two": the word "two" is columns 6 through 8 of line 2.
    selectInRow(row, 5, 8);
    fireEvent.click(await view.findByText(/Comment L2:6–8/));
    expect(await view.findByText("L2:6–8 · v2")).toBeTruthy();
    expect(view.getByText("two", { selector: "div" })).toBeTruthy();
  });

  it("anchors a deletion's words to the baseline", async () => {
    mockSpec();
    const view = await stack("?v=2&compare=1");
    const row = await waitFor(() => {
      const el = view.container.querySelector(
        '[data-file-diff="drifted.md"] [data-line-type="change-deletion"]',
      );
      if (el === null) throw new Error("not drawn");
      return el;
    });
    // drift.md in v1 ends "delta"; "elt" is columns 2 through 4 of line 4.
    selectInRow(row, 1, 4);
    fireEvent.click(await view.findByText(/Comment L4:2–4/));
    const label = await view.findByText("L4:2–4 · v1");
    // The composer's header names the file the anchor lives in.
    expect(label.parentElement?.textContent).toContain("drift.md");
    expect(view.getByText("elt", { selector: "div" })).toBeTruthy();
  });

  it("keeps pierre's options when the page re-renders around the file", async () => {
    mockSpec();
    const view = await singleSource("drift.md");
    await waitFor(() => expect(fileOptions.length).toBeGreaterThan(0));
    const before = fileOptions.at(-1);
    const drawn = fileOptions.length;
    // A refetch that brings something new, as a reviewer elsewhere would.
    vi.spyOn(api, "getSpecComments").mockResolvedValue({
      current_version: 5,
      items: [comment("keep.md", 2, 1, "elsewhere")],
    });
    await act(() =>
      view.client.invalidateQueries({
        queryKey: ["spec", "demo", 1, "comments"],
      }),
    );
    await waitFor(() => expect(fileOptions.length).toBeGreaterThan(drawn));
    expect(fileOptions.at(-1)).toBe(before);
  });
});

const DRAFTS_KEY = "todou-spec-review:demo:1";

function stageDraft(
  id: string,
  path: string,
  version: number,
  line: number,
  body: string,
  end = line,
) {
  const stored = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "[]");
  stored.push({
    id,
    anchor: {
      path,
      version,
      line_start: line,
      line_end: end,
      col_start: null,
      col_end: null,
    },
    quote: "",
    body,
  });
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(stored));
  // As another tab's write arrives: the drafts module drops what it cached
  // for this bucket in an earlier test.
  window.dispatchEvent(new StorageEvent("storage", { key: DRAFTS_KEY }));
}

describe("staged drafts in the source view", () => {
  it("hangs a draft under its line, and Discard takes it away", async () => {
    stageDraft("d1", "drift.md", 1, 2, "say it plainer");
    mockSpec();
    const view = await singleSource("drift.md");
    const note = await waitFor(() => {
      const el = view.container.querySelector(
        '[data-testid="file-annotation"][data-annotation-line="2"]',
      );
      if (el === null) throw new Error("no draft drawn");
      return el as HTMLElement;
    });
    expect(note.textContent).toContain("say it plainer");
    expect(note.textContent).toContain("Edit");
    fireEvent.click(
      [...note.querySelectorAll("button")].find(
        (button) => button.textContent === "Discard",
      ) as HTMLElement,
    );
    await waitFor(() => expect(view.queryByText("say it plainer")).toBeNull());
    expect(JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "[]")).toEqual([]);
  });

  it("hangs a baseline draft on the old side and a new one on the new", async () => {
    stageDraft("d1", "drift.md", 1, 4, "why drop delta?");
    stageDraft("d2", "drifted.md", 2, 4, "omega reads well");
    mockSpec();
    const view = await stack("?v=2&compare=1");
    const entry = view.container.querySelector(
      '[data-file-diff="drifted.md"]',
    ) as HTMLElement;
    const notes = await waitFor(() => {
      const els = entry.querySelectorAll('[data-testid="diff-annotation"]');
      expect(els).toHaveLength(2);
      return [...els];
    });
    const sideOf = (text: string) =>
      notes
        .find((el) => el.textContent?.includes(text))
        ?.getAttribute("data-side");
    expect(sideOf("why drop delta?")).toBe("deletions");
    expect(sideOf("omega reads well")).toBe("additions");
  });
});

/** The line each note under `selector` hangs on, by the text it carries. */
async function hungLines(
  view: { container: HTMLElement },
  selector: string,
  texts: string[],
) {
  return waitFor(() => {
    const notes = [...view.container.querySelectorAll(selector)];
    return texts.map((text) => {
      const note = notes.find((el) => el.textContent?.includes(text));
      if (note === undefined) throw new Error(`${text} not drawn`);
      return note.getAttribute("data-annotation-line");
    });
  });
}

/**
 * Twenty lines, two of them edited sixteen lines apart: pierre's hunks cover
 * lines 1–6 and 15–20, and the eight unchanged lines between them collapse.
 */
const LONG_V1 = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const LONG_BODIES: Record<number, Record<string, string>> = {
  1: { "long.md": `${LONG_V1.join("\n")}\n` },
  2: {
    "long.md": `${LONG_V1.map((text, i) =>
      i === 1 ? "line two" : i === 18 ? "line nineteen" : text,
    ).join("\n")}\n`,
  },
};

describe("notes over several lines hang under their last line", () => {
  it("in one version's source", async () => {
    stageDraft("d1", "drift.md", 1, 1, "three lines here", 3);
    mockSpec([comment("drift.md", 1, 2, "and these three", 4)]);
    const view = await singleSource("drift.md");
    expect(
      await hungLines(view, '[data-testid="file-annotation"]', [
        "three lines here",
        "and these three",
      ]),
    ).toEqual(["3", "4"]);
  });

  it("in the source diff, and in a file unfolded there", async () => {
    stageDraft("d1", "drifted.md", 2, 1, "these kept lines", 3);
    stageDraft("d2", "new-name.md", 2, 1, "the whole move", 2);
    mockSpec();
    const view = await stack("?v=2&compare=1&file=new-name.md");
    expect(
      await hungLines(view, '[data-testid="diff-annotation"]', [
        "these kept lines",
      ]),
    ).toEqual(["3"]);
    expect(
      await hungLines(view, '[data-testid="file-annotation"]', [
        "the whole move",
      ]),
    ).toEqual(["2"]);
  });

  it("on the last line the source diff shows when the end is collapsed", async () => {
    // Lines 5–10 run from the first hunk into the collapsed 7–14.
    stageDraft("d1", "long.md", 2, 5, "into the fold", 10);
    mockSpec([], LONG_BODIES);
    const view = await stack("?v=2&compare=1");
    expect(
      await hungLines(view, '[data-testid="diff-annotation"]', [
        "into the fold",
      ]),
    ).toEqual(["6"]);
  });
});

/** A stand-in for the browser's `Highlight`: the ranges it was built from. */
class FakeHighlight {
  ranges: Range[];
  priority = 0;
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
  add(range: Range): this {
    this.ranges.push(range);
    return this;
  }
}

describe("code highlights in the source view", () => {
  let registry = new Map<string, FakeHighlight>();
  beforeEach(() => {
    registry = new Map();
    vi.stubGlobal("Highlight", FakeHighlight);
    vi.stubGlobal(
      "CSS",
      Object.assign(Object.create(globalThis.CSS), { highlights: registry }),
    );
  });
  afterEach(() => {
    // Unmounted first, while the API is still there to take the ranges back.
    cleanup();
    vi.unstubAllGlobals();
  });

  const withColumns = (
    item: ReturnType<typeof comment>,
    colStart: number,
    colEnd: number,
  ) => ({
    ...item,
    anchor: { ...item.anchor, col_start: colStart, col_end: colEnd },
  });

  it("paints a column comment on the version it is anchored to", async () => {
    // drift.md v1 line 2 is "beta"; columns 2–4 are "eta".
    mockSpec([withColumns(comment("drift.md", 1, 2, "why beta?"), 2, 4)]);
    await singleSource("drift.md");
    await waitFor(() =>
      expect((registry.get("spec-comment")?.ranges ?? []).map(String)).toEqual([
        "eta",
      ]),
    );
  });

  it("paints a baseline comment on the unchanged row it hangs under", async () => {
    // drift.md v1 line 2 is "beta", unchanged in drifted.md v2; columns 2–4
    // are "eta". pierre numbers the row 2 on both sides here.
    mockSpec([withColumns(comment("drift.md", 1, 2, "why beta?"), 2, 4)]);
    await stack("?v=2&compare=1");
    const ranges = await waitFor(() => {
      const found = registry.get("spec-comment")?.ranges ?? [];
      expect(found).toHaveLength(1);
      return found;
    });
    expect(ranges[0]?.toString()).toBe("eta");
    expect(
      ranges[0]?.startContainer.parentElement
        ?.closest("[data-line]")
        ?.getAttribute("data-line-type"),
    ).toBe("context");
  });

  it("paints a baseline comment on the deletion side only", async () => {
    // drift.md v1 line 4 is "delta"; columns 2–4 are "elt". v2's line 4,
    // "omega", is the addition beside it.
    mockSpec([withColumns(comment("drift.md", 1, 4, "why drop it?"), 2, 4)]);
    await stack("?v=2&compare=1");
    const ranges = await waitFor(() => {
      const found = registry.get("spec-comment")?.ranges ?? [];
      expect(found).toHaveLength(1);
      return found;
    });
    expect(ranges[0]?.toString()).toBe("elt");
    expect(
      ranges[0]?.startContainer.parentElement
        ?.closest("[data-line]")
        ?.getAttribute("data-line-type"),
    ).toBe("change-deletion");
  });
});
