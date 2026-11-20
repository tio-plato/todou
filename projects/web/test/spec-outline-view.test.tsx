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
  SpecCommentItem,
  SpecComments,
  SpecFiles,
  SpecInfo,
} from "@todou/shared";
import { MePrefs } from "@todou/shared";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { DELETION_CLASSES } from "../src/lib/rehype-fold-unchanged.ts";
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
 * v2 drops a note under the title, rewrites a paragraph under Alpha and the
 * end of Gamma, and the reader has a comment and a draft under Delta. A
 * comparison keeps what changed, what is annotated and the headings over the
 * changes, and folds the rest of Beta and Delta's heading into one
 * placeholder, from Beta's line to Delta's.
 */
const V1 = lines(
  "# Design",
  "",
  "Intro.",
  "",
  "Old note.",
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
  "## Delta",
  "",
  "delta one.",
  "",
  "delta two.",
  "",
  "delta three.",
  "",
  "## Gamma",
  "",
  "gamma one.",
  "",
  "gamma two.",
);
const V2 = V1.replace("Intro.\n\nOld note.\n", "Intro.\n")
  .replace("alpha two.", "alpha two, edited.")
  .replace("gamma two.\n", "gamma two, rewritten.\n\ngamma three.\n");
const BODIES: Record<number, Record<string, string>> = {
  1: { "design.md": V1, "notes.md": "plain\n" },
  2: { "design.md": V2, "notes.md": "plain\n" },
};
/** Each heading's line in v2. */
const LINE = { Design: 1, Alpha: 5, Beta: 13, Delta: 19, Gamma: 27 } as const;

/** A comment on v2's design.md, on one line. */
function comment(id: number, line: number, resolved: boolean): SpecCommentItem {
  return {
    comment_id: id,
    author: AUTHOR,
    created_at: "2026-01-02T00:00:00Z",
    body: `note ${id}`,
    anchor: {
      path: "design.md",
      version: 2,
      line_start: line,
      line_end: line,
      col_start: null,
      col_end: null,
      quote: "",
    },
    resolved: resolved ? { by: AUTHOR, at: "2026-01-03T00:00:00Z" } : null,
    outdated: false,
    current_line_start: line,
    current_line_end: line,
  };
}

/** One open and one resolved comment on "delta one.", a draft on "delta two.". */
const COMMENTS: SpecComments = {
  current_version: 2,
  items: [comment(41, 21, false), comment(42, 21, true)],
};
const DRAFTS = [
  {
    id: "draft-1",
    anchor: {
      path: "design.md",
      version: 2,
      line_start: 23,
      line_end: 23,
      col_start: null,
      col_end: null,
    },
    quote: "delta two.",
    body: "a draft",
  },
];

const ISSUE = {
  id: 234,
  number: 1,
  title: "Spec outline",
  body: "",
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
  vi.spyOn(api, "getSpecComments").mockResolvedValue(COMMENTS);
  localStorage.setItem("todou-spec-review:demo:1", JSON.stringify(DRAFTS));
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

/** The outline's rows. */
const rows = (box: HTMLElement) =>
  within(box)
    .queryAllByRole("button")
    .filter((el) => el.closest("[data-spec-outline]") !== null);

/** The heading a row names: its title, whatever its counts read. */
const named = (row: HTMLElement) => row.getAttribute("title");

const rowFor = (box: HTMLElement, name: string) => {
  const row = rows(box).find((el) => named(el) === name);
  if (row === undefined) throw new Error(`no outline row ${name}`);
  return row;
};

/** What a row's count cells read, by column. */
const cells = (row: HTMLElement) =>
  Object.fromEntries(
    [...row.querySelectorAll("[data-outline-cell]")].map((cell) => [
      cell.getAttribute("data-outline-cell"),
      cell.textContent,
    ]),
  );

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
    expect(rows(aside).map(named)).toEqual([
      "Design",
      "Alpha",
      "Beta",
      "Delta",
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
    // Delta is the fold's last block, so its line is the end of the fold's key.
    expect(headingAt(view, LINE.Delta)?.closest(".spec-folded")).not.toBeNull();
    const folds = [...view.container.querySelectorAll(".spec-fold")];
    expect(folds.map((fold) => fold.getAttribute("data-fold-key"))).toEqual([
      `${LINE.Beta}-${LINE.Delta}`,
    ]);
    const reveals = watchReveals();

    fireEvent.click(rowFor(rail(view), "Delta"));

    await waitFor(() => expect(reveals).toHaveLength(1));
    expect(view.container.querySelectorAll(".spec-fold")).toHaveLength(0);
    const opened = headingAt(view, LINE.Delta);
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

    fireEvent.click(rowFor(popover, "Gamma"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(reveals).toHaveLength(1));
    expect(reveals[0]?.el).toBe(headingAt(view, LINE.Gamma));
    expect(reveals[0]?.block).toBe("start");
  });
});

