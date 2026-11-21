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
  spec_outline: true,
  spec_outline_comments: true,
  spec_outline_changes: true,
  spec_strip: true,
  spec_strip_comments: true,
  spec_strip_changes: true,
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

const STATUSES: Status[] = [
  ["Todo", "open", "#6b7280"],
  ["Doing", "open", "#3b82f6"],
  ["Done", "closed", "#16a34a"],
  ["Parked", "open", "#a855f7"],
  ["Discard", "closed", "#64748b"],
].map(([name, category, color], i) => ({
  id: i + 1,
  name: name as string,
  category: category as Status["category"],
  color: color as string,
  position: i,
  is_default: name === "Todo",
}));

const row = (
  id: string,
  section: "statuses" | "labels",
  action: "add" | "change" | "delete",
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
      ...row("status.change:3", "statuses", "change"),
      type: "status_change",
      name: "Done",
      color_now: "#16a34a",
      color: { from: "#16a34a", to: "#22c55e" },
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
      ...row("label.change:40", "labels", "change"),
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
  ],
};

/** What the server starts selected in PLAN_7: its additions and changes. */
const DEFAULT_SELECTED = [
  "status.add:Review",
  "status.change:3",
  "status.default",
  "label.add:kind:bug",
  "label.change:40",
];

/** The boxes of those rows, by name. */
const DEFAULT_BOXES = [
  "Add status Review",
  "Change status Done",
  "Change the default status",
  "Add label kind:bug",
  "Change label urgent",
];

