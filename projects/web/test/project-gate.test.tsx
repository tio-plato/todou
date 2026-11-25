import {
  type QueryClient,
  QueryClientProvider,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@todou/shared";
import { type ReactElement, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueQuery } from "../src/api/issues.ts";
import {
  labelsQuery,
  membersQuery,
  meQuery,
  projectQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import { IssueRouteError } from "../src/pages/issue-route-error.tsx";
import {
  ProjectLayout,
  ProjectRouteError,
} from "../src/pages/project-layout.tsx";
import { testQueryClient } from "./render.tsx";

const ME = { id: 1, login: "bot-one", name: "Bot One" };

const PROJECT_A: Project = {
  id: 1,
  slug: "a",
  name: "a",
  description: "",
  created_at: "2026-08-01T00:00:00.000Z",
  former_slugs: [],
};

const PROJECT_B: Project = {
  id: 2,
  slug: "b",
  name: "b",
  description: "",
  created_at: "2026-08-01T00:00:00.000Z",
  former_slugs: [],
};

// Only the title is read back, so the card body stays at the one field the
// stand-in renders.
const ISSUE_B2 = { number: 2, title: "The card, at its new address" };

const PROJECT_MISS_TEXT =
  "This project does not exist, or you do not have access to it.";
const ISSUE_MISS_TEXT =
  "This issue does not exist, or you do not have access to it.";
/** Marks the boundary the project layer rethrows to. */
const ABOVE = "handled above the project layer";

type Reply = [status: number, body: unknown];

const NOT_FOUND: Reply = [
  404,
  { error: { code: "not_found", message: "not found" } },
];

/** Records every request URL and answers from `table`; the rest 404s. */
function stubFetch(table: Record<string, Reply>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const [status, body] = table[url] ?? NOT_FOUND;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return calls;
}

/**
 * Stands in for IssueDetailPage. The query order is copied from
 * issue-detail.tsx:86-91 and is itself part of what these tests cover:
 * issueQuery has to reach its redirect before the project-scoped queries
 * below it are opened.
 */
function IssueStubBody() {
  const { slug, number } = useParams({
    from: "/authed/projects/$slug/issues/$number",
  });
  useSuspenseQuery(meQuery);
  const issue = useSuspenseQuery(issueQuery(slug, Number(number)));
  useSuspenseQuery(statusesQuery(slug));
  useSuspenseQuery(labelsQuery(slug));
  useSuspenseQuery(membersQuery(slug));
  return <div>{issue.data.title}</div>;
}

function IssueStub() {
  return (
    <Suspense fallback={<div>loading</div>}>
      <IssueStubBody />
    </Suspense>
  );
}

/**
 * Stands in for a project page that reads its project's cache. The statuses
 * stay fresh for a minute, so what shows after a refetch of the project is
 * still the first answer unless something emptied the cache.
 */
function StatusesStubBody() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const statuses = useSuspenseQuery(statusesQuery(slug));
  return <div>{statuses.data.map((status) => status.name).join(", ")}</div>;
}

function StatusesStub() {
  return (
    <Suspense fallback={<div>loading</div>}>
      <StatusesStubBody />
    </Suspense>
  );
}

/**
 * Stands in for the shell's breadcrumb, which reads the project from outside
 * the project route: its name while it answers, the slug otherwise.
 */
function HeaderStub() {
  const { slug } = useParams({ strict: false });
  const project = useQuery({
    ...projectQuery(slug ?? ""),
    enabled: slug !== undefined,
  });
  return <header>{project.data?.name ?? slug}</header>;
}

/**
 * The real layout and both real error boundaries over the stand-in. The
 * pathless "authed" id has to be here: ProjectLayout and IssueRouteError
 * both read their params from "/authed/projects/$slug".
 */
function renderAt(
  url: string,
  {
    client = testQueryClient(),
    index = () => <div>project index</div>,
    header = false,
  }: {
    client?: QueryClient;
    index?: () => ReactElement;
    header?: boolean;
  } = {},
) {
  const rootRoute = createRootRoute(
    header
      ? {
          component: () => (
            <>
              <HeaderStub />
              <Outlet />
            </>
          ),
        }
      : {},
  );
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    errorComponent: () => <div>{ABOVE}</div>,
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
    component: ProjectLayout,
    errorComponent: ProjectRouteError,
  });
  const projectIndexRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/",
    component: index,
  });
  const issuesRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: IssueStub,
    errorComponent: IssueRouteError,
    staticData: { resolvesProjectMiss: true },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([projectIndexRoute, issuesRoute]),
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("project gate", () => {
  it("follows a moved card whose old project the reader cannot read", async () => {
    const calls = stubFetch({
      "/api/me": [200, ME],
      "/api/projects/a": NOT_FOUND,
      "/api/projects/a/issues/1": [301, { moved_to: { slug: "b", number: 2 } }],
      "/api/projects/b": [200, PROJECT_B],
      "/api/projects/b/issues/2": [200, ISSUE_B2],
      "/api/projects/b/statuses": [200, []],
      "/api/projects/b/labels": [200, []],
      "/api/projects/b/members": [200, []],
    });
    const router = renderAt("/projects/a/issues/1");

    expect(await screen.findByText(ISSUE_B2.title)).toBeTruthy();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/b/issues/2"),
    );

    // The redirect only wins the boundary because the suspense queries run
    // one after another. Prefetching them concurrently would put three 404s
    // from project a in flight beside the redirect, and this line is where
    // that shows up first.
    expect(
      calls.filter((url) =>
        /^\/api\/projects\/a\/(statuses|labels|members)$/.test(url),
      ),
    ).toEqual([]);
  });

  it("keeps answering for a project miss with no card in the URL", async () => {
    const calls = stubFetch({
      "/api/me": [200, ME],
      "/api/projects/a": NOT_FOUND,
    });
    renderAt("/projects/a");

    expect(await screen.findByText(PROJECT_MISS_TEXT)).toBeTruthy();
    expect(calls.filter((url) => url.includes("/issues"))).toEqual([]);
  });

  it("sends a project failure that is not a 404 to the boundary above", async () => {
    stubFetch({
      "/api/me": [200, ME],
      "/api/projects/a": [500, { error: { code: "internal", message: "x" } }],
      "/api/projects/a/issues/1": [301, { moved_to: { slug: "b", number: 2 } }],
    });
    renderAt("/projects/a/issues/1");

    expect(await screen.findByText(ABOVE)).toBeTruthy();
    expect(screen.queryByText(PROJECT_MISS_TEXT)).toBeNull();
  });

  it("still shows the tombstone to a reader who can read the old project", async () => {
    stubFetch({
      "/api/me": [200, ME],
      "/api/projects/a": [200, PROJECT_A],
      "/api/projects/a/issues/1": [
        410,
        { moved: true, title: "A card that went out of reach" },
      ],
    });
    renderAt("/projects/a/issues/1");

    expect(
      await screen.findByText(
        "This issue moved to a project you do not have access to.",
      ),
    ).toBeTruthy();
  });

  it("answers for a shown project that goes away as a reload would", async () => {
    const table: Record<string, Reply> = {
      "/api/me": [200, ME],
      "/api/projects/a": [200, PROJECT_A],
      "/api/projects/a/statuses": [200, [{ id: 1, name: "Old status" }]],
    };
    stubFetch(table);
    const client = testQueryClient();
    renderAt("/projects/a", { client, index: StatusesStub });
    expect(await screen.findByText("Old status")).toBeTruthy();

    // Deleted, or the reader taken off it: the server says 404 to both.
    table["/api/projects/a"] = NOT_FOUND;
    await act(() => client.refetchQueries({ queryKey: ["project", "a"] }));

    expect(await screen.findByText(PROJECT_MISS_TEXT)).toBeTruthy();
    expect(screen.queryByText("Old status")).toBeNull();
  });

  it("leaves the shell's own read of a gone project as a reload finds it", async () => {
    const table: Record<string, Reply> = {
      "/api/me": [200, ME],
      "/api/projects/a": [200, { ...PROJECT_A, name: "Field A" }],
    };
    stubFetch(table);
    const client = testQueryClient();
    renderAt("/projects/a", { client, header: true });
    expect(await screen.findByText("Field A")).toBeTruthy();

    table["/api/projects/a"] = NOT_FOUND;
    await act(() => client.refetchQueries({ queryKey: ["project", "a"] }));

    expect(await screen.findByText(PROJECT_MISS_TEXT)).toBeTruthy();
    // The slug, as after a reload: not the name of a project that is gone.
    await waitFor(() =>
      expect(screen.getByRole("banner").textContent).toBe("a"),
    );
  });

  it("shows the project that took a slug over, none of the old one", async () => {
    const table: Record<string, Reply> = {
      "/api/me": [200, ME],
      "/api/projects/a": [200, PROJECT_A],
      "/api/projects/a/statuses": [200, [{ id: 1, name: "Old status" }]],
    };
    const calls = stubFetch(table);
    const client = testQueryClient();
    renderAt("/projects/a", { client, index: StatusesStub });
    expect(await screen.findByText("Old status")).toBeTruthy();

    table["/api/projects/a"] = [200, { ...PROJECT_A, id: 3, name: "a again" }];
    table["/api/projects/a/statuses"] = [200, [{ id: 9, name: "New status" }]];
    await act(() => client.refetchQueries({ queryKey: ["project", "a"] }));

    expect(await screen.findByText("New status")).toBeTruthy();
    expect(screen.queryByText("Old status")).toBeNull();
    // Once for the first project and once for the second: the new answer is
    // taken as the project shown, not as yet another one gone.
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(calls.filter((url) => url === "/api/projects/a/statuses")).toEqual([
      "/api/projects/a/statuses",
      "/api/projects/a/statuses",
    ]);
  });

  it("opens the address again once the project that went away is back", async () => {
    const table: Record<string, Reply> = {
      "/api/me": [200, ME],
      "/api/projects/a": [200, PROJECT_A],
      "/api/projects/a/statuses": [200, [{ id: 1, name: "Old status" }]],
      "/api/projects/b": [200, PROJECT_B],
      "/api/projects/b/statuses": [200, [{ id: 5, name: "B status" }]],
    };
    stubFetch(table);
    const client = testQueryClient();
    const router = renderAt("/projects/a", { client, index: StatusesStub });
    expect(await screen.findByText("Old status")).toBeTruthy();

    // Gone: everything under the address answers 404 now.
    table["/api/projects/a"] = NOT_FOUND;
    table["/api/projects/a/statuses"] = NOT_FOUND;
    await act(() => client.refetchQueries({ queryKey: ["project", "a"] }));
    expect(await screen.findByText(PROJECT_MISS_TEXT)).toBeTruthy();

    // The slug taken over, or the reader put back on the project; then away
    // and back, which is where a refresh would find the project again.
    table["/api/projects/a"] = [200, { ...PROJECT_A, id: 3 }];
    table["/api/projects/a/statuses"] = [200, [{ id: 9, name: "New status" }]];
    await act(() =>
      router.navigate({ to: "/projects/$slug", params: { slug: "b" } }),
    );
    expect(await screen.findByText("B status")).toBeTruthy();
    await act(() =>
      router.navigate({ to: "/projects/$slug", params: { slug: "a" } }),
    );

    expect(await screen.findByText("New status")).toBeTruthy();
  });

  it("answers for a shown card whose project goes away as a reload would", async () => {
    const table: Record<string, Reply> = {
      "/api/me": [200, ME],
      "/api/projects/a": [200, PROJECT_A],
      "/api/projects/a/issues/1": [200, { number: 1, title: "A card" }],
      "/api/projects/a/statuses": [200, []],
      "/api/projects/a/labels": [200, []],
      "/api/projects/a/members": [200, []],
    };
    stubFetch(table);
    const client = testQueryClient();
    renderAt("/projects/a/issues/1", { client });
    expect(await screen.findByText("A card")).toBeTruthy();

    table["/api/projects/a"] = NOT_FOUND;
    table["/api/projects/a/issues/1"] = NOT_FOUND;
    await act(() => client.refetchQueries({ queryKey: ["project", "a"] }));

    // The card's own route answers for a project miss, as it does on a
    // reload of this address.
    expect(await screen.findByText(ISSUE_MISS_TEXT)).toBeTruthy();
    expect(screen.queryByText("A card")).toBeNull();
  });
});
