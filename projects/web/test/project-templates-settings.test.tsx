import { notifyManager, QueryClientProvider } from "@tanstack/react-query";
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
  type TemplateStatus,
} from "@todou/shared";
import { useState } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import {
  labelsQuery,
  projectsQuery,
  projectTemplatesQuery,
} from "../src/api/queries.ts";
import { referenceDirectoryQuery } from "../src/api/references.ts";
import { StatusPill } from "../src/components/issue/status-pill.tsx";
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

const BASIC: UsableTemplate = {
  ref: "basic",
  name: "Basic",
  builtin: true,
  revision: 0,
  body: BUILTIN_TEMPLATES.basic.body,
};

// Named to sort before Basic, so a list ordered by name alone shows.
const AGILE: UsableTemplate = {
  ref: 9,
  name: "Agile",
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

const TEMPLATES = [BASIC, AGILE, KANBAN];

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
  new_project_template: "basic",
  spec_outline: true,
  spec_outline_comments: true,
  spec_outline_changes: true,
  spec_strip: true,
  spec_strip_comments: true,
  spec_strip_changes: true,
};

const project = (slug: string): Project => ({
  id: slug.length,
  slug,
  name: slug,
  description: "",
  created_at: "2026-01-01T00:00:00Z",
});
const PROJECTS = [project("todou"), project("homelab")];

/**
 * What the `todou` project holds, as its four reads answer. The line and the
 * stored chart role are not what the defaults would give, so a preview that
 * fell back to them shows.
 */
const TODOU_STATUSES = [
  { name: "Todo", category: "open", color: "#6b7280", is_default: true },
  { name: "Doing", category: "open", color: "#3b82f6", is_default: false },
  { name: "Done", category: "closed", color: "#22c55e", is_default: false },
].map((status, i) => ({ ...status, id: i + 1, position: i }));
const TODOU_READS: Record<string, unknown> = {
  "/projects/todou/statuses": TODOU_STATUSES,
  "/projects/todou": { ...project("todou"), block_clear_status_id: 2 },
  "/projects/todou/insights/settings": {
    version: "1",
    source: "saved",
    roles: [
      {
        status_id: 2,
        name: "Doing",
        category: "open",
        color: "#3b82f6",
        position: 1,
        role: "excluded",
      },
    ],
  },
  "/projects/todou/labels": [
    { id: 4, name: "area:web", color: "#0ea5e9" },
    { id: 5, name: "kind:bug", color: "#ef4444" },
  ],
};

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
  const failing = new Set<string>();
  const stored = new Map(templates.map((t) => [t.ref, structuredClone(t)]));
  const waiting: Array<() => void> = [];
  let prefs = PREFS;

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
    const del = path.match(/^\/me\/project-templates\/(\d+)$/);
    if (del && method === "DELETE") {
      stored.delete(Number(del[1]));
      return new Response(null, { status: 204 });
    }
    if (path === "/me/prefs" && method === "PATCH") {
      prefs = { ...prefs, ...body };
      return json(200, prefs);
    }
    if (path === "/me/prefs" && method === "GET") return json(200, prefs);
    if (failing.has(path)) {
      return json(500, { error: { code: "internal", message: "read failed" } });
    }
    const read = TODOU_READS[path];
    if (read !== undefined && method === "GET") return json(200, read);
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
    /** From now on, answer `path` with a 500. */
    fail: (path: string) => failing.add(path),
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

/** Delete the template whose page is open, through its confirmation. */
async function deleteFromPage() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete template" }),
  );
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "Delete this template?" }),
    ).getByRole("button", { name: "Delete template" }),
  );
}

const deletes = (calls: Call[]) => calls.filter((c) => c.method === "DELETE");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * The options' names as a screen reader gets them, not their text: a
 * template's holds the summary under its name too.
 */