describe("following the reader through the sections", () => {
  /** Put each heading's top where the reader would see it, then scroll. */
  async function place(view: { container: HTMLElement }, tops: number[]) {
    Object.values(LINE).forEach((line, i) => {
      const el = headingAt(view, line);
      if (el === null) throw new Error(`no heading on line ${line}`);
      const top = tops[i] ?? 0;
      el.getBoundingClientRect = () =>
        ({ top, height: 30, bottom: top + 30 }) as DOMRect;
    });
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }

  const current = (view: { container: HTMLElement }) =>
    rows(rail(view))
      .filter((row) => row.getAttribute("aria-current") === "location")
      .map(named);

  it("moves the current row without re-rendering the document", async () => {
    // Nothing folds, so every heading has a box of its own.
    localStorage.setItem("todou-spec-fold", "off");
    const view = await renderSpec("?v=2&file=design.md");
    await waitFor(() => expect(rows(rail(view)).length).toBe(5));
    await place(view, [-900, -200, 900, 1200, 1400]);
    expect(current(view)).toEqual(["Alpha"]);

    const before = counts.annotated;
    for (const round of [0, 1, 2]) {
      await place(view, [-900, -600, -100, 1200, 1400]);
      expect(current(view), `round ${round}`).toEqual(["Beta"]);
      await place(view, [-900, -200, 900, 1200, 1400]);
      expect(current(view), `round ${round}`).toEqual(["Alpha"]);
    }
    expect(counts.annotated).toBe(before);
  });
});

describe("what each section holds", () => {
  it("counts each section's changed lines while comparing, and none otherwise", async () => {
    const view = await renderSpec("?v=2&file=design.md");
    const aside = rail(view);
    // The note and its blank line gone from under the title; Alpha's
    // paragraph reworded; Gamma's last one reworded, and a blank line and a
    // paragraph added after it.
    await waitFor(() =>
      expect(cells(rowFor(aside, "Alpha")).changes).toBe("+1 −1"),
    );
    expect(cells(rowFor(aside, "Design")).changes).toBe("−2");
    expect(cells(rowFor(aside, "Gamma")).changes).toBe("+3 −1");
    for (const name of ["Beta", "Delta"]) {
      expect(cells(rowFor(aside, name)).changes, name).toBe("");
    }
    view.unmount();

    const plain = await renderSpec("?v=1&file=design.md");
    await waitFor(() => expect(rows(rail(plain)).length).toBe(5));
    for (const row of rows(rail(plain))) {
      expect(cells(row).changes, named(row) ?? "").toBe("");
    }
  });

  it("counts open comments and drafts in their own columns", async () => {
    const view = await renderSpec("?v=2&file=design.md");
    const aside = rail(view);
    // One open comment, one resolved and one draft under Delta.
    await waitFor(() =>
      expect(cells(rowFor(aside, "Delta"))).toMatchObject({
        comments: "1",
        drafts: "1",
      }),
    );
    for (const name of ["Design", "Alpha", "Beta", "Gamma"]) {
      expect(cells(rowFor(aside, name)), name).toMatchObject({
        comments: "",
        drafts: "",
      });
    }
  });

  it("drops a column when its switch is off", async () => {
    const quiet = await renderSpec("?v=2&file=design.md", {
      spec_outline_comments: false,
    });
    await waitFor(() =>
      expect(cells(rowFor(rail(quiet), "Gamma")).changes).toBe("+3 −1"),
    );
    expect(cells(rowFor(rail(quiet), "Delta"))).toMatchObject({
      comments: "",
      drafts: "",
    });
    quiet.unmount();

    const still = await renderSpec("?v=2&file=design.md", {
      spec_outline_changes: false,
    });
    await waitFor(() =>
      expect(cells(rowFor(rail(still), "Delta")).comments).toBe("1"),
    );
    for (const row of rows(rail(still))) {
      expect(cells(row).changes, named(row) ?? "").toBe("");
    }
  });
});

