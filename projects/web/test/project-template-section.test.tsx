import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  BUILTIN_TEMPLATES,
  type ChangeRow,
  type MePrefs,
  type Project,
  type ProjectTemplate,
  type Status,
  type TemplateApplyPlan,
  type TemplateBody,
} from "@todou/shared";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import {
  projectQuery,
  projectTemplatesQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import { LabelChip } from "../src/components/issue/label-chip.tsx";
import { StatusPill } from "../src/components/issue/status-pill.tsx";
import { ProjectSettingsTemplatePage } from "../src/pages/project-settings-template.tsx";
import { testQueryClient } from "./render.tsx";

const BASIC: ProjectTemplate = {
  ref: "basic",
  name: "Basic",
  builtin: true,
  revision: 0,
  body: BUILTIN_TEMPLATES.basic.body,
};

const KANBAN: ProjectTemplate = {
  ref: 7,
  name: "Kanban",
  builtin: false,
  revision: 3,
  body: {
    statuses: [
      {
        name: "Todo",
        category: "open",
        color: "#6b7280",
        chart_role: "remaining",
      },
      {
        name: "Doing",
        category: "open",
        color: "#3b82f6",
        chart_role: "remaining",
      },
      {
        name: "Review",
        category: "open",
        color: "#14b8a6",
        chart_role: "remaining",
        is_default: true,
      },
      {
        name: "Done",
        category: "closed",
        color: "#22c55e",
        chart_role: "completed",
      },
    ],
    labels: [
      { name: "kind:bug", color: "#ef4444" },
      { name: "urgent", color: "#ef4444" },
    ],
  },
};

// A template the project already matches.
const SAME: ProjectTemplate = { ...KANBAN, ref: 8, name: "Same" };

const TEMPLATES = [BASIC, KANBAN, SAME];

const PREFS: MePrefs = {
  show_weak_unread: true,
  ref_placement_list: "before",
  ref_placement_board: "own_line",
  ref_placement_detail: "before",
  ref_placement_reference: "before",
  boxed_ref_links: true,
  truncate_ref_title: true,
  show_repeated_ref_title: false,
  open_external_links_in_new_tab: false,
  project_icon_fallback: "colorful_text",
  user_avatar_fallback: "monochrome_text",
  new_project_template: 7,
};

const project = (
  role: Project["viewer_role"],
  name = "Potato field",
): Project => ({
  id: 1,
  slug: "todou",
  name,
  description: "",
  created_at: "2026-01-01T00:00:00Z",
  viewer_role: role,
  block_clear_status_id: null,
});

/** The project's statuses, Doing above Todo, as Kanban has them not. */
const STATUSES: Status[] = [
  [2, "Doing", "open", "#3b82f6"],
  [1, "Todo", "open", "#6b7280"],
  [3, "Done", "closed", "#16a34a"],
  [4, "Parked", "open", "#a855f7"],
  [5, "Discard", "closed", "#64748b"],
].map(([id, name, category, color], i) => ({
  id: id as number,
  name: name as string,
  category: category as Status["category"],
  color: color as string,
  position: i,
  is_default: name === "Todo",
}));

/** The project as a plan hands it back. */
const SNAPSHOT: TemplateApplyPlan["project"] = {
  statuses: STATUSES.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    category: s.category as "open" | "closed",
    role: s.category === "closed" ? "completed" : "remaining",
    is_default: s.is_default,
  })),
  line: null,
  labels: [
    { id: 40, name: "urgent", color: "#f97316" },
    { id: 41, name: "area:web", color: "#0ea5e9" },
    { id: 42, name: "kind:docs", color: "#8b5cf6" },
    { id: 43, name: "wontfix", color: "#64748b" },
  ],
};

const row = (
  id: string,
  section: "statuses" | "labels",
  action: ChangeRow["action"],
  extra: { selectable?: boolean; requires?: string[] } = {},
) => ({
  id,
  section,
  action,
  default_selected: action !== "delete",
  selectable: extra.selectable ?? true,
  requires: extra.requires ?? [],
});

/** Kanban against the project, as the server lays it out. */
const PLAN_7: TemplateApplyPlan = {
  expected: "plan-7",
  project: SNAPSHOT,
  template: KANBAN.body as TemplateBody,
  changes: [
    {
      ...row("status.add:Review", "statuses", "add"),
      type: "status_add",
      name: "Review",
      category: "open",
      color: "#14b8a6",
      chart_role: "remaining",
      after: "Doing",
    },
    {
      ...row("status.recolour:3", "statuses", "recolour"),
      type: "status_recolour",
      name: "Done",
      from: "#16a34a",
      to: "#22c55e",
    },
    {
      ...row("status.move:2", "statuses", "move"),
      type: "status_move",
    },
    {
      ...row("status.default", "statuses", "change", {
        requires: ["status.add:Review"],
      }),
      type: "status_default",
      from: { name: "Todo", color: "#6b7280" },
      to: { name: "Review", color: "#14b8a6" },
    },
    {
      ...row("status.delete:4", "statuses", "delete"),
      type: "status_delete",
      name: "Parked",
      color: "#a855f7",
      issues: 0,
      trashed: 0,
    },
    {
      ...row("status.delete:5", "statuses", "delete", { selectable: false }),
      type: "status_delete",
      name: "Discard",
      color: "#64748b",
      issues: 2,
      trashed: 1,
    },
    {
      ...row("label.add:kind:bug", "labels", "add"),
      type: "label_add",
      name: "kind:bug",
      color: "#ef4444",
    },
    {
      ...row("label.change:40", "labels", "recolour"),
      type: "label_change",
      name: "urgent",
      from: "#f97316",
      to: "#ef4444",
    },
    {
      ...row("label.delete:41", "labels", "delete"),
      type: "label_delete",
      name: "area:web",
      color: "#0ea5e9",
      issues: 3,
      trashed: 0,
    },
    {
      ...row("label.delete:42", "labels", "delete"),
      type: "label_delete",
      name: "kind:docs",
      color: "#8b5cf6",
      issues: 1,
      trashed: 1,
    },
    {
      ...row("label.delete:43", "labels", "delete"),
      type: "label_delete",
      name: "wontfix",
      color: "#64748b",
      issues: 0,
      trashed: 0,
    },
  ],
};