const optionNames = (scope: HTMLElement) => {
  const names: string[] = [];
  within(scope).getAllByRole("option", {
    name: (name) => {
      names.push(name);
      return true;
    },
  });
  return names;
};

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
/** Longer than a preview waits before it opens. */
const pastOpenDelay = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 600)));
const follows = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/**
 * The list as a 1280×1000 window lays it out: each row's text from x 333 to
 * its own `ends[name]`, 48px high from its own top, every row's text column
 * running on to 1151, and its actions from 1163.
 */
function layOutRows(ends: Record<string, number>) {
  const tops: Record<string, number> = { Basic: 272, Agile: 336, Kanban: 400 };
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
    1280,
  );
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
    1000,
  );
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const row =
        this.parentElement?.tagName === "LI" ? this.parentElement : null;
      const name = (row ?? this).querySelector("a")?.textContent ?? "";
      if (!(name in ends)) return original.call(this);
      const top = tops[name] as number;
      // The row's actions, 12px past its text column.
      if (row?.lastElementChild === this) return new DOMRect(1163, top, 28, 48);
      const text = this.matches("li [data-slot='hover-card-trigger']");
      if (!(text || row)) return original.call(this);
      const right = text ? (ends[name] as number) : 1151;
      return new DOMRect(333, top, right - 333, 48);
    },
  );
}

/** Where the open preview's wrapper is put, once Radix has placed it. */
const placedAt = (card: HTMLElement, x: number, y: number) =>
  waitFor(() =>
    expect(card.parentElement?.style.transform).toBe(
      `translate(${x}px, ${y}px)`,
    ),
  );

const closePreview = async () => {
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() =>
    expect(
      document.querySelectorAll("[data-slot='hover-card-content']"),
    ).toHaveLength(0),
  );
};