describe("the change strip", () => {
  const strip = (view: { container: HTMLElement }) =>
    view.container.querySelector<HTMLElement>("[data-spec-strip]");
  const card = (view: { container: HTMLElement }) =>
    view.container.querySelector<HTMLElement>(
      '[data-testid="annotated-markdown"]',
    )?.parentElement ?? null;
  const kinds = (view: { container: HTMLElement }) =>
    [
      ...new Set(
        [...(strip(view)?.querySelectorAll("[data-kind]") ?? [])].map((tick) =>
          tick.getAttribute("data-kind"),
        ),
      ),
    ].sort();

  it("stays off a phone, where the chips ride on the card's border", async () => {
    setViewportWidth(390);
    onTestFinished(() => setViewportWidth(1024));
    const view = await renderSpec("?v=2&file=design.md");
    expect(strip(view)).toBeNull();
    expect(card(view)?.className).not.toContain("border-r-transparent");
  });

  it("takes the card's right border from lg up, hidden from assistive tech", async () => {
    const view = await renderSpec("?v=2&file=design.md");
    await waitFor(() => expect(strip(view)).not.toBeNull());
    expect(strip(view)?.getAttribute("aria-hidden")).toBe("true");
    expect(card(view)?.className).toContain("border-r-transparent");
    await waitFor(() =>
      expect(kinds(view)).toEqual([
        "comment",
        "del",
        "draft",
        "heading",
        "stop",
      ]),
    );
  });

  it("leaves the card's border alone when switched off", async () => {
    const view = await renderSpec("?v=2&file=design.md", { spec_strip: false });
    expect(strip(view)).toBeNull();
    expect(card(view)?.className).not.toContain("border-r-transparent");
  });

  it("draws no comment ticks, or no change ticks, when those are off", async () => {
    const quiet = await renderSpec("?v=2&file=design.md", {
      spec_strip_comments: false,
    });
    await waitFor(() =>
      expect(kinds(quiet)).toEqual(["del", "heading", "stop"]),
    );
    quiet.unmount();

    const still = await renderSpec("?v=2&file=design.md", {
      spec_strip_changes: false,
    });
    await waitFor(() =>
      expect(kinds(still)).toEqual(["comment", "draft", "heading"]),
    );
  });

  it("lands a click on a tick where ↓ lands, a removal's tick on the removal", async () => {
    const view = await renderSpec("?v=2&file=design.md");
    await waitFor(() => expect(strip(view)).not.toBeNull());
    const box = card(view) as HTMLElement;
    const bar = strip(view)?.firstElementChild as HTMLElement;
    const doc = box.querySelector('[data-testid="annotated-markdown"]');
    const removal = doc?.querySelector<HTMLElement>(
      [...DELETION_CLASSES].map((name) => `.${name}`).join(", "),
    );
    const stops = [
      ...(doc?.querySelectorAll<HTMLElement>(
        ".spec-changed, .spec-ins-block",
      ) ?? []),
    ];
    expect(removal).not.toBeNull();
    expect(stops.length).toBeGreaterThan(2);
    // A 1000px card at the top of a 768px window: the bar is 752px tall, so
    // the card is drawn at 0.752 of its size. The removal sits above every
    // stop, the way the note above Alpha does; the first two stops sit a
    // pixel apart, so they share one tick, and the rest are well apart.
    const place = (el: Element, top: number) => {
      el.getBoundingClientRect = () =>
        ({ top, height: 20, bottom: top + 20, left: 0, right: 0 }) as DOMRect;
    };
    box.getBoundingClientRect = () =>
      ({ top: 0, height: 1000, bottom: 1000, left: 0, right: 900 }) as DOMRect;
    Object.defineProperty(box, "clientHeight", { value: 1000 });
    bar.getBoundingClientRect = () =>
      ({ top: 0, height: 752, bottom: 752, left: 893, right: 907 }) as DOMRect;
    place(removal as HTMLElement, 100);
    const tops = stops.map((_, i) =>
      i === 0 ? 300 : i === 1 ? 301 : 400 + i * 150,
    );
    stops.forEach((stop, i) => {
      place(stop, tops[i] ?? 0);
    });
    // Laid out anew, as a resize would have it.
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const ticks = [...bar.querySelectorAll<HTMLElement>("[data-stop-index]")];
    // Numbered as ↑↓ number the stops: the shared tick by the first of its two.
    expect(ticks.map((tick) => tick.dataset.stopIndex)).toEqual(
      stops.flatMap((_, i) => (i === 1 ? [] : [String(i)])),
    );
    expect(
      bar.querySelector('[data-kind="del"]')?.hasAttribute("data-stop-index"),
    ).toBe(false);

    const reveals = watchReveals();
    const clickAt = (y: number) => {
      fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientY: y });
      fireEvent.pointerUp(bar, { button: 0, pointerId: 1, clientY: y });
    };
    // The third stop's tick, the second on the bar, 1px into it; then the
    // shared one, which lands where its first stop is.
    clickAt((tops[2] ?? 0) * 0.752 + 1);
    expect(reveals.map((r) => r.el)).toEqual([stops[2]]);
    clickAt(300 * 0.752 + 1);
    expect(reveals.map((r) => r.el)).toEqual([stops[2], stops[0]]);
    clickAt(100 * 0.752 + 1);
    expect(reveals.map((r) => r.el)).toEqual([stops[2], stops[0], removal]);
  });

  it("keeps dragging while the button is down, even when the browser drops its capture", async () => {
    const view = await renderSpec("?v=2&file=design.md");
    await waitFor(() => expect(strip(view)).not.toBeNull());
    const bar = strip(view)?.firstElementChild as HTMLElement;
    const scrolls = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const move = (y: number, buttons: number) =>
      fireEvent.pointerMove(bar, { pointerId: 1, clientY: y, buttons });

    fireEvent.pointerDown(bar, {
      button: 0,
      buttons: 1,
      pointerId: 1,
      clientY: 10,
    });
    // Chromium can take a capture back the moment it grants it; the press goes on.
    fireEvent(bar, new Event("lostpointercapture", { bubbles: true }));
    move(60, 1);
    move(120, 1);
    expect(scrolls).toHaveBeenCalledTimes(2);

    // Released somewhere the bar never heard of: the next pass over it is a hover.
    move(200, 0);
    move(260, 0);
    expect(scrolls).toHaveBeenCalledTimes(2);
  });

  it("keeps a bar to click on however far down the page the card starts", async () => {
    const view = await renderSpec("?v=2&file=design.md");
    await waitFor(() => expect(strip(view)).not.toBeNull());
    const box = card(view) as HTMLElement;
    const bar = strip(view)?.firstElementChild as HTMLElement;
    // A pile of file comments above it: the card starts below a 768px
    // window, at the top of the page.
    box.getBoundingClientRect = () =>
      ({
        top: 1200,
        height: 3000,
        bottom: 4200,
        left: 0,
        right: 900,
      }) as DOMRect;
    Object.defineProperty(box, "clientHeight", { value: 2998 });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(Number.parseFloat(bar.style.height)).toBeGreaterThan(100);
  });

  it("takes the tooltip down when a press that left the bar ends off it", async () => {
    const view = await renderSpec("?v=2&file=design.md");
    await waitFor(() => expect(strip(view)).not.toBeNull());
    const bar = strip(view)?.firstElementChild as HTMLElement;
    const tooltip = () => document.querySelector("[data-spec-strip-tooltip]");

    fireEvent.pointerDown(bar, {
      button: 0,
      buttons: 1,
      pointerId: 1,
      clientY: 10,
    });
    fireEvent.pointerMove(bar, { pointerId: 1, clientY: 12, buttons: 1 });
    expect(tooltip()).not.toBeNull();
    // The capture gone, the pointer leaves the bar still pressed and lets go
    // over the document, where the bar hears nothing of it.
    fireEvent(bar, new Event("lostpointercapture", { bubbles: true }));
    fireEvent.pointerLeave(bar, { pointerId: 1, buttons: 1 });
    expect(tooltip()).not.toBeNull();
    fireEvent.pointerUp(document.body, { pointerId: 1, button: 0, buttons: 0 });
    await waitFor(() => expect(tooltip()).toBeNull());
  });
});
