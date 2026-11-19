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
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  BUILTIN_TEMPLATES,
  type MePrefs,
  type Project,
  type ProjectTemplate,
} from "@todou/shared";
import { useState } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import { projectsQuery, projectTemplatesQuery } from "../src/api/queries.ts";
import { referenceDirectoryQuery } from "../src/api/references.ts";
import {
  type StartFrom,
  StartFromPicker,
  type UsableTemplate,
} from "../src/components/start-from-picker.tsx";
import {
  ProjectTemplateSettingsPage,
  ProjectTemplatesSettingsPage,
} from "../src/pages/project-templates-settings.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const DEFAULT: UsableTemplate = {
  ref: "default",
  name: "Default",
  builtin: true,
  revision: 0,
  body: BUILTIN_TEMPLATES.default.body,
};

// Named to sort before Default, so a list ordered by name alone shows.
const BUGS: UsableTemplate = {
  ref: 9,
  name: "Bugs",
  builtin: false,
  revision: 0,
  body: {
    statuses: [
      {
        name: "Open",
        category: "open",
        color: "#ef4444",
        chart_role: "remaining",
      },
    ],
    labels: [],
  },
};

const KANBAN: UsableTemplate = {
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
        is_default: true,
      },
      {
        name: "Doing",
        category: "open",
        color: "#3b82f6",
        chart_role: "remaining",
      },
      {
        name: "Done",
        category: "closed",
        color: "#22c55e",
        chart_role: "completed",
        block_clear: true,
      },
    ],
    labels: [{ name: "kind:bug", color: "#ef4444" }],
  },
};

const TEMPLATES = [DEFAULT, BUGS, KANBAN];

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
  new_project_template: "default",
};

const project = (slug: string): Project => ({
  id: slug.length,
  slug,
  name: slug,
  description: "",
  created_at: "2026-01-01T00:00:00Z",
});
const PROJECTS = [project("todou"), project("homelab")];

type Call = { method: string; path: string; body: unknown };

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The template routes as the server answers them: a PUT is refused with 409
 * unless it names the stored revision, and bumps it by one when it does.
 * With `hold`, each PUT waits for `release()` before it is answered.
 */
function fakeServer({
  hold = false,
  templates = TEMPLATES as ProjectTemplate[],
} = {}) {
  const calls: Call[] = [];
  const stored = new Map(templates.map((t) => [t.ref, structuredClone(t)]));
  const waiting: Array<() => void> = [];

  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input), "http://test").pathname.replace(
      /^\/api/,
      "",
    );
    const method = init?.method ?? "GET";
    const body =
      init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, path, body });

    if (path === "/me/project-templates" && method === "GET") {
      return json(200, [...stored.values()]);
    }
    if (path === "/me/project-templates" && method === "POST") {
      const created: UsableTemplate = {
        ref: 12,
        name: body.name,
        builtin: false,
        revision: 0,
        body: body.body ?? KANBAN.body,
      };
      stored.set(created.ref, created);
      return json(201, created);
    }
    const put = path.match(/^\/me\/project-templates\/(\d+)$/);
    if (put && method === "PUT") {
      if (hold) await new Promise<void>((resolve) => waiting.push(resolve));
      const current = stored.get(Number(put[1])) as ProjectTemplate;
      if (body.revision !== current.revision) {
        return json(409, {
          error: {
            code: "conflict",
            message: "template changed — reload before saving",
            details: { current_revision: current.revision },
          },
        });
      }
      const saved = {
        ...current,
        name: body.name,
        body: body.body,
        revision: current.revision + 1,
      };
      stored.set(saved.ref, saved);
      return json(200, saved);
    }
    if (path === "/me/prefs" && method === "PATCH") {
      return json(200, { ...PREFS, ...body });
    }
    return json(404, { error: { code: "not_found", message: path } });
  }) as typeof fetch);

  return {
    calls,
    puts: () =>
      calls.filter(
        (c) => c.method === "PUT" && c.path === "/me/project-templates/7",
      ),
    /** Answer the oldest PUT still waiting. */
    release: () => act(async () => waiting.shift()?.()),
    /** Another tab saves template 7, twice, before this one's PUT lands. */
    changeElsewhere: (change: (t: UsableTemplate) => UsableTemplate) => {
      const current = stored.get(7) as UsableTemplate;
      stored.set(7, { ...change(current), revision: current.revision + 2 });
    },
    /** The templates as a GET would answer now. */
    list: () => [...stored.values()],
  };
}

/**
 * The two template pages at their real paths. `/authed` mirrors the app's
 * id prefix, which the template page's `useParams({ from })` names.
 */
