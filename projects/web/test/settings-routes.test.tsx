import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import type { Me, MePrefs, ProjectTemplate } from "@todou/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import {
  api,
  meQuery,
  projectsQuery,
  projectTemplatesQuery,
} from "../src/api/queries.ts";
import { router } from "../src/router.tsx";
import { restoreAppRouterPage, teardownAppRouter } from "./app-router.tsx";
import { testQueryClient } from "./render.tsx";

const me: Me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

const prefs: MePrefs = {
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
};

/**
 * The app's own route tree, entered at `path`. Without `templates` the
 * template list is not cached, so a page that needs it fetches it.
 */
function mountAt(path: string, templates?: ProjectTemplate[]) {
  const client = testQueryClient();
  client.setQueryData(meQuery.queryKey, me);
  client.setQueryData(prefsQuery.queryKey, prefs);
  client.setQueryData(projectsQuery.queryKey, []);
  if (templates) client.setQueryData(projectTemplatesQuery.queryKey, templates);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  // After the mount: the singleton router has already loaded whatever the
  // previous test left, and mounting again does not make it read the
  // history afresh.
  void router.navigate({ href: path, replace: true }).catch(() => undefined);
}

afterEach(() => restoreAppRouterPage());
afterAll(() => teardownAppRouter());

describe("account settings routes (T-557)", () => {
  it("sends the bare /settings to Profile", async () => {
    mountAt("/settings");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/profile"),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Profile" }),
    ).toBeTruthy();
  });

  it("mounts Appearance at its own address, beside the nav", async () => {
    mountAt("/settings/appearance");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Appearance" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Icons without an image" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Account settings" }),
    ).toBeTruthy();
  });
});

describe("project settings routes (T-712)", () => {
  it("sends the old Insights settings address to Statuses", async () => {
    mountAt("/projects/p/settings/insights");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/projects/p/settings/statuses",
      ),
    );
  });
});

describe("a project template's tab title", () => {
  const kanban: ProjectTemplate = {
    ref: 7,
    name: "Kanban",
    builtin: false,
    revision: 0,
    body: {
      statuses: [
        {
          name: "Todo",
          category: "open",
          color: "#6b7280",
          chart_role: "remaining",
        },
      ],
      labels: [],
    },
  };

  afterEach(() => vi.restoreAllMocks());

  it("names the template, or the address when it matches none", async () => {
    mountAt("/settings/templates/7", [kanban]);
    await waitFor(() =>
      expect(document.title).toBe("Kanban · Project templates · todou"),
    );

    void router
      .navigate({ href: "/settings/templates/999" })
      .catch(() => undefined);
    await screen.findByText("You have no template at this address.");
    expect(document.title).toBe("999 · Project templates · todou");
  });

  it("names it by the address until the list arrives", async () => {
    let arrive: (templates: ProjectTemplate[]) => void = () => undefined;
    vi.spyOn(api, "listProjectTemplates").mockReturnValue(
      new Promise((resolve) => {
        arrive = resolve;
      }),
    );
    mountAt("/settings/templates/7");
    await waitFor(() =>
      expect(document.title).toBe("7 · Project templates · todou"),
    );

    arrive([kanban]);
    await waitFor(() =>
      expect(document.title).toBe("Kanban · Project templates · todou"),
    );
  });
});