/** What the server starts selected in PLAN_7: everything but deletions. */
const DEFAULT_SELECTED = [
  "status.add:Review",
  "status.recolour:3",
  "status.move:2",
  "status.default",
  "label.add:kind:bug",
  "label.change:40",
];

/**
 * The boxes of those rows, by name, in the table's order: the default's on
 * its arrow, in Review's row after Review's own.
 */
const DEFAULT_BOXES = [
  "Move Doing below Todo",
  "Add status Review",
  "Change default status Todo → Review",
  "Recolour status Done",
  "Add label kind:bug",
  "Recolour label urgent",
];

/** What the page draws PLAN_7 as once the default rows are applied. */
const DRAWN_7 = {
  order: [1, 2, "Review", 3, 4, 5],
  line: null,
  default: "Review",
};

const PLAN_BASIC: TemplateApplyPlan = {
  expected: "plan-basic",
  project: SNAPSHOT,
  template: BUILTIN_TEMPLATES.basic.body,
  changes: [
    {
      ...row("label.add:needs-brainstorm", "labels", "add"),
      type: "label_add",
      name: "needs-brainstorm",
      color: "#eab308",
    },
  ],
};

const PLANS: Record<string, TemplateApplyPlan> = {
  "7": PLAN_7,
  basic: PLAN_BASIC,
  "8": { ...PLAN_7, expected: "plan-8", changes: [] },
};

type Call = { method: string; path: string; body: unknown };

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

const PREVIEW = "/projects/todou/template/preview";
const APPLY = "/projects/todou/template/apply";

/** The routes the page reaches, answering as the server does. */
function fakeServer({
  role = "admin" as Project["viewer_role"],
  plans = PLANS,
  statuses = STATUSES,
  apply = (): Response => json(200, { skipped: [] }),
  held = false,
} = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input), "http://test").pathname.replace(
      /^\/api/,
      "",
    );
    const method = init?.method ?? "GET";
    const body =
      init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, path, body });

    if (path.endsWith("/template/preview")) {
      // Never answered: the plan is on its way for as long as the test runs.
      if (held) return new Promise<Response>(() => {});
      return json(200, plans[String(body.template)]);
    }
    if (path.endsWith("/template/apply")) return apply();
    if (path === "/me/project-templates" && method === "POST") {
      return json(201, { ...KANBAN, ref: 12, name: body.name, revision: 0 });
    }
    if (path === "/me/project-templates") return json(200, TEMPLATES);
    if (path === "/projects/todou") return json(200, project(role));
    if (path === "/projects/other") {
      return json(200, { ...project(role, "Other"), id: 2, slug: "other" });
    }
    if (/^\/projects\/(todou|other)\/statuses$/.test(path)) {
      return json(200, statuses);
    }
    return json(404, { error: { code: "not_found", message: path } });
  }) as typeof fetch);
  return {
    calls,
    previews: () => calls.filter((c) => c.path === PREVIEW),
    applies: () => calls.filter((c) => c.path === APPLY),
    previewsOf: (slug: string) =>
      calls.filter((c) => c.path === `/projects/${slug}/template/preview`),
  };
}

/**
 * The page at its real path, beside the template page it can lead to.
 * `/authed` mirrors the app's id prefix, which the page's
 * `useParams({ from })` names.
 */