function renderAt(
  url: string,
  client = testQueryClient(),
  templates: ProjectTemplate[] = TEMPLATES,
) {
  client.setQueryData(projectTemplatesQuery.queryKey, templates);
  client.setQueryData(prefsQuery.queryKey, PREFS);
  client.setQueryData(projectsQuery.queryKey, PROJECTS);
  client.setQueryData(referenceDirectoryQuery.queryKey, null);

  const rootRoute = createRootRoute();
  const authed = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    component: Outlet,
  });
  const settings = createRoute({
    getParentRoute: () => authed,
    path: "/settings",
    component: Outlet,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authed.addChildren([
        settings.addChildren([
          createRoute({
            getParentRoute: () => settings,
            path: "templates",
            component: ProjectTemplatesSettingsPage,
          }),
          createRoute({
            getParentRoute: () => settings,
            path: "templates/$template",
            component: ProjectTemplateSettingsPage,
          }),
        ]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const statusesSection = () =>
  screen.getByRole("heading", { name: "Statuses" }).closest("section");

/** Add a status through the list's own editor, in a colour picked outright. */
async function addStatus(name: string) {
  const section = within(statusesSection() as HTMLElement);
  fireEvent.click(section.getByRole("button", { name: /New status/ }));
  fireEvent.change(section.getByPlaceholderText("In Review"), {
    target: { value: name },
  });
  fireEvent.click(
    section.getByRole("button", { name: `set ${name} color #14b8a6` }),
  );
  // Async: the editor closes once the list hears the edit was taken.
  await act(async () => {
    fireEvent.click(section.getByRole("button", { name: "Create" }));
  });
}

const added = (name: string) => ({
  name,
  category: "open",
  color: "#14b8a6",
  chart_role: "remaining",
});

/** Long enough for a request that is going to be sent to have been. */
const settle = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const hover = (el: Element) =>
  fireEvent.pointerOver(el, { pointerType: "mouse", bubbles: true });
/** The one preview open, once its delay has run. */
const previewCard = () =>
  waitFor(() => {
    const cards = document.querySelectorAll<HTMLElement>(
      "[data-slot='hover-card-content']",
    );
    expect(cards).toHaveLength(1);
    return cards[0] as HTMLElement;
  });
const follows = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("the project templates list", () => {
  it("lists Default first and sets another template as the default", async () => {
    const server = fakeServer();
    renderAt("/settings/templates");
    const rows = await screen.findAllByRole("listitem");
    expect(
      rows.map((row) => within(row).getAllByRole("link")[0]?.textContent),
    ).toEqual(["Default", "Bugs", "Kanban"]);
    expect(within(rows[0] as HTMLElement).getByText("default")).toBeTruthy();

    fireEvent.click(
      within(rows[2] as HTMLElement).getByRole("button", {
        name: "Set as default",
      }),
    );
    await waitFor(() =>
      expect(server.calls.filter((c) => c.method === "PATCH")).toEqual([
        {
          method: "PATCH",
          path: "/me/prefs",
          body: { new_project_template: 7 },
        },
      ]),
    );
  });

  it("previews a template's default status, line, chart roles and labels on hover", async () => {
    fakeServer();
    renderAt("/settings/templates");
    hover(await screen.findByRole("link", { name: "Default" }));
    const card = await previewCard();
    const statuses = within(
      within(card)
        .getByRole("heading", { name: "Statuses" })
        .closest("section") as HTMLElement,
    );
    // Each mark between its own status and the next: Todo is the default,
    // the line sits on Shipped, which is open but counts as completed.
    const marks = [
      "Todo",
      "default",
      "Next",
      "Ready to Ship",
      "Blocks clear below",
      "Shipped",
      "completed in charts",
      "Done",
    ].map((text) => statuses.getByText(text));
    marks.slice(1).forEach((mark, i) => {
      expect(follows(marks[i] as Element, mark), mark.textContent ?? "").toBe(
        true,
      );
    });
    const labels = within(card)
      .getByRole("heading", { name: "Labels" })
      .closest("section") as HTMLElement;
    expect(
      [...labels.querySelectorAll("[title]")].map((chip) =>
        chip.getAttribute("title"),
      ),
    ).toEqual(["kind:bug", "kind:chore", "kind:feature", "needs-brainstorm"]);
  });
});

describe("a template this version cannot read", () => {
  const FUTURE: ProjectTemplate = {
    ref: 11,
    name: "From the future",
    builtin: false,
    revision: 3,
    body: null,
    problems: [
      { path: "statuses", message: "only one status may be marked is_default" },
    ],
  };
  const templates = [...TEMPLATES, FUTURE];

  it("is listed as incompatible, with no counts and no way to make it the default", async () => {
    fakeServer({ templates });
    renderAt("/settings/templates", undefined, templates);
    const rows = await screen.findAllByRole("listitem");
    const row = rows.find((r) => r.textContent?.includes("From the future"));
    expect(row).toBeDefined();
    const inRow = within(row as HTMLElement);
    expect(inRow.getByText("Incompatible")).toBeTruthy();
    expect(inRow.queryByText(/statuses/)).toBeNull();
    expect(inRow.queryByRole("button", { name: "Set as default" })).toBeNull();
    expect(
      inRow.getByRole("button", { name: "Delete From the future" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(
      dialog.getAllByRole("option").map((option) => option.textContent),
    ).not.toContain("From the future");
  });

  it("says on its page where it cannot be read", async () => {
    fakeServer({ templates });
    renderAt("/settings/templates/11", undefined, templates);
    expect(await screen.findByText("Incompatible")).toBeTruthy();
    expect(screen.getByText("statuses")).toBeTruthy();
    expect(
      screen.getByText("only one status may be marked is_default"),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Statuses" })).toBeNull();
  });
});

describe("a template's page", () => {
  it("sends the whole template with a new status and the current revision", async () => {
    const server = fakeServer();
    renderAt("/settings/templates/7");
    await screen.findByText("Doing");
    await addStatus("Review");
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    expect(server.puts()[0]?.body).toEqual({
      revision: 3,
      name: "Kanban",
      body: {
        statuses: [...KANBAN.body.statuses, added("Review")],
        labels: KANBAN.body.labels,
      },
    });
  });

  it("sends a second edit after the first, with the revision it got back", async () => {
    const server = fakeServer({ hold: true });
    renderAt("/settings/templates/7");
    await screen.findByText("Doing");
    await addStatus("Review");
    await addStatus("QA");
    await settle();
    expect(server.puts()).toHaveLength(1);

    await server.release();
    await waitFor(() => expect(server.puts()).toHaveLength(2));
    expect(server.puts()[1]?.body).toEqual({
      revision: 4,
      name: "Kanban",
      body: {
        statuses: [...KANBAN.body.statuses, added("Review"), added("QA")],
        labels: KANBAN.body.labels,
      },
    });
  });

  it("on a 409 refetches, says so, and drops the edit queued behind it", async () => {
    const error = vi.spyOn(toast, "error");
    const server = fakeServer({ hold: true });
    renderAt("/settings/templates/7");
    await screen.findByText("Doing");
    await addStatus("Review");
    await addStatus("QA");
    await settle();
    server.changeElsewhere((t) => ({
      ...t,
      body: {
        ...t.body,
        labels: [...t.body.labels, { name: "elsewhere", color: "#8b5cf6" }],
      },
    }));

    await server.release();
    expect(await screen.findByText("elsewhere")).toBeTruthy();
    expect(error).toHaveBeenCalledWith(
      "This template changed elsewhere — your last change was not saved.",
    );
    const refetch = server.calls.findLastIndex(
      (c) => c.method === "GET" && c.path === "/me/project-templates",
    );
    expect(refetch).toBeGreaterThan(
      server.calls.indexOf(server.puts()[0] as Call),
    );
    await settle();
    expect(server.puts()).toHaveLength(1);
    expect(screen.queryByText("QA")).toBeNull();

    // An edit made on the refetched template goes out on its revision.
    await addStatus("Later");
    await waitFor(() => expect(server.puts()).toHaveLength(2));
    await server.release();
    expect(server.puts()[1]?.body).toMatchObject({
      revision: 5,
      body: {
        statuses: [...KANBAN.body.statuses, added("Later")],
        labels: [...KANBAN.body.labels, { name: "elsewhere" }],
      },
    });
  });

  it("sends a queued edit on the revision the save before it got back, not one a refetch brought in", async () => {
    const error = vi.spyOn(toast, "error");
    const server = fakeServer({ hold: true });
    const elsewhere = { name: "elsewhere", color: "#8b5cf6" };
    const client = testQueryClient();
    // A list refetch lands just as the first save comes back, with a label
    // another tab saved after it.
    const unsubscribe = client.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      unsubscribe();
      server.changeElsewhere((t) => ({
        ...t,
        body: { ...t.body, labels: [...t.body.labels, elsewhere] },
      }));
      client.setQueryData(projectTemplatesQuery.queryKey, server.list());
    });
    renderAt("/settings/templates/7", client);
    await screen.findByText("Doing");
    await addStatus("Review");
    await addStatus("QA");
    await settle();

    await server.release();
    await waitFor(() => expect(server.puts()).toHaveLength(2));
    await server.release();
    await settle();
    // QA was added to the template before that label: sent, it would take
    // the label off again.
    expect(server.list().find((t) => t.ref === 7)?.body?.labels).toContainEqual(
      elsewhere,
    );
    expect(error).toHaveBeenCalledWith(
      "This template changed elsewhere — your last change was not saved.",
    );
  });

  it("shows Default with nothing to change", async () => {
    fakeServer();
    renderAt("/settings/templates/default");
    await screen.findByText("Backlog");
    expect(screen.queryByRole("button", { name: /New status/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /New label/ })).toBeNull();
  });
});

// Nine, past the count where the search box appears.
const MANY: ProjectTemplate[] = [
  DEFAULT,
  ...[
    "Bugs",
    "Kanban",
    "Kanban lite",
    "Ops",
    "Research",
    "Scrum",
    "Support",
    "Writing",
  ].map((name, i) => ({ ...BUGS, ref: 20 + i, name })),
];

function Picker() {
  const [value, setValue] = useState<StartFrom>({
    kind: "template",
    template: "default",
    project: null,
  });
  return (
    <StartFromPicker
      templates={MANY}
      projects={PROJECTS}
      value={value}
      onChange={setValue}
    />
  );
}

function renderPicker() {
  const client = testQueryClient();
  client.setQueryData(referenceDirectoryQuery.queryKey, null);
  return renderWithProviders(<Picker />, client);
}

const optionNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole("option")
    .map((option) => option.textContent);

describe("StartFromPicker", () => {
  it("lists the viewer's projects once Project is picked", async () => {
    renderPicker();
    await screen.findByRole("listbox", { name: "Templates" });
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    const list = within(screen.getByRole("listbox", { name: "Projects" }));
    expect(list.getAllByRole("option")).toHaveLength(2);
    expect(list.getByRole("option", { name: /todou/ })).toBeTruthy();
    expect(list.getByRole("option", { name: /homelab/ })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Templates" })).toBeNull();
  });

  it("narrows the templates to those whose name holds the search", async () => {
    renderPicker();
    const list = await screen.findByRole("listbox", { name: "Templates" });
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "KAN" },
    });
    expect(optionNames(list)).toEqual(["Kanban", "Kanban lite"]);
  });
});

describe("the New template dialog", () => {
  async function openDialog() {
    const router = renderAt("/settings/templates");
    fireEvent.click(
      await screen.findByRole("button", { name: /New template/ }),
    );
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), {
      target: { value: "Copy" },
    });
    return { router, dialog };
  }

  const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

  it("copies the body of the template it starts from", async () => {
    const server = fakeServer();
    const { dialog } = await openDialog();
    fireEvent.click(dialog.getByRole("option", { name: "Kanban" }));
    fireEvent.click(dialog.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts(server.calls)).toHaveLength(1));
    expect(posts(server.calls)[0]).toEqual({
      method: "POST",
      path: "/me/project-templates",
      body: { name: "Copy", body: KANBAN.body },
    });
  });

  it("previews a template on hover, and a click in the preview picks nothing", async () => {
    fakeServer();
    const { dialog } = await openDialog();
    const kanban = dialog.getByRole("option", { name: "Kanban" });
    hover(within(kanban).getByText("Kanban"));
    const card = await previewCard();
    fireEvent.click(within(card).getByText("Doing"));
    const selected = (name: string) =>
      dialog.getByRole("option", { name }).getAttribute("aria-selected");
    expect(selected("Default")).toBe("true");
    expect(selected("Kanban")).toBe("false");
  });

  it("lets a wheel over the preview scroll it", async () => {
    fakeServer();
    const { dialog } = await openDialog();
    hover(
      within(dialog.getByRole("option", { name: "Kanban" })).getByText(
        "Kanban",
      ),
    );
    const card = await previewCard();
    // happy-dom lays nothing out: the card is handed the room its
    // `overflow-y-auto` and height cap give it in a browser.
    card.style.overflowY = "auto";
    for (const [property, value] of [
      ["scrollHeight", 1000],
      ["clientHeight", 400],
      ["scrollTop", 0],
    ] as const) {
      Object.defineProperty(card, property, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const wheel = new WheelEvent("wheel", {
      deltaY: 100,
      bubbles: true,
      cancelable: true,
    });
    within(card).getByText("Doing").dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it("names the project it starts from, then opens the new template", async () => {
    const server = fakeServer();
    const { router, dialog } = await openDialog();
    fireEvent.click(dialog.getByRole("button", { name: "Project" }));
    fireEvent.click(dialog.getByRole("option", { name: /todou/ }));
    fireEvent.click(dialog.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts(server.calls)).toHaveLength(1));
    expect(posts(server.calls)[0]?.body).toEqual({
      name: "Copy",
      from_project: "todou",
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/templates/12"),
    );
  });
});