const PLAN_BASIC: TemplateApplyPlan = {
  expected: "plan-basic",
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
  "8": { expected: "plan-8", changes: [] },
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
  apply = (): Response => json(200, { skipped: [] }),
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
      return json(200, STATUSES);
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
  preferred = 7 as MePrefs["new_project_template"],
  name = "Potato field",
} = {}) {
  const client = testQueryClient();
  client.setQueryData(projectQuery("todou").queryKey, project(role, name));
  client.setQueryData(projectTemplatesQuery.queryKey, TEMPLATES);
  client.setQueryData(prefsQuery.queryKey, {
    ...PREFS,
    new_project_template: preferred,
  });
  client.setQueryData(statusesQuery("todou").queryKey, STATUSES);

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

const checkedRows = () =>
  [...document.querySelectorAll("li input[type=checkbox]")]
    .filter((input) => (input as HTMLInputElement).checked)
    .map((input) => input.getAttribute("aria-label"));

/** Wait for PLAN_7's rows. */
const rowsOf7 = () =>
  screen.findByRole("checkbox", { name: "Add status Review" });

const section = (name: string) => within(screen.getByRole("region", { name }));

const rowOf = (name: string) => box(name).closest("li") as HTMLElement;

/** How a component draws `ui`, rendered apart from the page. */
const drawn = (ui: ReactElement) =>
  render(ui, { container: document.createElement("div") }).container.innerHTML;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("applying a template", () => {
  it("previews the preferred template, additions and changes selected, no deletion", async () => {
    const server = fakeServer();
    renderPage();
    await rowsOf7();
    expect(server.previews()).toEqual([
      { method: "POST", path: PREVIEW, body: { template: 7 } },
    ]);

    for (const name of DEFAULT_BOXES) {
      expect(box(name).checked, name).toBe(true);
    }
    for (const name of [
      "Delete status Parked",
      "Delete status Discard",
      "Delete label area:web",
      "Delete label kind:docs",
    ]) {
      expect(box(name).checked, name).toBe(false);
    }
    expect(box("Delete status Parked").disabled).toBe(false);
    // Two issues in it and one in the trash, which holds a delete off too.
    expect(box("Delete status Discard").disabled).toBe(true);
    expect(rowOf("Delete status Discard").textContent).toMatch(
      /(?<!\d)3 issues\b/,
    );
  });

  it("selects a section's deletions from its heading, and clears them again", async () => {
    fakeServer();
    renderPage();
    await rowsOf7();
    const labels = section("Labels");

    fireEvent.click(labels.getByRole("checkbox", { name: "Delete" }));
    expect(box("Delete label area:web").checked).toBe(true);
    expect(box("Delete label kind:docs").checked).toBe(true);
    expect(box("Delete status Parked").checked).toBe(false);

    fireEvent.click(labels.getByRole("checkbox", { name: "Delete" }));
    expect(box("Delete label area:web").checked).toBe(false);
    expect(box("Delete label kind:docs").checked).toBe(false);
    expect(checkedRows()).toEqual(DEFAULT_BOXES);
  });

  it("keeps the default status and the status it needs together", async () => {
    fakeServer();
    renderPage();
    await rowsOf7();

    fireEvent.click(box("Add status Review"));
    expect(box("Add status Review").checked).toBe(false);
    expect(box("Change the default status").checked).toBe(false);

    fireEvent.click(box("Change the default status"));
    expect(box("Change the default status").checked).toBe(true);
    expect(box("Add status Review").checked).toBe(true);
  });

  it("counts the selected rows on Apply, and holds it back with none", async () => {
    fakeServer();
    renderPage();
    await rowsOf7();
    const apply = () => screen.getByRole("button", { name: /^Apply/ });

    expect(apply().textContent).toBe("Apply 5 changes");
    expect((apply() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(box("Delete status Parked"));
    expect(apply().textContent).toBe("Apply 6 changes");

    // The default status before the status it needs, so each click clears
    // one box whatever the rows hanging together do.
    for (const name of [
      "Delete status Parked",
      "Change the default status",
      "Add status Review",
      "Change status Done",
      "Add label kind:bug",
      "Change label urgent",
    ]) {
      fireEvent.click(box(name));
    }
    expect(checkedRows()).toEqual([]);
    expect(apply().textContent).toBe("Apply 0 changes");
    expect((apply() as HTMLButtonElement).disabled).toBe(true);
  });

  it("previews another template when one is picked, and applies that preview", async () => {
    const server = fakeServer();
    renderPage();
    await rowsOf7();

    fireEvent.click(screen.getByRole("option", { name: "Basic" }));
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
    });
  });

  it("sends the selected rows and says what was done, a skipped deletion included", async () => {
    const success = vi.spyOn(toast, "success");
    const warning = vi.spyOn(toast, "warning");
    const server = fakeServer({
      apply: () => json(200, { skipped: ["status.delete:4"] }),
    });
    renderPage();
    await rowsOf7();

    fireEvent.click(box("Delete status Parked"));
    fireEvent.click(screen.getByRole("button", { name: "Apply 6 changes" }));
    await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
    expect(server.applies()[0]?.body).toEqual({
      template: 7,
      expected: "plan-7",
      selected: [
        "status.add:Review",
        "status.change:3",
        "status.default",
        "status.delete:4",
        "label.add:kind:bug",
        "label.change:40",
      ],
    });
    const said = String(warning.mock.calls[0]?.[0]);
    expect(said).toContain("Applied 5 changes.");
    expect(said).toContain("Parked");
    expect(success).not.toHaveBeenCalled();
    // The project changed: what is left of the template is previewed again.
    await waitFor(() => expect(server.previews()).toHaveLength(2));
  });

  it("after an apply, keeps what the reader left out and disarms what they ticked", async () => {
    // Parked took an issue after the preview, so its deletion was skipped;
    // it must not stay ticked, ready for the next Apply. Done's change the
    // reader left out must not come back ticked either.
    const warning = vi.spyOn(toast, "warning");
    const server = fakeServer({
      apply: () => json(200, { skipped: ["status.delete:4"] }),
    });
    renderPage();
    await rowsOf7();
    fireEvent.click(box("Delete status Parked"));
    fireEvent.click(box("Change status Done"));
    fireEvent.click(screen.getByRole("button", { name: "Apply 5 changes" }));
    await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(server.previews()).toHaveLength(2));
    await waitFor(() =>
      expect(box("Delete status Parked").checked).toBe(false),
    );
    expect(box("Change status Done").checked).toBe(false);
    expect(box("Add status Review").checked).toBe(true);
  });

  it("does not carry one project's choices to another's", async () => {
    const server = fakeServer();
    const router = renderPage();
    await rowsOf7();
    fireEvent.click(box("Change status Done"));
    expect(box("Change status Done").checked).toBe(false);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Todou's flow" },
    });

    await router.navigate({
      to: "/projects/$slug/settings/template",
      params: { slug: "other" },
    });
    await waitFor(() => expect(server.previewsOf("other")).toHaveLength(1));
    await waitFor(() => expect(box("Change status Done").checked).toBe(true));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Other",
    );
  });

  it("counts the trashed cards a label deletion takes it off", async () => {
    fakeServer();
    renderPage();
    await rowsOf7();
    expect(rowOf("Delete label kind:docs").textContent).toContain(
      "comes off 2 issues (1 in the trash)",
    );
    expect(rowOf("Delete label area:web").textContent).toContain(
      "comes off 3 issues",
    );
    expect(rowOf("Delete label area:web").textContent).not.toContain("trash");
  });

  it("says the project already matches a template with no difference", async () => {
    fakeServer();
    renderPage({ preferred: 8 });
    expect(
      await screen.findByText("This project already matches this template."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("previews again on a 409, and says nothing was applied", async () => {
    const error = vi.spyOn(toast, "error");
    const server = fakeServer({
      apply: () =>
        json(409, {
          error: {
            code: "conflict",
            message: "project or template changed — preview again",
          },
        }),
    });
    renderPage();
    await rowsOf7();

    fireEvent.click(screen.getByRole("button", { name: "Apply 5 changes" }));
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
    await rowsOf7();
    fireEvent.click(box("Change status Done"));

    // Someone recoloured urgent meanwhile: the same rows, another plan.
    plans["7"] = {
      expected: "plan-7-again",
      changes: PLAN_7.changes.map((change) =>
        change.type === "label_change"
          ? { ...change, from: "#eab308" }
          : change,
      ),
    };
    fireEvent(window, new Event("visibilitychange"));
    const recoloured = drawn(
      <LabelChip label={{ id: 0, name: "urgent", color: "#eab308" }} />,
    );
    await waitFor(() =>
      expect(rowOf("Change label urgent").innerHTML).toContain(recoloured),
    );
    expect(box("Change status Done").checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Apply 4 changes" }));
    await waitFor(() => expect(server.applies()).toHaveLength(1));
    expect(server.applies()[0]?.body).toEqual({
      template: 7,
      expected: "plan-7-again",
      selected: DEFAULT_SELECTED.filter((id) => id !== "status.change:3"),
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
      "7": { expected: "plan-7", changes: toDoing },
    };
    fakeServer({ plans });
    renderPage();
    await rowsOf7();
    fireEvent.click(box("Add status Review"));
    expect(box("Change the default status").checked).toBe(true);

    // The template moved its default to Review since, and gained a label.
    plans["7"] = {
      expected: "plan-7-again",
      changes: [
        ...PLAN_7.changes,
        {
          ...row("label.add:wontfix", "labels", "add"),
          type: "label_add",
          name: "wontfix",
          color: "#64748b",
        },
      ],
    };
    fireEvent(window, new Event("visibilitychange"));
    await screen.findByRole("checkbox", { name: "Add label wontfix" });
    expect(box("Add label wontfix").checked).toBe(true);
    expect(box("Add status Review").checked).toBe(false);
    expect(box("Change the default status").checked).toBe(false);
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
    await rowsOf7();

    fireEvent.click(screen.getByRole("button", { name: "Apply 5 changes" }));
    await waitFor(() => expect(server.applies()).toHaveLength(1));
    expect(server.applies()[0]?.body).toMatchObject({
      selected: DEFAULT_SELECTED,
    });
  });

  it("draws each row's statuses and labels in the row's colours", async () => {
    fakeServer();
    renderPage();
    await rowsOf7();

    const pill = (name: string, color: string) =>
      drawn(<StatusPill status={{ name, color }} />);
    const chip = (name: string, color: string) =>
      drawn(<LabelChip label={{ id: 0, name, color }} />);
    const html = (name: string) => rowOf(name).innerHTML;

    expect(html("Add status Review")).toContain(pill("Review", "#14b8a6"));
    expect(html("Add status Review")).toContain(pill("Doing", "#3b82f6"));
    expect(html("Change status Done")).toContain(pill("Done", "#16a34a"));
    expect(html("Change status Done")).toContain(pill("Done", "#22c55e"));
    expect(html("Change the default status")).toContain(
      pill("Todo", "#6b7280"),
    );
    expect(html("Change the default status")).toContain(
      pill("Review", "#14b8a6"),
    );
    expect(html("Delete status Discard")).toContain(pill("Discard", "#64748b"));
    expect(html("Add label kind:bug")).toContain(chip("kind:bug", "#ef4444"));
    expect(html("Change label urgent")).toContain(chip("urgent", "#f97316"));
    expect(html("Change label urgent")).toContain(chip("urgent", "#ef4444"));
    expect(html("Delete label area:web")).toContain(
      chip("area:web", "#0ea5e9"),
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
