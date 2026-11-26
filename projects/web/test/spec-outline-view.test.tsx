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
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  Issue,
  MePrefs as MePrefsShape,
  SpecComments,
  SpecFiles,
  SpecInfo,
} from "@todou/shared";
import { MePrefs } from "@todou/shared";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { testQueryClient } from "./render.tsx";

// The outline beside a rendered spec file and in the Files popover.

const counts = vi.hoisted(() => ({ annotated: 0 }));

vi.mock(
  "../src/components/spec/annotated-markdown.tsx",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/components/spec/annotated-markdown.tsx")
      >();
    const Original = actual.AnnotatedMarkdown;
    return {
      ...actual,
      AnnotatedMarkdown: (props: Parameters<typeof Original>[0]) => {
        counts.annotated++;
        return <Original {...props} />;
      },
    };
  },
);

vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: () => <div data-testid="diff" />,
  File: () => <div data-testid="file-view" />,
  CodeView: () => null,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  counts.annotated = 0;
  for (const header of document.querySelectorAll("header")) header.remove();
});

const AUTHOR = {
  id: 1,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

/**
 * v2 rewrites the last paragraph only, so a comparison folds everything from
 * the intro to the end of Beta into one placeholder: Alpha and Beta are
 * folded, Gamma heads the change and stays.
 */
const V1 = lines(
  "# Design",
  "",
  "Intro.",
  "",
  "## Alpha",
  "",
  "alpha one.",
  "",
  "alpha two.",
  "",
  "alpha three.",
  "",
  "## Beta",
  "",
  "beta one.",
  "",
  "beta two.",
  "",
  "beta three.",
  "",
  "## Gamma",
  "",
  "gamma one.",
  "",
  "gamma two.",
);
const V2 = V1.replace("gamma two.", "gamma two, rewritten.");
const BODIES: Record<number, Record<string, string>> = {
  1: { "design.md": V1, "notes.md": "plain\n" },
  2: { "design.md": V2, "notes.md": "plain\n" },
};

const ISSUE = {
  id: 234,
  number: 1,
  title: "Spec outline",
  body: "",
  body_preview: null,
  status: {
    id: 1,
    name: "In Progress",
    category: "open",
    color: "#bf8700",
    position: 2,
    is_default: false,
  },
  author: AUTHOR,
  assignees: [],
  labels: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: 2,
  spec_review_status: "unreviewed",
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
} satisfies Issue;

function mockSpec(prefs: Partial<MePrefsShape> = {}) {
  vi.spyOn(api, "getIssue").mockResolvedValue(ISSUE);
  vi.spyOn(api, "getMyPrefs").mockResolvedValue(MePrefs.parse(prefs));
  const info: SpecInfo = {
    current_version: 2,
    current_version_cursor: "c2",
    review_status: "unreviewed",
    unresolved_comments: 0,
    unresolved_carried_comments: 0,
    files: Object.entries(BODIES[2] ?? {}).map(([path, body]) => ({
      path,
      size: body.length,
    })),
    versions: [1, 2].map((number) => ({
      number,
      author: AUTHOR,
      message: `v${number}`,
      created_at: `2026-01-0${number}T00:00:00Z`,
    })),
  };
  vi.spyOn(api, "getSpec").mockResolvedValue(info);
  vi.spyOn(api, "getSpecFiles").mockImplementation(
    (_slug, _number, version): Promise<SpecFiles> => {
      const v = version ?? 2;
      return Promise.resolve({
        version: v,
        files: Object.entries(BODIES[v] ?? {}).map(([path, body]) => ({
          path,
          body,
          size: body.length,
        })),
      });
    },
  );
  const comments: SpecComments = { current_version: 2, items: [] };
  vi.spyOn(api, "getSpecComments").mockResolvedValue(comments);
  vi.spyOn(api, "getReferenceConfig").mockResolvedValue({
    format: { prefix: "T", history: [] },
    autolinks: [],
  });
}

/** The shell header the page sits under, which happy-dom cannot measure. */
function shellHeader(height = 57): void {
  const header = document.createElement("header");
  header.getBoundingClientRect = () =>
    ({ height, top: 0, bottom: height }) as DOMRect;
  document.body.append(header);
}

async function renderSpec(search: string, prefs: Partial<MePrefsShape> = {}) {
  mockSpec(prefs);
  shellHeader();
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
  const view = render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByRole("heading", { level: 1, name: "Design" });
  // The preferences decide what the rail holds; wait for them to land.
  await waitFor(() => expect(api.getMyPrefs).toHaveBeenCalled());
  await act(async () => {});
  return view;
}

const setViewportWidth = (width: number) =>
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });

const rail = (view: { container: HTMLElement }) => {
  const aside = view.container.querySelector("aside");
  if (aside === null) throw new Error("no rail");
  return aside;
};

/** The outline's rows, by what they read. */
const rows = (box: HTMLElement) =>
  within(box)
    .queryAllByRole("button")
    .filter((el) => el.closest("[data-spec-outline]") !== null);

