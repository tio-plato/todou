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
import {
  type Agent,
  BUILTIN_TEMPLATES,
  type MePrefs,
  type Project,
  type ProjectTemplate,
  type TemplateRef,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import {
  agentsQuery,
  projectsQuery,
  projectTemplatesQuery,
} from "../src/api/queries.ts";
import { referenceDirectoryQuery } from "../src/api/references.ts";
import { ProjectsPage } from "../src/pages/projects.tsx";
import { testQueryClient } from "./render.tsx";

const template = (
  ref: TemplateRef,
  name: string,
  builtin = false,
): ProjectTemplate => ({
  ref,
  name,
  builtin,
  revision: 0,
  body: BUILTIN_TEMPLATES.default.body,
});
const TEMPLATES = [
  template("default", "Default", true),
  template(9, "Bugs"),
  template(7, "Kanban"),
];

const project = (slug: string): Project => ({
  id: slug.length,
  slug,
  name: slug,
  description: "",
  created_at: "2026-01-01T00:00:00Z",
});
const PROJECTS = [project("todou"), project("homelab")];

const agent = (
  id: number,
  login: string,
  overrides: Partial<Agent> = {},
): Agent => ({
  id,
  login,
  display_name: login,
  kind: "machine",
  avatar_url: null,
  owner: { id: 1, login: "user" },
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
  disabled_at: null,
  new_project_role: null,
  ...overrides,
});
const AGENTS = [
  agent(11, "bot-one", { new_project_role: "reporter" }),
  agent(12, "helper-bot"),
  agent(13, "retired-bot", {
    new_project_role: "writer",
    disabled_at: "2026-02-01T00:00:00Z",
  }),
];

const prefs = (new_project_template: TemplateRef): MePrefs => ({
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
  new_project_template,
});

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The reads the dialog makes, answered as the server would, and every
 * `POST /projects` body as it went over the wire. With `holdAgents`, the
 * agent list is neither cached nor answered until `releaseAgents()`.
 */
function renderDialog({
  preferred = "default",
  holdAgents = false,
}: {
  preferred?: TemplateRef;
  holdAgents?: boolean;
} = {}) {
  const posts: Record<string, unknown>[] = [];
  let releaseAgents = () => {};
  const agentsAnswered = new Promise<void>((resolve) => {
    releaseAgents = resolve;
  });
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input), "http://test").pathname.replace(
      /^\/api/,
      "",
    );
    const method = init?.method ?? "GET";
    if (path === "/projects" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      posts.push(body);
      return json(201, project(body.slug));
    }
    if (path === "/projects") return json(200, PROJECTS);
    if (path === "/me/project-templates") return json(200, TEMPLATES);
    if (path === "/me/prefs") return json(200, prefs(preferred));
    if (path === "/agents") {
      if (holdAgents) await agentsAnswered;
      return json(200, AGENTS);
    }
    return json(404, { error: { code: "not_found", message: path } });
  }) as typeof fetch);

  const client = testQueryClient();
  client.setQueryData(projectsQuery.queryKey, PROJECTS);
  client.setQueryData(projectTemplatesQuery.queryKey, TEMPLATES);
  client.setQueryData(prefsQuery.queryKey, prefs(preferred));
  client.setQueryData(referenceDirectoryQuery.queryKey, null);
  if (!holdAgents) client.setQueryData(agentsQuery.queryKey, AGENTS);

  // ProjectsPage reads /authed/projects search, as in
  // create-project-ref-format.test.tsx.
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectsRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects",
    component: ProjectsPage,
    validateSearch: (search): { new?: boolean } =>
      search.new === true || search.new === 1 || search.new === "1"
        ? { new: true }
        : {},
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([projectsRoute, projectRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/projects?new=1"] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    posts,
    releaseAgents: () => act(async () => releaseAgents()),
  };
}

/** The open dialog, with the one field Create needs filled in. */
async function openDialog() {
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Name"), {
    target: { value: "Potato" },
  });
  return dialog;
}

type Dialog = Awaited<ReturnType<typeof openDialog>>;

const selectedTemplates = (dialog: Dialog) =>
  within(dialog.getByRole("listbox", { name: "Templates" }))
    .getAllByRole("option")
    .filter((option) => option.getAttribute("aria-selected") === "true")
    .map((option) => option.textContent);

const create = (dialog: Dialog) =>
  fireEvent.click(dialog.getByRole("button", { name: "Create" }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("New project: Start from", () => {
  it("starts from the template the prefs name", async () => {
    renderDialog({ preferred: 7 });
    const dialog = await openDialog();
    expect(selectedTemplates(dialog)).toEqual(["Kanban"]);
  });

  it("starts from Default when the template the prefs name is gone", async () => {
    renderDialog({ preferred: 99 });
    const dialog = await openDialog();
    expect(selectedTemplates(dialog)).toEqual(["Default"]);
  });

  it("offers templates or projects only, and sends the template chosen", async () => {
    const { posts } = renderDialog();
    const dialog = await openDialog();
    expect(
      within(dialog.getByRole("group", { name: "Start from" }))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Template", "Project"]);
    expect(
      within(dialog.getByRole("listbox", { name: "Templates" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Default", "Bugs", "Kanban"]);

    fireEvent.click(dialog.getByRole("option", { name: "Bugs" }));
    create(dialog);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ slug: "potato", template: 9 });
    expect(posts[0]).not.toHaveProperty("from_project");
  });

  it("sends the project chosen in place of a template", async () => {
    const { posts } = renderDialog({ preferred: 7 });
    const dialog = await openDialog();
    fireEvent.click(dialog.getByRole("button", { name: "Project" }));
    fireEvent.click(dialog.getByRole("option", { name: /todou/ }));
    create(dialog);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ slug: "potato", from_project: "todou" });
    expect(posts[0]).not.toHaveProperty("template");
  });
});

describe("New project: Agents", () => {
  it("ticks an agent that joins new projects, in its own role", async () => {
    const { posts } = renderDialog();
    const dialog = await openDialog();
    const box = dialog.getByRole("checkbox", {
      name: /@bot-one/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(
      dialog.getByRole("combobox", { name: "Role for bot-one" }).textContent,
    ).toBe("reporter");
    const helper = dialog.getByRole("checkbox", {
      name: /@helper-bot/,
    }) as HTMLInputElement;
    expect(helper.checked).toBe(false);
    expect(
      dialog.getByRole("combobox", { name: "Role for helper-bot" }).textContent,
    ).toBe("writer");
    expect(dialog.queryByRole("checkbox", { name: /@retired-bot/ })).toBeNull();

    create(dialog);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.agents).toEqual([{ login: "bot-one", role: "reporter" }]);
  });

  it("sends an empty agent list once the ticked agent is unticked", async () => {
    const { posts } = renderDialog();
    const dialog = await openDialog();
    fireEvent.click(dialog.getByRole("checkbox", { name: /@bot-one/ }));
    create(dialog);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.agents).toEqual([]);
  });

  // Sent before the list is in, the request would carry no agents at all,
  // and bot-one would not join though its setting says to.
  it("holds Create until the agent list is in", async () => {
    const { posts, releaseAgents } = renderDialog({ holdAgents: true });
    const dialog = await openDialog();
    const button = dialog.getByRole("button", {
      name: "Create",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    await releaseAgents();
    await waitFor(() => expect(button.disabled).toBe(false));
    create(dialog);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.agents).toEqual([{ login: "bot-one", role: "reporter" }]);
  });
});