function renderPage({
  role = "admin" as Project["viewer_role"],
  name = "Potato field",
  statuses = STATUSES,
} = {}) {
  const client = testQueryClient();
  client.setQueryData(projectQuery("todou").queryKey, project(role, name));
  client.setQueryData(projectTemplatesQuery.queryKey, TEMPLATES);
  client.setQueryData(prefsQuery.queryKey, PREFS);
  client.setQueryData(statusesQuery("todou").queryKey, statuses);

  const rootRoute = createRootRoute();
  const authed = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    component: Outlet,
  });
  const projectRoute = createRoute({
    getParentRoute: () => authed,
    path: "/projects/$slug",
    component: Outlet,
  });
  const settings = createRoute({
    getParentRoute: () => projectRoute,
    path: "settings",
    component: Outlet,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authed.addChildren([
        projectRoute.addChildren([
          settings.addChildren([
            createRoute({
              getParentRoute: () => settings,
              path: "template",
              component: ProjectSettingsTemplatePage,
            }),
          ]),
        ]),
        createRoute({
          getParentRoute: () => authed,
          path: "/settings/templates/$template",
          component: () => null,
        }),
      ]),
    ]),
    history: createMemoryHistory({
      initialEntries: ["/projects/todou/settings/template"],
    }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const box = (name: string) =>
  screen.getByRole("checkbox", { name }) as HTMLInputElement;

/** The ticked boxes in the table's rows, by name, top down. */
const checkedRows = () =>
  [...document.querySelectorAll("[role=row] [data-tick] input")]
    .filter((input) => (input as HTMLInputElement).checked)
    .map((input) => input.getAttribute("aria-label"));

const option = (name: string) => screen.getByRole("option", { name });

/** Pick Kanban and wait for its table. */
async function pickKanban() {
  fireEvent.click(await screen.findByRole("option", { name: "Kanban" }));
  return screen.findByRole("checkbox", { name: "Add status Review" });
}

const section = (name: string) =>
  within(screen.getByRole("rowgroup", { name }));

const rowOf = (name: string) =>
  screen.getByRole("checkbox", { name }).closest("[role=row]") as HTMLElement;

const applyButton = () =>
  screen.getByRole("button", { name: /Apply/ }) as HTMLButtonElement;

/** Waits `ms` of real time, as a reader does between presses. */
const wait = (ms: number) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** How a component draws `ui`, rendered apart from the page. */
const drawn = (ui: ReactElement) =>
  render(ui, { container: document.createElement("div") }).container.innerHTML;

/** What the page kept for `slug` across a reload, read back. */
const kept = (slug: string) => {
  const raw = sessionStorage.getItem(`todou:apply-template:${slug}`);
  return raw === null ? null : JSON.parse(raw);
};
const keep = (slug: string, value: unknown) =>
  sessionStorage.setItem(`todou:apply-template:${slug}`, JSON.stringify(value));

/** Hovering, as React hears it: from the pointerover/out pair. */
const hover = (el: Element) =>
  fireEvent.pointerOver(el, { pointerType: "mouse", bubbles: true });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("applying a template", () => {
  it("starts with no template picked, and reads no preview", async () => {
    const server = fakeServer();
    renderPage();
    const list = await screen.findByRole("listbox", { name: "Templates" });
    expect(within(list).queryAllByRole("option", { selected: true })).toEqual(
      [],
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /Apply/ })).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(server.previews()).toEqual([]);
  });

  it("previews the template picked, everything but deletions ticked", async () => {
    const server = fakeServer();
    renderPage();
    await pickKanban();
    expect(server.previews()).toEqual([
      { method: "POST", path: PREVIEW, body: { template: 7 } },
    ]);
    expect(checkedRows()).toEqual(DEFAULT_BOXES);
    for (const name of [
      "Delete status Parked",
      "Delete label area:web — comes off 3 issues",
      "Delete label kind:docs — comes off 2 issues (1 in the trash)",
      "Delete label wontfix — on no issue",
    ]) {
      expect(box(name).checked, name).toBe(false);
    }
    // Two issues in it and one in the trash hold its deletion off: no box.
    expect(
      screen.getByRole("img", {
        name: "Discard cannot be deleted: 3 issues are in it, 1 trashed",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Discard/ })).toBeNull();
  });

  it("closes a template's preview card once the template is picked", async () => {
    fakeServer();
    renderPage();
    const kanban = await screen.findByRole("option", { name: "Kanban" });
    hover(within(kanban).getByText("Kanban"));
    await waitFor(() =>
      expect(
        document.querySelectorAll("[data-slot='hover-card-content']"),
      ).toHaveLength(1),
    );
    fireEvent.pointerDown(within(kanban).getByText("Kanban"), {
      pointerType: "mouse",
    });
    fireEvent.click(kanban);
    await waitFor(() =>
      expect(
        document.querySelectorAll("[data-slot='hover-card-content']"),
      ).toHaveLength(0),
    );
  });

  it("keeps a template's preview card shut when the template is picked before it opens", async () => {
    fakeServer();
    renderPage();
    const kanban = await screen.findByRole("option", { name: "Kanban" });
    const name = within(kanban).getByText("Kanban");
    hover(name);
    fireEvent.pointerDown(name, { pointerType: "mouse" });
    fireEvent.click(kanban);
    // Past the delay the card would have opened after.
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
    expect(
      document.querySelectorAll("[data-slot='hover-card-content']"),
    ).toHaveLength(0);
  });

  it("goes back to no template when the one picked is picked again, forgetting its ticks", async () => {
    fakeServer();
    renderPage();
    await pickKanban();
    fireEvent.click(box("Recolour status Done"));
    expect(box("Recolour status Done").checked).toBe(false);

    fireEvent.click(option("Kanban"));
    expect(option("Kanban").getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /Apply/ })).toBeNull();

    await pickKanban();
    expect(box("Recolour status Done").checked).toBe(true);
    expect(checkedRows()).toEqual(DEFAULT_BOXES);
  });

  it("counts each kind of change under the picker, leaving out the kinds there are none of", async () => {
    fakeServer();
    renderPage();
    await pickKanban();
    const summary = document.querySelector("[data-action]")
      ?.parentElement as HTMLElement;
    const counted = () =>
      [...summary.querySelectorAll("[data-action]")].map((part) => [
        part.getAttribute("data-action"),
        part.textContent,
      ]);
    expect(counted()).toEqual([
      ["add", "2 to add"],
      ["recolour", "2 recolour"],
      ["change", "1 to change"],
      ["move", "1 move"],
      ["delete", "5 to delete(0 ticked)"],
    ]);
    fireEvent.click(box("Delete status Parked"));
    expect(counted().at(-1)).toEqual(["delete", "5 to delete(1 ticked)"]);
  });

  it("names each box by what it does, and draws a status left out as a shadow", async () => {
    fakeServer();
    renderPage();
    await pickKanban();
    const afterLook = (name: string) =>
      rowOf(name).querySelector("[data-cell='after'] [data-look]");
    expect(afterLook("Add status Review")?.getAttribute("data-look")).toBe(
      "solid",
    );
    fireEvent.click(box("Add status Review"));
    expect(afterLook("Add status Review")?.getAttribute("data-look")).toBe(
      "shadow",
    );
    // The default goes with the status it needs.
    expect(box("Change default status Todo → Review").checked).toBe(false);
  });

  it("lights an arrow while its box is ticked, wherever the pointer is", async () => {
    fakeServer();
    renderPage();
    await pickKanban();
    const name = "Move Doing below Todo";
    const lit = () =>
      document
        .querySelector('g[data-arrow-tick="status.move:2"]')
        ?.getAttribute("data-lit") ?? null;
    await waitFor(() => expect(lit()).toBe("true"));
    fireEvent.click(box(name));
    expect(lit()).toBeNull();
    hover(rowOf(name));
    expect(lit()).toBeNull();
    // A finger on the row.
    fireEvent.pointerUp(rowOf(name), { pointerType: "touch" });
    expect(lit()).toBeNull();
    fireEvent.click(box(name));
    expect(lit()).toBe("true");
  });

  it("selects a section's deletions from its heading, and clears them again", async () => {
    fakeServer();
    renderPage();
    await pickKanban();
    const labels = section("Labels");

    fireEvent.click(labels.getByRole("checkbox", { name: "Delete" }));
    for (const name of ["area:web", "kind:docs", "wontfix"]) {
      expect(
        box(
          (screen.getAllByRole("checkbox") as HTMLInputElement[])
            .map((b) => b.getAttribute("aria-label") ?? "")
            .find((label) => label.startsWith(`Delete label ${name} `)) ?? "",
        ).checked,
        name,
      ).toBe(true);
    }
    expect(box("Delete status Parked").checked).toBe(false);

    fireEvent.click(labels.getByRole("checkbox", { name: "Delete" }));
    expect(checkedRows()).toEqual(DEFAULT_BOXES);

    // One of the three ticked shows the heading's box half ticked.
    fireEvent.click(box("Delete label wontfix — on no issue"));
    const deletions = labels.getByRole("checkbox", {
      name: "Delete",
    }) as HTMLInputElement;
    expect(deletions.indeterminate).toBe(true);
    expect(deletions.checked).toBe(false);

    const statuses = section("Statuses");
    const moves = statuses.getByRole("checkbox", { name: "Move" });
    expect((moves as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box("Move Doing below Todo"));
    expect((moves as HTMLInputElement).checked).toBe(false);
    fireEvent.click(moves);
    expect(box("Move Doing below Todo").checked).toBe(true);
  });

  it("keeps the default status and the status it needs together", async () => {
    fakeServer();
    renderPage();
    await pickKanban();

    fireEvent.click(box("Add status Review"));
    expect(box("Add status Review").checked).toBe(false);
    expect(box("Change default status Todo → Review").checked).toBe(false);

    fireEvent.click(box("Change default status Todo → Review"));
    expect(box("Change default status Todo → Review").checked).toBe(true);
    expect(box("Add status Review").checked).toBe(true);
  });

  it("counts the ticked rows on Apply, and holds it back with none", async () => {
    fakeServer();
    renderPage();
    await pickKanban();

    expect(applyButton().textContent).toBe("Apply 6 changes");
    expect(applyButton().disabled).toBe(false);
    fireEvent.click(box("Delete status Parked"));
    expect(applyButton().textContent).toBe("Apply 7 changes");

    // The default status before the status it needs, so each click clears
    // one box whatever the rows hanging together do.
    for (const name of [
      "Delete status Parked",
      "Change default status Todo → Review",
      "Add status Review",
      "Recolour status Done",
      "Move Doing below Todo",
      "Add label kind:bug",
      "Recolour label urgent",
    ]) {
      fireEvent.click(box(name));
    }
    expect(checkedRows()).toEqual([]);
    expect(applyButton().textContent).toBe("Apply");
    expect(applyButton().disabled).toBe(true);
  });

  it("holds Apply back while the plan is on its way, never offering zero changes", async () => {
    fakeServer({ held: true });
    renderPage();
    fireEvent.click(await screen.findByRole("option", { name: "Kanban" }));
    expect(await screen.findByText("Preparing plan…")).toBeTruthy();
    expect(applyButton().textContent).toBe("Apply");
    expect(applyButton().disabled).toBe(true);
    expect(screen.queryByText(/Apply 0/)).toBeNull();
  });

  it("previews another template when one is picked, and applies that preview", async () => {
    const server = fakeServer();
    renderPage();
    await pickKanban();

    fireEvent.click(option("Basic"));
    await screen.findByRole("checkbox", {
      name: "Add label needs-brainstorm",
    });
    expect(server.previews().map((c) => c.body)).toEqual([
      { template: 7 },
      { template: "basic" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    await waitFor(() => expect(server.applies()).toHaveLength(1));
    expect(server.applies()[0]?.body).toEqual({
      template: "basic",
      expected: "plan-basic",
      selected: ["label.add:needs-brainstorm"],
      drawn: { order: [2, 1, 3, 4, 5], line: null, default: 1 },
    });
  });

  it("sends the ticked rows and what the table draws, and says what was done, a skipped deletion included", async () => {
    const success = vi.spyOn(toast, "success");
    const warning = vi.spyOn(toast, "warning");
    const server = fakeServer({
      apply: () => json(200, { skipped: ["status.delete:4"] }),
    });
    renderPage();
    await pickKanban();

    fireEvent.click(box("Delete status Parked"));
    // The After column, top down: what is sent as drawn.
    const after = [...document.querySelectorAll("[data-row]")].flatMap((r) => {
      const look = r.querySelector("[data-cell='after'] [data-look='solid']");
      return look?.textContent ? [look.textContent] : [];
    });
    expect(after).toEqual(["Todo", "Doing", "Review", "Done", "Discard"]);
    fireEvent.click(screen.getByRole("button", { name: "Apply 7 changes" }));
    await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
    expect(server.applies()[0]?.body).toEqual({
      template: 7,
      expected: "plan-7",
      selected: [
        "status.add:Review",
        "status.recolour:3",
        "status.move:2",
        "status.default",
        "status.delete:4",
        "label.add:kind:bug",
        "label.change:40",
      ],
      drawn: { ...DRAWN_7, order: [1, 2, "Review", 3, 5] },
    });
    const said = String(warning.mock.calls[0]?.[0]);
    expect(said).toContain("Applied 6 changes.");
    expect(said).toContain("Parked");
    expect(success).not.toHaveBeenCalled();
    // The project changed: what is left of the template is previewed again.
    await waitFor(() => expect(server.previews()).toHaveLength(2));
  });

  it("asks before taking labels off cards, its Cancel focused", async () => {
    const server = fakeServer();
    renderPage();
    await pickKanban();
    fireEvent.click(
      box("Delete label kind:docs — comes off 2 issues (1 in the trash)"),
    );
    fireEvent.click(applyButton());
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();
    fireEvent.click(cancel);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(server.applies()).toEqual([]);

    fireEvent.click(applyButton());
    await wait(600);
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete and apply 7 changes" }),
    );
    await waitFor(() => expect(server.applies()).toHaveLength(1));
    expect(server.applies()[0]?.body).toMatchObject({
      selected: [...DEFAULT_SELECTED, "label.delete:42"],
      label_issues: { "label.delete:42": 2 },
    });
  });

  it("confirms nothing from a double-click on Apply, or presses that keep coming quickly after it", async () => {
    const server = fakeServer();
    renderPage();
    await pickKanban();
    fireEvent.click(
      box("Delete label kind:docs — comes off 2 issues (1 in the trash)"),
    );
    // A double-click on Apply: its second press lands on the button that
    // took Apply's place. The mouse moved a few pixels between them, so
    // the browser counts that press as a single click.
    fireEvent.click(applyButton(), { detail: 1 });
    const confirm = screen.getByRole("button", {
      name: "Delete and apply 7 changes",
    });
    fireEvent.click(confirm, { detail: 1 });
    // Four more presses on it, each 0.15 s after the last: the last comes
    // 0.6 s after Apply.
    for (let i = 0; i < 4; i++) {
      await wait(150);
      fireEvent.click(confirm);
    }
    await wait(20);
    expect(server.applies()).toEqual([]);
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();
  });

  it("confirms a press made after a pause, though the bar drew again just before it", async () => {
    const server = fakeServer();
    renderPage();
    await pickKanban();
    fireEvent.click(
      box("Delete label kind:docs — comes off 2 issues (1 in the trash)"),
    );
    fireEvent.click(applyButton());
    const confirm = screen.getByRole("button", {
      name: "Delete and apply 7 changes",
    }) as HTMLButtonElement;
    await wait(600);
    // The preview is read again with the same counts: the question stays,
    // drawn again as the read starts and ends.
    fireEvent(window, new Event("visibilitychange"));
    await waitFor(() => expect(server.previews()).toHaveLength(2));
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(server.applies()).toHaveLength(1));
  });

  it("confirms nothing from a slow double-click the browser counts as one, and confirms the press after it", async () => {
    const server = fakeServer();
    renderPage();
    await pickKanban();
    fireEvent.click(
      box("Delete label kind:docs — comes off 2 issues (1 in the trash)"),
    );
    // A double-click slower than 0.5 s that the browser still counts as
    // one: its second press has detail 2.
    fireEvent.click(applyButton(), { detail: 1 });
    const confirm = screen.getByRole("button", {
      name: "Delete and apply 7 changes",
    });
    await wait(600);
    fireEvent.click(confirm, { detail: 2 });
    await wait(20);
    expect(server.applies()).toEqual([]);
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();

    // A pause, then one press as a mouse sends it: it confirms.
    await wait(600);
    fireEvent.click(confirm, { detail: 1 });
    await waitFor(() => expect(server.applies()).toHaveLength(1));
  });

  it("withdraws the question when a preview read again changes it, and asks again with the new count", async () => {
    const plans = { ...PLANS };
    const server = fakeServer({ plans });
    renderPage();
    await pickKanban();
    fireEvent.click(
      box("Delete label kind:docs — comes off 2 issues (1 in the trash)"),
    );
    fireEvent.click(applyButton());
    await screen.findByRole("button", { name: "Cancel" });
    // Every text the question showed while it was up.
    const shown = new Set<string>();
    const record = () => {
      const question = screen.queryByText("This cannot be undone.");
      if (question) shown.add(question.closest("p")?.textContent ?? "");
    };
    record();
    const observer = new MutationObserver(record);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    // kind:docs went on two more cards: the same plan, another count.
    plans["7"] = {
      ...PLAN_7,
      changes: PLAN_7.changes.map((change) =>
        change.id === "label.delete:42" ? { ...change, issues: 3 } : change,
      ),
    };
    fireEvent(window, new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull(),
    );
    observer.disconnect();
    expect([...shown]).toEqual([
      "kind:docscomes off 2 issues (1 in the trash).This cannot be undone.",
    ]);
    expect(server.applies()).toEqual([]);
    const again = screen.getByRole("button", {
      name: "Apply 7 changes",
      description:
        "The preview changed before you confirmed. Nothing was applied.",
    });
    expect(document.activeElement).toBe(again);

    fireEvent.click(applyButton());
    expect(
      await screen.findByText("comes off 4 issues (1 in the trash)."),
    ).toBeTruthy();
    await wait(600);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete and apply 7 changes" }),
    );
    await waitFor(() => expect(server.applies()).toHaveLength(1));
    expect(server.applies()[0]?.body).toMatchObject({
      label_issues: { "label.delete:42": 4 },
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull(),
    );
    expect(screen.queryByText(/The preview changed/)).toBeNull();
  });

  it("does not ask again by itself when the counts come back to what it said", async () => {
    const plans = { ...PLANS };
    fakeServer({ plans });
    renderPage();
    await pickKanban();
    fireEvent.click(
      box("Delete label kind:docs — comes off 2 issues (1 in the trash)"),
    );
    fireEvent.click(applyButton());
    await screen.findByRole("button", { name: "Cancel" });

    plans["7"] = {
      ...PLAN_7,
      changes: PLAN_7.changes.map((change) =>
        change.id === "label.delete:42" ? { ...change, issues: 3 } : change,
      ),
    };
    fireEvent(window, new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull(),
    );

    plans["7"] = PLAN_7;
    fireEvent(window, new Event("visibilitychange"));
    await screen.findByRole("checkbox", {
      name: "Delete label kind:docs — comes off 2 issues (1 in the trash)",
    });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("withdraws the question when the number of changes it names moves", async () => {
    const plans = { ...PLANS };
    fakeServer({ plans });
    renderPage();
    await pickKanban();
    fireEvent.click(
      box("Delete label kind:docs — comes off 2 issues (1 in the trash)"),
    );
    fireEvent.click(applyButton());
    await screen.findByRole("button", { name: "Delete and apply 7 changes" });

    // urgent was recoloured to the template's colour meanwhile: one change
    // fewer, the label counts as they were.
    plans["7"] = {
      ...PLAN_7,
      expected: "plan-7-again",
      changes: PLAN_7.changes.filter(
        (change) => change.id !== "label.change:40",
      ),
    };
    fireEvent(window, new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "Apply 6 changes" }),
    ).toBeTruthy();
  });

  it("leaves the focus where the reader moved it when the question is withdrawn", async () => {
    const plans = { ...PLANS };
    fakeServer({ plans });
    renderPage();
    await pickKanban();
    fireEvent.click(
      box("Delete label kind:docs — comes off 2 issues (1 in the trash)"),
    );
    fireEvent.click(applyButton());
    await screen.findByRole("button", { name: "Cancel" });
    // The reader went on to name a template meanwhile.
    const name = screen.getByLabelText("Name");
    name.focus();

    plans["7"] = {
      ...PLAN_7,
      changes: PLAN_7.changes.map((change) =>
        change.id === "label.delete:42" ? { ...change, issues: 3 } : change,
      ),
    };
    fireEvent(window, new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull(),
    );
    expect(document.activeElement).toBe(name);
  });

  it("stops saying why the question was withdrawn once the ticks or the template change", async () => {
    const plans = { ...PLANS };
    fakeServer({ plans });
    renderPage();
    await pickKanban();
    const withdraw = async (issues: number) => {
      fireEvent.click(applyButton());
      await screen.findByRole("button", { name: "Cancel" });
      plans["7"] = {
        ...PLAN_7,
        changes: PLAN_7.changes.map((change) =>
          change.id === "label.delete:42" ? { ...change, issues } : change,
        ),
      };
      fireEvent(window, new Event("visibilitychange"));
      expect(await screen.findByText(/The preview changed/)).toBeTruthy();
    };
    fireEvent.click(
      box("Delete label kind:docs — comes off 2 issues (1 in the trash)"),
    );

    await withdraw(3);
    fireEvent.click(box("Recolour status Done"));
    expect(screen.queryByText(/The preview changed/)).toBeNull();

    await withdraw(5);
    fireEvent.click(option("Basic"));
    expect(screen.queryByText(/The preview changed/)).toBeNull();
  });

  it("applies at once a deletion that takes a label off no card", async () => {
    const server = fakeServer();
    renderPage();
    await pickKanban();
    fireEvent.click(box("Delete label wontfix — on no issue"));
    fireEvent.click(applyButton());
    await waitFor(() => expect(server.applies()).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(server.applies()[0]?.body).toMatchObject({
      label_issues: { "label.delete:43": 0 },
    });
  });

  it("asks too before taking a label off trashed cards alone", async () => {
    const server = fakeServer({
      plans: {
        ...PLANS,
        "7": {
          ...PLAN_7,
          changes: PLAN_7.changes.map((change) =>
            change.id === "label.delete:43"
              ? { ...change, issues: 0, trashed: 2 }
              : change,
          ),
        },
      },
    });
    renderPage();
    await pickKanban();
    fireEvent.click(
      box("Delete label wontfix — comes off 2 issues (2 in the trash)"),
    );
    fireEvent.click(applyButton());
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(server.applies()).toEqual([]);
  });

  it("after an apply, keeps what the reader left out and disarms what they ticked", async () => {
    // Parked took an issue after the preview, so its deletion was skipped;
    // it must not stay ticked, ready for the next Apply. Done's recolour the
    // reader left out must not come back ticked either.
    const warning = vi.spyOn(toast, "warning");
    const server = fakeServer({
      apply: () => json(200, { skipped: ["status.delete:4"] }),
    });
    renderPage();
    await pickKanban();
    fireEvent.click(box("Delete status Parked"));
    fireEvent.click(box("Recolour status Done"));
    fireEvent.click(screen.getByRole("button", { name: "Apply 6 changes" }));
    await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(server.previews()).toHaveLength(2));
    await waitFor(() =>
      expect(box("Delete status Parked").checked).toBe(false),
    );
    expect(box("Recolour status Done").checked).toBe(false);
    expect(box("Add status Review").checked).toBe(true);
  });

  it("does not carry one project's choices to another's", async () => {
    const server = fakeServer();
    const router = renderPage();
    await pickKanban();
    fireEvent.click(box("Recolour status Done"));
    expect(box("Recolour status Done").checked).toBe(false);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Todou's flow" },
    });

    await router.navigate({
      to: "/projects/$slug/settings/template",
      params: { slug: "other" },
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
        "Other",
      ),
    );
    expect(screen.queryByRole("table")).toBeNull();
    await pickKanban();
    expect(server.previewsOf("other")).toHaveLength(1);
    expect(box("Recolour status Done").checked).toBe(true);
  });

  it("asks for a reload, drawing nothing, when an older server sends a plan without the project", async () => {
    const { project: _, template: __, ...older } = PLAN_7;
    const server = fakeServer({
      plans: { ...PLANS, "7": older as TemplateApplyPlan },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("option", { name: "Kanban" }));
    expect(
      await screen.findByText("The server is older than this page."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /Apply/ })).toBeNull();
    expect(server.applies()).toEqual([]);
    expect(kept("todou")).toEqual({ template: 7, rows: [] });
  });

  it("asks for a reload, not another preview, when the server works the apply out otherwise", async () => {
    const server = fakeServer({
      apply: () =>
        json(409, {
          error: {
            code: "drawn_mismatch",
            message:
              "this page and the server apply templates differently — reload the page",
          },
        }),
    });
    renderPage();
    await pickKanban();
    fireEvent.click(box("Recolour status Done"));
    fireEvent.click(box("Delete status Parked"));
    fireEvent.click(screen.getByRole("button", { name: "Apply 6 changes" }));
    expect(
      await screen.findByText(
        "This page and the server apply templates differently.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(server.previews()).toHaveLength(1);
    // What the reader picked is kept for the reloaded page.
    expect(kept("todou")).toEqual({
      template: 7,
      rows: [
        ["status.recolour:3", false],
        ["status.delete:4", true],
      ],
    });
  });

  it("gives up what it kept once the server answers in full again", async () => {
    const { project: _, template: __, ...older } = PLAN_7;
    const plans: Record<string, TemplateApplyPlan> = {
      ...PLANS,
      "7": older as TemplateApplyPlan,
    };
    fakeServer({ plans });
    renderPage();
    fireEvent.click(await screen.findByRole("option", { name: "Kanban" }));
    await screen.findByText("The server is older than this page.");
    expect(kept("todou")).toEqual({ template: 7, rows: [] });

    // The deploy finished: the next preview comes from a new server.
    plans["7"] = PLAN_7;
    fireEvent(window, new Event("visibilitychange"));
    await screen.findByRole("checkbox", { name: "Add status Review" });
    expect(kept("todou")).toBeNull();
  });

  it("still asks for a reload where the tab's storage is refused", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("refused", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("refused", "SecurityError");
    });
    const { project: _, template: __, ...older } = PLAN_7;
    fakeServer({ plans: { ...PLANS, "7": older as TemplateApplyPlan } });
    renderPage();
    fireEvent.click(await screen.findByRole("option", { name: "Kanban" }));
    await screen.findByText("The server is older than this page.");
    // Still there once the page has tried to keep the picks.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(
      screen.getByText("The server is older than this page."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("picks again, once, what was kept for this project before a reload", async () => {
    keep("todou", {
      template: 7,
      rows: [
        ["status.recolour:3", false],
        ["status.delete:4", true],
      ],
    });
    keep("other", { template: "basic", rows: [] });
    const server = fakeServer();
    renderPage();
    await screen.findByRole("checkbox", { name: "Add status Review" });
    expect(option("Kanban").getAttribute("aria-selected")).toBe("true");
    expect(box("Recolour status Done").checked).toBe(false);
    expect(box("Delete status Parked").checked).toBe(true);
    expect(box("Add status Review").checked).toBe(true);
    expect(server.previews().map((c) => c.body)).toEqual([{ template: 7 }]);
    expect(kept("todou")).toBeNull();
    expect(kept("other")).toEqual({ template: "basic", rows: [] });

    // The next visit starts with nothing picked.
    cleanup();
    renderPage();
    const list = await screen.findByRole("listbox", { name: "Templates" });
    expect(within(list).queryAllByRole("option", { selected: true })).toEqual(
      [],
    );
  });

  it("says the project already matches a template with no difference", async () => {
    fakeServer();
    renderPage();
    fireEvent.click(await screen.findByRole("option", { name: "Same" }));
    expect(
      await screen.findByText("This project already matches this template."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Apply/ })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("previews again on a 409, and says nothing was applied", async () => {
    const error = vi.spyOn(toast, "error");
    const server = fakeServer({
      apply: () =>
        json(409, {
          error: {
            code: "conflict",
            message: "the preview is out of date — preview again",
          },
        }),
    });
    renderPage();
    await pickKanban();

    fireEvent.click(screen.getByRole("button", { name: "Apply 6 changes" }));
    await waitFor(() => expect(server.previews()).toHaveLength(2));
    expect(server.previews()[1]?.body).toEqual({ template: 7 });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Nothing was applied"),
    );
  });

  it("keeps a row the reader turned off when the preview comes back with another plan", async () => {
    const plans = { ...PLANS };
    const server = fakeServer({ plans });
    renderPage();
    await pickKanban();
    fireEvent.click(box("Recolour status Done"));

    // Someone recoloured urgent meanwhile: the same rows, another plan.
    plans["7"] = {
      ...PLAN_7,
      expected: "plan-7-again",
      changes: PLAN_7.changes.map((change) =>
        change.type === "label_change"
          ? { ...change, from: "#eab308" }
          : change,
      ),
    };
    fireEvent(window, new Event("visibilitychange"));
    const recoloured = drawn(
      <LabelChip label={{ id: 1, name: "urgent", color: "#eab308" }} />,
    );
    // Untick it to see what it was: the Before side is what it is now.
    await waitFor(() =>
      expect(rowOf("Recolour label urgent").innerHTML).toContain(recoloured),
    );
    expect(box("Recolour status Done").checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Apply 5 changes" }));
    await waitFor(() => expect(server.applies()).toHaveLength(1));
    expect(server.applies()[0]?.body).toMatchObject({
      template: 7,
      expected: "plan-7-again",
      selected: DEFAULT_SELECTED.filter((id) => id !== "status.recolour:3"),
    });
  });

  it("starts a row new to the plan as the server does, and keeps off a row whose requirement is off", async () => {
    // The default status moves to Doing, which the project has.
    const toDoing: ChangeRow[] = PLAN_7.changes.map((change) =>
      change.type === "status_default"
        ? { ...change, requires: [], to: { name: "Doing", color: "#3b82f6" } }
        : change,
    );
    const plans: Record<string, TemplateApplyPlan> = {
      ...PLANS,
      "7": { ...PLAN_7, changes: toDoing },
    };
    fakeServer({ plans });
    renderPage();
    await pickKanban();
    fireEvent.click(box("Add status Review"));
    expect(box("Change default status Todo → Doing").checked).toBe(true);

    // The template moved its default to Review since, and gained a label.
    plans["7"] = {
      ...PLAN_7,
      expected: "plan-7-again",
      changes: [
        ...PLAN_7.changes,
        {
          ...row("label.add:later", "labels", "add"),
          type: "label_add",
          name: "later",
          color: "#64748b",
        },
      ],
    };
    fireEvent(window, new Event("visibilitychange"));
    await screen.findByRole("checkbox", { name: "Add label later" });
    expect(box("Add label later").checked).toBe(true);
    expect(box("Add status Review").checked).toBe(false);
    expect(box("Change default status Todo → Review").checked).toBe(false);
  });

  it("leaves off a row of a kind this page does not know", async () => {
    const server = fakeServer({
      plans: {
        ...PLANS,
        "7": {
          ...PLAN_7,
          changes: [
            ...PLAN_7.changes,
            {
              ...row("status.rename:1", "statuses", "change"),
              type: "status_rename",
              name: "Todo",
            } as unknown as ChangeRow,
          ],
        },
      },
    });
    renderPage();
    await pickKanban();

    fireEvent.click(screen.getByRole("button", { name: "Apply 6 changes" }));
    await waitFor(() => expect(server.applies()).toHaveLength(1));
    expect(server.applies()[0]?.body).toMatchObject({
      selected: DEFAULT_SELECTED,
      drawn: DRAWN_7,
    });
  });

  it("draws each side in the plan's colours, the After side as ticked", async () => {
    fakeServer();
    renderPage();
    await pickKanban();

    const pill = (name: string, color: string) =>
      drawn(<StatusPill status={{ name, color }} />);
    const chip = (name: string, color: string) =>
      drawn(<LabelChip label={{ id: 1, name, color }} />);
    const cell = (box: string, side: "before" | "after") =>
      rowOf(box).querySelector(`[data-cell='${side}']`)?.innerHTML ?? "";

    expect(cell("Recolour status Done", "before")).toContain(
      pill("Done", "#16a34a"),
    );
    expect(cell("Recolour status Done", "after")).toContain(
      pill("Done", "#22c55e"),
    );
    fireEvent.click(box("Recolour status Done"));
    expect(cell("Recolour status Done", "after")).toContain(
      pill("Done", "#16a34a"),
    );
    expect(cell("Add status Review", "after")).toContain(
      pill("Review", "#14b8a6"),
    );
    expect(cell("Recolour label urgent", "before")).toContain(
      chip("urgent", "#f97316"),
    );
    expect(cell("Recolour label urgent", "after")).toContain(
      chip("urgent", "#ef4444"),
    );
  });

  it("draws the template the plan was computed from, not the one listed", async () => {
    // Another tab recoloured Review since the list was read: the plan has
    // the template as the apply will find it.
    const plans = {
      ...PLANS,
      "7": {
        ...PLAN_7,
        template: {
          ...(KANBAN.body as TemplateBody),
          statuses: (KANBAN.body as TemplateBody).statuses.map((status) =>
            status.name === "Review" ? { ...status, color: "#0d9488" } : status,
          ),
        },
        changes: PLAN_7.changes.map((change) =>
          change.type === "status_add"
            ? { ...change, color: "#0d9488" }
            : change,
        ),
      },
    };
    fakeServer({ plans });
    renderPage();
    await pickKanban();
    const review = rowOf("Add status Review").querySelector(
      "[data-cell='after']",
    );
    expect(review?.innerHTML).toContain(
      drawn(<StatusPill status={{ name: "Review", color: "#0d9488" }} />),
    );
  });

  it("draws the project the plan was read from, not another read of its statuses", async () => {
    // Done recoloured since the plan was read: the plan's project is what
    // the apply will check against.
    const statuses = STATUSES.map((status) =>
      status.name === "Done" ? { ...status, color: "#000000" } : status,
    );
    fakeServer({ statuses });
    renderPage({ statuses });
    await pickKanban();
    expect(
      rowOf("Recolour status Done").querySelector("[data-cell='before']")
        ?.innerHTML,
    ).toContain(
      drawn(<StatusPill status={{ name: "Done", color: "#16a34a" }} />),
    );
  });

  it("is not offered to a member who may not manage statuses", async () => {
    const server = fakeServer({ role: "writer" });
    renderPage({ role: "writer" });
    expect(
      await screen.findByRole("heading", { name: "Save as template" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Apply a template" }),
    ).toBeNull();
    expect(server.previews()).toEqual([]);
  });
});

describe("saving the project as a template", () => {
  it("names it after the project, sends the project, and opens the template", async () => {
    const server = fakeServer();
    const router = renderPage();
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(name.value).toBe("Potato field");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        server.calls.filter(
          (c) => c.method === "POST" && c.path === "/me/project-templates",
        ),
      ).toEqual([
        {
          method: "POST",
          path: "/me/project-templates",
          body: { name: "Potato field", from_project: "todou" },
        },
      ]),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/templates/12"),
    );
  });

  it("names it after as much of a long project name as a template name holds", async () => {
    const server = fakeServer();
    // A project's name may run to 200 characters, a template's to 100.
    const long = "Potato field ".repeat(15).trim();
    renderPage({ name: long });
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(name.value).toBe(long.slice(0, 100));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        server.calls.find(
          (c) => c.method === "POST" && c.path === "/me/project-templates",
        )?.body,
      ).toEqual({ name: long.slice(0, 100).trim(), from_project: "todou" }),
    );
  });
});