/** The rendered heading on a line, as the document draws it. */
const headingAt = (view: { container: HTMLElement }, line: number) =>
  view.container.querySelector<HTMLElement>(
    `[data-testid="annotated-markdown"] [data-loc^="${line}-"]`,
  );

/**
 * Every scrollIntoView, with the alignment it asked for and whether what it
 * was asked to show was still folded away, with no box to scroll to.
 */
function watchReveals() {
  const reveals: {
    el: Element;
    block?: ScrollLogicalPosition;
    folded: boolean;
  }[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
    arg?: boolean | ScrollIntoViewOptions,
  ) {
    reveals.push({
      el: this,
      block: typeof arg === "object" ? arg.block : undefined,
      folded: this.closest(".spec-folded") !== null,
    });
  });
  return reveals;
}

describe("the outline in the rail", () => {
  it("lists the file's headings under the file list, the title first", async () => {
    const view = await renderSpec("?v=2&file=design.md");
    const aside = rail(view);
    await waitFor(() => expect(rows(aside).length).toBeGreaterThan(0));
    expect(rows(aside).map((row) => row.textContent)).toEqual([
      "Design",
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(
      within(aside).getByRole("heading", { name: "Outline" }),
    ).toBeTruthy();
    const files = within(aside).getAllByRole("link");
    const lastFile = files.at(-1) as HTMLElement;
    const firstRow = rows(aside)[0] as HTMLElement;
    expect(
      lastFile.compareDocumentPosition(firstRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("leaves the rail to the files when the outline is switched off", async () => {
    const view = await renderSpec("?v=2&file=design.md", {
      spec_outline: false,
    });
    const aside = rail(view);
    expect(within(aside).getAllByRole("link")).toHaveLength(2);
    expect(
      within(aside).queryByRole("heading", { name: "Outline" }),
    ).toBeNull();
    expect(rows(aside)).toEqual([]);
  });

  it("opens the fold over a heading it jumps to, and lands on the heading", async () => {
    const view = await renderSpec("?v=2&file=design.md");
    const beta = headingAt(view, 13);
    expect(beta?.closest(".spec-folded")).not.toBeNull();
    expect(view.container.querySelectorAll(".spec-fold")).toHaveLength(1);
    const reveals = watchReveals();

    const row = rows(rail(view)).find((el) => el.textContent === "Beta");
    fireEvent.click(row as HTMLElement);

    await waitFor(() => expect(reveals).toHaveLength(1));
    expect(view.container.querySelectorAll(".spec-fold")).toHaveLength(0);
    const opened = headingAt(view, 13);
    expect(opened?.closest(".spec-folded")).toBeNull();
    expect(reveals[0]?.el).toBe(opened);
    expect(reveals[0]?.block).toBe("start");
    // Measured once the fold was open, not while the heading had no box.
    expect(reveals[0]?.folded).toBe(false);
  });
});

describe("the outline in the Files popover", () => {
  it("closes the popover and lands on the heading picked in it", async () => {
    setViewportWidth(390);
    onTestFinished(() => setViewportWidth(1024));
    const view = await renderSpec("?v=2&file=design.md");
    fireEvent.click(view.getByRole("button", { name: /Files \(2\)/ }));
    const popover = await screen.findByRole("dialog");
    expect(
      within(popover).getByRole("heading", { name: "Outline" }),
    ).toBeTruthy();
    const reveals = watchReveals();

    const row = rows(popover).find((el) => el.textContent === "Gamma");
    fireEvent.click(row as HTMLElement);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(reveals).toHaveLength(1));
    expect(reveals[0]?.el).toBe(headingAt(view, 21));
    expect(reveals[0]?.block).toBe("start");
  });
});

describe("following the reader through the sections", () => {
  /** Put each heading's top where the reader would see it, then scroll. */
  async function place(view: { container: HTMLElement }, tops: number[]) {
    [1, 5, 13, 21].forEach((line, i) => {
      const el = headingAt(view, line);
      if (el === null) throw new Error(`no heading on line ${line}`);
      el.getBoundingClientRect = () =>
        ({
          top: tops[i] ?? 0,
          height: 30,
          bottom: (tops[i] ?? 0) + 30,
        }) as DOMRect;
    });
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }

  const current = (view: { container: HTMLElement }) =>
    rows(rail(view))
      .filter((row) => row.getAttribute("aria-current") === "location")
      .map((row) => row.textContent);

  it("moves the current row without re-rendering the document", async () => {
    // v1 compares against nothing, so nothing folds and every heading has a box.
    const view = await renderSpec("?v=1&file=design.md");
    await waitFor(() => expect(rows(rail(view)).length).toBe(4));
    await place(view, [-900, -200, 900, 1400]);
    expect(current(view)).toEqual(["Alpha"]);

    const before = counts.annotated;
    for (const round of [0, 1, 2]) {
      await place(view, [-900, -600, -100, 1400]);
      expect(current(view), `round ${round}`).toEqual(["Beta"]);
      await place(view, [-900, -200, 900, 1400]);
      expect(current(view), `round ${round}`).toEqual(["Alpha"]);
    }
    expect(counts.annotated).toBe(before);
  });
});
