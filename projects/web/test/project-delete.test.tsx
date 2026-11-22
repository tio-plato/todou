import type { QueryClient } from "@tanstack/react-query";
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
import type { Member, Project } from "@todou/shared";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectQuery, projectsQuery } from "../src/api/queries.ts";
import { DeleteProjectSection } from "../src/components/settings/delete-project-section.tsx";
import { testQueryClient } from "./render.tsx";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PROJECT: Project = {
  id: 1,
  slug: "potato-field",
  name: "My potato field",
  description: "",
  created_at: "2026-08-01T00:00:00.000Z",
  former_slugs: [],
  viewer_role: "admin",
};

const GREENHOUSE: Project = {
  ...PROJECT,
  id: 2,
  slug: "greenhouse",
  name: "Greenhouse",
};

const member = (id: number, login: string): Member => ({
  user: {
    id,
    login,
    display_name: login,
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  role: "writer",
  created_at: "2026-08-01T00:00:00.000Z",
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type Call = { url: string; method: string };

/** What the server says `potato-field` is; a test may hand the slug on. */
let served: Project = PROJECT;
/** How the server answers the project list; a test may hold it back. */
let listing: () => Promise<Response> = async () => json(200, [GREENHOUSE]);

/**
 * Answers every read the section and its dialog send, by URL; `onDelete`
 * answers the DELETE, so each test decides how the server takes it.
 */
function stubFetch(
  onDelete: () => Promise<Response> = async () =>
    new Response(null, { status: 204 }),
): Call[] {
  served = PROJECT;
  listing = async () => json(200, [GREENHOUSE]);
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "DELETE") return onDelete();
    if (url.includes("/issues/counts")) {
      return json(200, { open: 10, closed: 4, by_status: {} });
    }
    if (url.endsWith("/members")) {
      return json(200, [
        member(1, "alice"),
        member(2, "bob"),
        member(3, "claude-agent"),
      ]);
    }
    if (url.includes("/reference-directory")) {
      return json(200, { entries: [], contested: [], slug_entries: [] });
    }
    if (url.includes("/prefs")) return json(200, {});
    if (url.endsWith("/api/projects/potato-field")) return json(200, served);
    if (url.endsWith("/api/projects")) return listing();
    return json(404, { error: { code: "not_found", message: "not found" } });
  }) as typeof fetch);
  return calls;
}

const deletes = (calls: Call[]) => calls.filter((c) => c.method === "DELETE");

/**
 * Waits out any delete that was started: `mutate` counts it at once but sends
 * its fetch a few ticks later, so "no DELETE yet" alone proves nothing.
 */
const settle = (client: QueryClient) =>
  waitFor(() => expect(client.isMutating()).toBe(0));

/**
 * Mounts the section at /projects/$slug/settings beside a /projects page, so
 * the redirect after a delete has somewhere real to land.
 */