describe("the project templates list", () => {
  it("lists Basic first and sets another template for new projects", async () => {
    const server = fakeServer();
    renderAt("/settings/templates");
    const rows = await screen.findAllByRole("listitem");
    expect(
      rows.map((row) => within(row).getAllByRole("link")[0]?.textContent),
    ).toEqual(["Basic", "Agile", "Kanban"]);
    for (const row of rows) {
      expect(
        within(row).queryByRole("button", { name: "Set as default" }),
      ).toBeNull();
    }

    const select = screen.getByRole("combobox", {
      name: "New projects start from",
    });
    expect(select.textContent).toBe("Basic");
    fireEvent.keyDown(select, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Kanban" }));
    await waitFor(() =>
      expect(server.calls.filter((c) => c.method === "PATCH")).toEqual([
        {
          method: "PATCH",
          path: "/me/prefs",
          body: { new_project_template: 7 },
        },
      ]),
    );
    expect(select.textContent).toBe("Kanban");
  });

  it("says in each row where the template's blocks clear", async () => {
    fakeServer();
    renderAt("/settings/templates");
    const rows = await screen.findAllByRole("listitem");
    const note = (name: string) => {
      const row = rows.find((r) => within(r).queryByRole("link", { name }));
      // The innermost element holding the whole line, whatever elements its
      // parts are drawn in and whatever wraps it.
      const whole = (element: Element) =>
        /^\d+ status.*Blocks clear at/.test(element.textContent ?? "");
      return within(row as HTMLElement).getByText(
        (_, element) =>
          element !== null &&
          whole(element) &&
          ![...element.children].some(whole),
      );
    };
    const shipped = BASIC.body.statuses.find((s) => s.name === "Shipped");
    expect(note("Basic").innerHTML).toContain(
      render(<StatusPill status={shipped as TemplateStatus} />, {
        container: document.createElement("div"),
      }).container.innerHTML,
    );
    expect(note("Basic").textContent).toMatch(/Blocks clear at\s*Shipped$/);
    expect(note("Agile").textContent).toMatch(
      /Blocks clear at any closed status$/,
    );
  });

  it("opens no preview from a row's buttons, or under its delete confirmation", async () => {
    fakeServer();
    renderAt("/settings/templates");
    const rows = await screen.findAllByRole("listitem");
    const kanban = within(
      rows.find((r) =>
        within(r).queryByRole("link", { name: "Kanban" }),
      ) as HTMLElement,
    );
    const remove = kanban.getByRole("button", { name: "Delete Kanban" });
    hover(remove);
    fireEvent.click(remove);
    expect(
      await screen.findByRole("dialog", { name: "Delete this template?" }),
    ).toBeTruthy();
    await pastOpenDelay();
    expect(
      document.querySelectorAll("[data-slot='hover-card-content']"),
    ).toHaveLength(0);
  });

  it("opens every row's preview in one column, left of the row's actions", async () => {
    fakeServer();
    renderAt("/settings/templates");
    // Basic, built in, has no delete button; Kanban's text is longer.
    layOutRows({ Basic: 633, Kanban: 693 });
    hover(await screen.findByRole("link", { name: "Basic" }));
    // 1151 − 320: the card's right edge on the text column's.
    await placedAt(await previewCard(), 831, 272);
    await closePreview();
    hover(screen.getByRole("link", { name: "Kanban" }));
    await placedAt(await previewCard(), 831, 400);
  });

  it("opens it past the row's own text when the column would cover it", async () => {
    fakeServer();
    renderAt("/settings/templates");
    layOutRows({ Kanban: 900 });
    hover(await screen.findByRole("link", { name: "Kanban" }));
    await placedAt(await previewCard(), 908, 400);
  });

  it("opens no preview from a row's empty space", async () => {
    fakeServer();
    renderAt("/settings/templates");
    const rows = await screen.findAllByRole("listitem");
    const kanban = rows.find((r) =>
      within(r).queryByRole("link", { name: "Kanban" }),
    ) as HTMLElement;
    // The column the row's text sits in, which runs on past it.
    hover(kanban.firstElementChild as Element);
    await pastOpenDelay();
    expect(
      document.querySelectorAll("[data-slot='hover-card-content']"),
    ).toHaveLength(0);
  });

  it("keeps focus on the list after a template is deleted", async () => {
    fakeServer();
    renderAt("/settings/templates");
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete Agile" }),
    );
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Delete this template?" }),
      ).getByRole("button", { name: "Delete template" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Agile" })).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Delete Kanban" }),
      ),
    );
  });

  it("moves focus to the row before, then to New template, as the last rows go", async () => {
    fakeServer();
    renderAt("/settings/templates");
    const remove = async (name: string) => {
      fireEvent.click(
        await screen.findByRole("button", { name: `Delete ${name}` }),
      );
      fireEvent.click(
        within(
          await screen.findByRole("dialog", { name: "Delete this template?" }),
        ).getByRole("button", { name: "Delete template" }),
      );
      await waitFor(() => {
        expect(screen.queryByRole("link", { name })).toBeNull();
        expect(screen.queryByRole("dialog")).toBeNull();
      });
    };
    // Kanban is the last row: no row after it.
    await remove("Kanban");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Delete Agile" }),
      ),
    );
    // Agile is the only one left that can go: Basic, before it, cannot.
    await remove("Agile");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /New template/ }),
      ),
    );
  });

  it("previews a template's default status, line, chart roles and labels on hover", async () => {
    fakeServer();
    renderAt("/settings/templates");
    hover(await screen.findByRole("link", { name: "Basic" }));
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
    expect(
      inRow.getByRole("button", { name: "Delete From the future" }),
    ).toBeTruthy();
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "New projects start from" }),
      { key: "ArrowDown" },
    );
    expect(
      (await screen.findAllByRole("option")).map((o) => o.textContent),
    ).toEqual(["Basic", "Agile", "Kanban"]);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryAllByRole("option")).toEqual([]));

    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    const dialog = await screen.findByRole("dialog");
    expect(optionNames(dialog)).not.toContain("From the future");
  });

  it("can be deleted from its page", async () => {
    const server = fakeServer({ templates });
    const router = renderAt("/settings/templates/11", undefined, templates);
    expect(await screen.findByText("Incompatible")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Use for new projects" }),
    ).toBeNull();

    await deleteFromPage();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/templates"),
    );
    await waitFor(() => expect(screen.queryByText(FUTURE.name)).toBeNull());
    expect(deletes(server.calls).map((c) => c.path)).toEqual([
      "/me/project-templates/11",
    ]);
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

  it("refuses a new status differing only in case from one it holds", async () => {
    const error = vi.spyOn(toast, "error");
    const server = fakeServer();
    renderAt("/settings/templates/7");
    await screen.findByText("Doing");
    await addStatus("done");
    await settle();
    expect(error).toHaveBeenCalledWith('status "done" already exists');
    expect(server.puts()).toHaveLength(0);
  });

  it("lets a status or a label change only its own case", async () => {
    const server = fakeServer();
    renderAt("/settings/templates/7");
    await screen.findByText("Doing");

    const statuses = within(statusesSection() as HTMLElement);
    fireEvent.click(statuses.getByRole("button", { name: "edit status Done" }));
    fireEvent.change(statuses.getByPlaceholderText("In Review"), {
      target: { value: "DONE" },
    });
    await act(async () => {
      fireEvent.click(statuses.getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    expect(server.puts()[0]?.body).toMatchObject({
      body: {
        statuses: [{ name: "Todo" }, { name: "Doing" }, { name: "DONE" }],
      },
    });

    const labels = within(
      screen
        .getByRole("heading", { name: "Labels" })
        .closest("section") as HTMLElement,
    );
    fireEvent.click(
      labels.getByRole("button", { name: "edit label kind:bug" }),
    );
    fireEvent.change(labels.getByPlaceholderText("area:web"), {
      target: { value: "KIND:BUG" },
    });
    await act(async () => {
      fireEvent.click(labels.getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(server.puts()).toHaveLength(2));
    expect(server.puts()[1]?.body).toMatchObject({
      body: { labels: [{ name: "KIND:BUG", color: "#ef4444" }] },
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

  it("renames in place: Enter sends the whole template with the new name; Esc sends nothing", async () => {
    const server = fakeServer();
    renderAt("/settings/templates/7");
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const field = screen.getByRole("textbox", {
      name: "Template name",
    }) as HTMLInputElement;
    expect(field.value).toBe(KANBAN.name);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([
      0,
      KANBAN.name.length,
    ]);
    fireEvent.change(field, { target: { value: "Board" } });
    // What Enter does in a browser: happy-dom submits no form on a key.
    fireEvent.submit(field);
    // At once, not only once the save has put it in the list.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Board");
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    expect(server.puts()[0]?.body).toEqual({
      revision: 3,
      name: "Board",
      body: KANBAN.body,
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Board");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Rename" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const again = screen.getByRole("textbox", { name: "Template name" });
    fireEvent.change(again, { target: { value: "Never" } });
    fireEvent.keyDown(again, { key: "Escape" });
    await settle();
    expect(server.puts()).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Board");
  });

  it("a rename made while a status save is in flight goes out after it, carrying both", async () => {
    const server = fakeServer({ hold: true });
    renderAt("/settings/templates/7");
    await screen.findByText("Doing");
    await addStatus("Review");
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "Template name" });
    fireEvent.change(field, { target: { value: "Board" } });
    fireEvent.submit(field);
    await settle();
    expect(server.puts()).toHaveLength(1);

    await server.release();
    await waitFor(() => expect(server.puts()).toHaveLength(2));
    expect(server.puts()[1]?.body).toEqual({
      revision: 4,
      name: "Board",
      body: {
        statuses: [...KANBAN.body.statuses, added("Review")],
        labels: KANBAN.body.labels,
      },
    });
  });

  it("sets the account's new-project template from a template's page, and does nothing when pressed again", async () => {
    const server = fakeServer();
    renderAt("/settings/templates/7");
    const use = await screen.findByRole("button", {
      name: "Use for new projects",
    });
    expect(use.getAttribute("aria-pressed")).toBe("false");
    expect(use.getAttribute("aria-disabled")).toBeNull();
    const patches = () => server.calls.filter((c) => c.method === "PATCH");

    fireEvent.click(use);
    await waitFor(() => expect(use.getAttribute("aria-pressed")).toBe("true"));
    expect(use.getAttribute("aria-disabled")).toBe("true");
    expect(patches()).toEqual([
      {
        method: "PATCH",
        path: "/me/prefs",
        body: { new_project_template: 7 },
      },
    ]);

    fireEvent.click(use);
    await settle();
    expect(patches()).toHaveLength(1);
  });

  it("marks the built-in template as in use only when no other usable template is", async () => {
    fakeServer();
    const client = testQueryClient();
    renderAt(`/settings/templates/${BASIC.ref}`, client);
    act(() => {
      client.setQueryData(prefsQuery.queryKey, {
        ...PREFS,
        new_project_template: 7,
      });
    });
    const use = await screen.findByRole("button", {
      name: "Use for new projects",
    });
    await waitFor(() => expect(use.getAttribute("aria-pressed")).toBe("false"));

    // Gone, as when the template new projects used was deleted.
    act(() => {
      client.setQueryData(prefsQuery.queryKey, {
        ...PREFS,
        new_project_template: 99,
      });
    });
    await waitFor(() => expect(use.getAttribute("aria-pressed")).toBe("true"));
  });

  it("duplicates the built-in template under a name typed in the dialog, then opens the copy", async () => {
    const server = fakeServer();
    const router = renderAt(`/settings/templates/${BASIC.ref}`);
    fireEvent.click(await screen.findByRole("button", { name: "Duplicate" }));
    const dialog = within(
      await screen.findByRole("dialog", { name: `Duplicate ${BASIC.name}` }),
    );
    let field = dialog.getByLabelText("Name") as HTMLInputElement;
    expect(field.value).toBe(`${BASIC.name} copy`);
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect([field.selectionStart, field.selectionEnd]).toEqual([
      0,
      field.value.length,
    ]);

    // Closed with a name typed, it offers the copy's name again when reopened.
    fireEvent.change(field, { target: { value: "Abandoned" } });
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const reopened = within(await screen.findByRole("dialog"));
    field = reopened.getByLabelText("Name") as HTMLInputElement;
    expect(field.value).toBe(`${BASIC.name} copy`);

    fireEvent.change(field, { target: { value: "Mine" } });
    fireEvent.click(reopened.getByRole("button", { name: "Duplicate" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/templates/12"),
    );
    expect(server.calls.filter((c) => c.method === "POST")).toEqual([
      {
        method: "POST",
        path: "/me/project-templates",
        body: { name: "Mine", body: BASIC.body },
      },
    ]);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(
      "Mine",
    );
    expect(server.calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });

  it("suggests a copy name within 100 characters", async () => {
    const long: UsableTemplate = { ...KANBAN, ref: 8, name: "x".repeat(100) };
    const templates = [...TEMPLATES, long];
    const server = fakeServer({ templates });
    renderAt("/settings/templates/8", undefined, templates);
    fireEvent.click(await screen.findByRole("button", { name: "Duplicate" }));
    const dialog = within(await screen.findByRole("dialog"));
    const suggested = (dialog.getByLabelText("Name") as HTMLInputElement).value;
    // As much of the name as fits beside " copy" in 100 characters.
    expect(suggested).toBe(`${"x".repeat(95)} copy`);

    fireEvent.click(dialog.getByRole("button", { name: "Duplicate" }));
    await waitFor(() =>
      expect(
        server.calls.filter((c) => c.method === "POST").map((c) => c.body),
      ).toEqual([{ name: suggested, body: long.body }]),
    );
  });

  it("cuts a name for its copy between characters, never inside one", async () => {
    // The emoji's two UTF-16 halves are the 95th and 96th code units.
    const long: UsableTemplate = {
      ...KANBAN,
      ref: 8,
      name: `${"x".repeat(94)}😀xxxx`,
    };
    const templates = [...TEMPLATES, long];
    fakeServer({ templates });
    renderAt("/settings/templates/8", undefined, templates);
    fireEvent.click(await screen.findByRole("button", { name: "Duplicate" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect((dialog.getByLabelText("Name") as HTMLInputElement).value).toBe(
      `${"x".repeat(94)} copy`,
    );
  });

  it("deletes a template from its page, then shows the list without it, never the missing-template page", async () => {
    const server = fakeServer();
    const missing = "You have no template at this address.";
    let shown = false;
    // Records keep what was added, however soon the page replaces it.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const nodes = [record.target, ...record.addedNodes];
        if (nodes.some((node) => node.textContent?.includes(missing))) {
          shown = true;
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // A list change renders the moment it is made, not on the next timer
    // tick: whether the page shows the template missing then depends on the
    // order alone, not on which of two timers fires first.
    notifyManager.setScheduler((callback) => callback());
    try {
      const router = renderAt("/settings/templates/7");
      await deleteFromPage();
      await waitFor(() =>
        expect(router.state.location.pathname).toBe("/settings/templates"),
      );
      await waitFor(() =>
        expect(screen.queryByRole("link", { name: KANBAN.name })).toBeNull(),
      );
      expect(screen.getByRole("link", { name: AGILE.name })).toBeTruthy();
      expect(deletes(server.calls).map((c) => c.path)).toEqual([
        "/me/project-templates/7",
      ]);
      await settle();
      expect(shown).toBe(false);
    } finally {
      notifyManager.setScheduler((callback) => setTimeout(callback, 0));
      observer.disconnect();
    }
  });

  it("a delete waits for an edit still being saved", async () => {
    const error = vi.spyOn(toast, "error");
    const server = fakeServer({ hold: true });
    renderAt("/settings/templates/7");
    await screen.findByText("Doing");
    await addStatus("Review");
    await deleteFromPage();
    await settle();
    expect(server.puts()).toHaveLength(1);
    expect(deletes(server.calls)).toEqual([]);
    // Closed, it would read as called off, and an edit made then would be
    // queued behind the delete.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await settle();
    expect(
      screen.getByRole("dialog", { name: "Delete this template?" }),
    ).toBeTruthy();

    await server.release();
    await waitFor(() => expect(deletes(server.calls)).toHaveLength(1));
    expect(
      server.calls.indexOf(deletes(server.calls)[0] as Call),
    ).toBeGreaterThan(server.calls.indexOf(server.puts()[0] as Call));
    expect(error).not.toHaveBeenCalled();
  });

  it("a delete that lands once its page is left keeps the user where they went", async () => {
    const server = fakeServer({ hold: true });
    const router = renderAt("/settings/templates/7");
    await screen.findByText("Doing");
    await addStatus("Review");
    await deleteFromPage();
    await settle();
    // Away while the confirmation is open, as Back would go: no dialog
    // holds history off.
    await act(() => router.history.push(`/settings/templates/${AGILE.ref}`));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        AGILE.name,
      ),
    );

    await server.release();
    await waitFor(() => expect(deletes(server.calls)).toHaveLength(1));
    await settle();
    expect(router.state.location.pathname).toBe(
      `/settings/templates/${AGILE.ref}`,
    );
  });

  it("a delete that lands once its page is left and opened again still leaves it for the list", async () => {
    const server = fakeServer({ hold: true });
    const router = renderAt("/settings/templates/7");
    await screen.findByText("Doing");
    await addStatus("Review");
    await deleteFromPage();
    await settle();
    // Away, then Back, before the delete has gone out.
    await act(() => router.history.push(`/settings/templates/${AGILE.ref}`));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        AGILE.name,
      ),
    );
    await act(() => router.history.back());
    await screen.findByText("Doing");
    // Still on its way: the page says so, and takes no edit before it lands.
    const waiting = await screen.findByRole("dialog", {
      name: "Delete this template?",
    });
    expect(
      (
        within(waiting).getByRole("button", {
          name: "Delete template",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await server.release();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/templates"),
    );
  });

  it("shows Basic with nothing to change", async () => {
    fakeServer();
    renderAt("/settings/templates/basic");
    await screen.findByText("Backlog");
    expect(screen.queryByRole("button", { name: /New status/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /New label/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete template" }),
    ).toBeNull();
  });
});

// Nine, past the count where the search box appears.
const MANY: ProjectTemplate[] = [
  BASIC,
  ...[
    "Agile",
    "Kanban",
    "Kanban lite",
    "Ops",
    "Research",
    "Scrum",
    "Support",
    "Writing",
  ].map((name, i) => ({ ...AGILE, ref: 20 + i, name })),
];

function Picker({ projects }: { projects: Project[] }) {
  const [value, setValue] = useState<StartFrom>({
    kind: "template",
    template: "basic",
    project: null,
  });
  return (
    <StartFromPicker
      templates={MANY}
      projects={projects}
      value={value}
      onChange={setValue}
    />
  );
}

function renderPicker(projects = PROJECTS) {
  const client = testQueryClient();
  client.setQueryData(referenceDirectoryQuery.queryKey, null);
  return renderWithProviders(<Picker projects={projects} />, client);
}

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

  it("puts the keyboard cursor on the chosen project", async () => {
    renderPicker();
    await screen.findByRole("listbox", { name: "Templates" });
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    const list = screen.getByRole("listbox", { name: "Projects" });
    const homelab = within(list).getByRole("option", { name: /homelab/ });
    fireEvent.click(homelab);
    expect(list.getAttribute("aria-activedescendant")).toBe(homelab.id);
  });

  it("asks for no project when there is none to pick", async () => {
    renderPicker([]);
    await screen.findByRole("listbox", { name: "Templates" });
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(screen.getByText("No project to start from.")).toBeTruthy();
    expect(screen.queryByText("Pick a project to start from.")).toBeNull();
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
  async function openDialog(client = testQueryClient()) {
    const router = renderAt("/settings/templates", client);
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

  it("previews a template on hover; a press in the preview picks nothing and keeps the dialog", async () => {
    fakeServer();
    const { dialog } = await openDialog();
    const kanban = dialog.getByRole("option", { name: "Kanban" });
    hover(within(kanban).getByText("Kanban"));
    const card = await previewCard();
    const doing = within(card).getByText("Doing");
    fireEvent.pointerDown(doing, { pointerType: "mouse" });
    fireEvent.mouseDown(doing);
    fireEvent.pointerUp(doing, { pointerType: "mouse" });
    fireEvent.mouseUp(doing);
    fireEvent.click(doing);
    await settle();
    expect(screen.getByRole("dialog", { name: "New template" })).toBeTruthy();
    const selected = (name: string) =>
      dialog.getByRole("option", { name }).getAttribute("aria-selected");
    expect(selected("Basic")).toBe("true");
    expect(selected("Kanban")).toBe("false");
  });

  it("previews a template from the summary under its name as well", async () => {
    fakeServer();
    const { dialog } = await openDialog();
    const kanban = dialog.getByRole("option", { name: "Kanban" });
    hover(within(kanban).getByText(/statuses/));
    const card = await previewCard();
    expect(within(card).getByText("Doing")).toBeTruthy();
  });

  it("lets a wheel over the preview scroll it, until it has no room left", async () => {
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

    // At its end the card has no room left, and the lock keeps the page
    // behind the dialog where it is.
    card.scrollTop = 600;
    const past = new WheelEvent("wheel", {
      deltaY: 100,
      bubbles: true,
      cancelable: true,
    });
    within(card).getByText("Doing").dispatchEvent(past);
    expect(past.defaultPrevented).toBe(true);
  });

  it("previews a project on hover, reading it only once the card opens", async () => {
    const server = fakeServer();
    const { dialog } = await openDialog();
    fireEvent.click(dialog.getByRole("button", { name: "Project" }));
    const reads = () =>
      server.calls
        .filter((c) => c.path.startsWith("/projects/todou"))
        .map((c) => c.path)
        .sort();
    const todou = dialog.getByRole("option", { name: /todou/ });
    await settle();
    expect(reads()).toEqual([]);

    hover(within(todou).getAllByText("todou")[0] as HTMLElement);
    const card = await previewCard();
    await within(card).findByText("Doing");
    expect(reads()).toEqual(Object.keys(TODOU_READS).sort());
    // Todo is the default, the line sits on Doing, which is open but counts
    // as excluded; Done is closed.
    const marks = [
      "Todo",
      "default",
      "Blocks clear below",
      "Doing",
      "excluded from charts",
      "Done",
      "closed",
    ].map((text) => within(card).getByText(text));
    marks.slice(1).forEach((mark, i) => {
      expect(follows(marks[i] as Element, mark), mark.textContent ?? "").toBe(
        true,
      );
    });
    expect(
      [...card.querySelectorAll("[title]")].map((chip) =>
        chip.getAttribute("title"),
      ),
    ).toEqual(["area:web", "kind:bug"]);

    // A press in it neither picks the project nor closes the dialog.
    const doing = within(card).getByText("Doing");
    fireEvent.pointerDown(doing, { pointerType: "mouse" });
    fireEvent.mouseDown(doing);
    fireEvent.pointerUp(doing, { pointerType: "mouse" });
    fireEvent.mouseUp(doing);
    fireEvent.click(doing);
    await settle();
    expect(screen.getByRole("dialog", { name: "New template" })).toBeTruthy();
    expect(todou.getAttribute("aria-selected")).toBe("false");
  });

  it("keeps a project's preview when a reread of it fails", async () => {
    const server = fakeServer();
    const client = testQueryClient();
    const { dialog } = await openDialog(client);
    fireEvent.click(dialog.getByRole("button", { name: "Project" }));
    const name = within(
      dialog.getByRole("option", { name: /todou/ }),
    ).getAllByText("todou")[0] as HTMLElement;
    hover(name);
    await within(await previewCard()).findByText("kind:", { exact: false });
    fireEvent.pointerOut(name, {
      pointerType: "mouse",
      bubbles: true,
      relatedTarget: document.body,
    });
    await waitFor(() =>
      expect(
        document.querySelectorAll("[data-slot='hover-card-content']"),
      ).toHaveLength(0),
    );

    // The labels are reread as the card opens again, and the reread fails.
    server.fail("/projects/todou/labels");
    await act(() =>
      client.invalidateQueries({ queryKey: labelsQuery("todou").queryKey }),
    );
    hover(name);
    const card = await previewCard();
    await waitFor(() =>
      expect(client.getQueryState(labelsQuery("todou").queryKey)?.status).toBe(
        "error",
      ),
    );
    expect(
      server.calls.filter((c) => c.path === "/projects/todou/labels"),
    ).toHaveLength(2);
    expect(within(card).getByText("Doing")).toBeTruthy();
    expect(
      [...card.querySelectorAll("[title]")].map((chip) =>
        chip.getAttribute("title"),
      ),
    ).toEqual(["area:web", "kind:bug"]);
    expect(within(card).queryByText("read failed")).toBeNull();
  });

  it("says a project must be picked before Create", async () => {
    fakeServer();
    const { dialog } = await openDialog();
    const create = dialog.getByRole("button", {
      name: "Create",
    }) as HTMLButtonElement;
    fireEvent.click(dialog.getByRole("button", { name: "Project" }));
    expect(dialog.getByText("Pick a project to start from.")).toBeTruthy();
    expect(create.disabled).toBe(true);
    fireEvent.click(dialog.getByRole("option", { name: /todou/ }));
    expect(dialog.queryByText("Pick a project to start from.")).toBeNull();
    expect(create.disabled).toBe(false);
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