function renderSection(
  project: Project = PROJECT,
  seed: (client: QueryClient) => void = () => {},
) {
  const client = testQueryClient();
  client.setQueryData(projectQuery(project.slug).queryKey, project);
  seed(client);
  const rootRoute = createRootRoute();
  const projectsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects",
    component: () => <p>project list</p>,
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
  });
  const settingsRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "settings",
    component: () => (
      <>
        <h1>General</h1>
        <DeleteProjectSection slug={project.slug} />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      projectsRoute,
      projectRoute.addChildren([settingsRoute]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/projects/${project.slug}/settings`],
    }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, client, unmount: view.unmount };
}

/** Opens the dialog and returns it, still on its first step. */
async function openDialog() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete this project" }),
  );
  return screen.getByRole("dialog");
}

/** Opens the dialog, moves it to the step with the slug box, returns both. */
async function openSlugStep() {
  const dialog = await openDialog();
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "I want to delete this project",
    }),
  );
  return { dialog, input: within(dialog).getByRole("textbox") };
}

const confirmButton = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", {
    name: "Delete this project",
  }) as HTMLButtonElement;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("DeleteProjectSection", () => {
  it("is there only for a viewer who may delete the project", async () => {
    stubFetch();
    const writer = renderSection({ ...PROJECT, viewer_role: "writer" });
    await screen.findByText("General");
    expect(screen.queryByRole("button", { name: "Delete this project" })).toBe(
      null,
    );
    writer.unmount();

    renderSection();
    expect(
      await screen.findByRole("button", { name: "Delete this project" }),
    ).toBeTruthy();
  });

  it("shows the project first and asks for the slug only on the next step", async () => {
    const calls = stubFetch();
    const { client } = renderSection();
    const dialog = await openDialog();
    expect(within(dialog).getByText("My potato field")).toBeTruthy();
    // 10 open + 4 closed, as the list's two tabs count them.
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", {
          description: "potato-field · 14 issues · 3 members",
        }),
      ).toBeTruthy(),
    );
    expect(within(dialog).queryByRole("textbox")).toBe(null);

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "I want to delete this project",
      }),
    );
    const input = within(dialog).getByRole("textbox");
    await waitFor(() => expect(document.activeElement).toBe(input));
    await settle(client);
    expect(deletes(calls)).toEqual([]);
  });

  it("holds the delete back until the box says exactly the slug", async () => {
    const calls = stubFetch();
    const { client } = renderSection();
    const { dialog, input } = await openSlugStep();

    const wrong = [
      "My potato field",
      "potato",
      "POTATO-FIELD",
      "potato-field-2",
    ];
    for (const typed of wrong) {
      fireEvent.change(input, { target: { value: typed } });
      expect(confirmButton(dialog).disabled).toBe(true);
      // Enter in a form's only text box submits it, button or no button.
      fireEvent.submit(input);
      await settle(client);
      expect(deletes(calls)).toEqual([]);
    }

    fireEvent.change(input, { target: { value: " potato-field " } });
    expect(confirmButton(dialog).disabled).toBe(false);
  });

  it("deletes the project by id and goes to the project list", async () => {
    const calls = stubFetch();
    const { router } = renderSection();
    const { input } = await openSlugStep();
    fireEvent.change(input, { target: { value: "potato-field" } });
    // Enter, as a phone keyboard's Go sends it.
    fireEvent.submit(input);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects"),
    );
    expect(deletes(calls).map((c) => c.url)).toEqual(["/api/projects/1"]);
    // In place of the settings page, which is gone, not on top of it.
    expect(router.history.length).toBe(1);
    expect(toast.success).toHaveBeenCalledWith("Deleted My potato field");
  });

  it("keeps the dialog open when the server refuses", async () => {
    let refuse = () => {};
    stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          refuse = () =>
            resolve(
              json(403, { error: { code: "forbidden", message: "Forbidden" } }),
            );
        }),
    );
    const { router } = renderSection();
    const { dialog, input } = await openSlugStep();
    fireEvent.change(input, { target: { value: "potato-field" } });
    fireEvent.click(confirmButton(dialog));

    const sending = (await within(dialog).findByRole("button", {
      name: "Deleting…",
    })) as HTMLButtonElement;
    expect(sending.disabled).toBe(true);
    refuse();
    await waitFor(() => expect(confirmButton(dialog).disabled).toBe(false));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(router.state.location.pathname).toBe(
      "/projects/potato-field/settings",
    );
    expect(toast.error).toHaveBeenCalledWith("Forbidden");
  });

  it("starts over from the first step after a cancel", async () => {
    stubFetch();
    renderSection();
    const first = await openSlugStep();
    fireEvent.change(first.input, { target: { value: "potato-field" } });
    fireEvent.click(
      within(first.dialog).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));

    const dialog = await openDialog();
    expect(within(dialog).queryByRole("textbox")).toBe(null);
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "I want to delete this project",
      }),
    );
    expect(
      (within(dialog).getByRole("textbox") as HTMLInputElement).value,
    ).toBe("");
    expect(confirmButton(dialog).disabled).toBe(true);
  });

  it("cannot be closed or sent twice while the delete is on its way", async () => {
    const calls = stubFetch(() => new Promise<Response>(() => {}));
    const { client } = renderSection();
    const { dialog, input } = await openSlugStep();
    fireEvent.change(input, { target: { value: "potato-field" } });
    fireEvent.click(confirmButton(dialog));

    const cancel = within(dialog).getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    await waitFor(() => expect(cancel.disabled).toBe(true));
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.getByRole("dialog")).toBe(dialog);
    fireEvent.submit(input);
    expect(client.isMutating()).toBe(1);
    await waitFor(() => expect(deletes(calls)).toHaveLength(1));

    // Not even when another project takes the slug over meanwhile.
    served = { ...PROJECT, id: 2, name: "Someone else's field" };
    await act(() =>
      client.invalidateQueries({ queryKey: ["project", "potato-field"] }),
    );
    // The cache tells its observers on a timer of its own; let it.
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("leaves nothing of the deleted project in the cache", async () => {
    stubFetch();
    const project = { ...PROJECT, former_slugs: ["old-field"] };
    const { router, client } = renderSection(project, (c) => {
      c.setQueryData(["project", "old-field"], project);
      c.setQueryData(["members", "potato-field"], []);
      c.setQueryData(["project", "greenhouse"], GREENHOUSE);
      c.setQueryData(projectsQuery.queryKey, [project, GREENHOUSE]);
    });
    // A list fetch that went out before the delete, answered after it.
    let answerList = () => {};
    listing = () =>
      new Promise((resolve) => {
        answerList = () => resolve(json(200, [project, GREENHOUSE]));
      });
    const early = client
      .fetchQuery({ ...projectsQuery, staleTime: 0 })
      .catch(() => {});
    const { dialog, input } = await openSlugStep();
    fireEvent.change(input, { target: { value: "potato-field" } });
    fireEvent.click(confirmButton(dialog));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects"),
    );
    await waitFor(() =>
      expect(client.getQueryData(["project", "potato-field"])).toBe(undefined),
    );
    expect(client.getQueryData(["project", "old-field"])).toBe(undefined);
    expect(client.getQueryData(["members", "potato-field"])).toBe(undefined);
    expect(client.getQueryData(["project", "greenhouse"])).toBeTruthy();
    // Kept, but stale: lists elsewhere in the cache may still name the project.
    expect(client.getQueryState(["project", "greenhouse"])?.isInvalidated).toBe(
      true,
    );
    // The list the redirect lands on, without waiting for its refetch.
    answerList();
    await act(() => early);
    expect(
      client.getQueryData(projectsQuery.queryKey)?.map((p) => p.slug),
    ).toEqual(["greenhouse"]);
  });

  it("closes, deleting nothing, when another project takes the slug over", async () => {
    const calls = stubFetch();
    const { client } = renderSection();
    const { input } = await openSlugStep();
    fireEvent.change(input, { target: { value: "potato-field" } });

    // Renamed away, and the slug claimed by another project; the change feed
    // refetches what the slug names.
    served = { ...PROJECT, id: 2, name: "Someone else's field" };
    await act(() =>
      client.invalidateQueries({ queryKey: ["project", "potato-field"] }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));
    expect(deletes(calls)).toEqual([]);

    // The slug coming back to the first project does not reopen it, armed.
    served = PROJECT;
    await act(() =>
      client.invalidateQueries({ queryKey: ["project", "potato-field"] }),
    );
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(screen.queryByRole("dialog")).toBe(null);
  });

  it("is done with the delete even when leaving the page is held back", async () => {
    stubFetch();
    const { router } = renderSection();
    // As the unsaved-changes guard does when the reader keeps editing.
    router.history.block({ blockerFn: () => true, enableBeforeUnload: false });
    const { input } = await openSlugStep();
    fireEvent.change(input, { target: { value: "potato-field" } });
    fireEvent.submit(input);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));

    // Still on the page, which offers nothing more to delete.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Delete this project" }),
      ).toBe(null),
    );
    expect(router.state.location.pathname).toBe(
      "/projects/potato-field/settings",
    );
    expect(toast.success).toHaveBeenCalledWith("Deleted My potato field");
  });
});
