import { fireEvent, waitFor, within } from "@testing-library/react";
import { type Me, MePrefs } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import { api, meQuery } from "../src/api/queries.ts";
import { AppearanceSettingsPage } from "../src/pages/profile-settings.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

// The spec page's outline and change strip, each switchable whole and in
// what it marks (T-234).

afterEach(() => vi.restoreAllMocks());

const me: Me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-08-28T00:00:00Z",
};

function renderSettings(prefs: Partial<MePrefs> = {}) {
  const client = testQueryClient();
  client.setQueryData(meQuery.queryKey, me);
  client.setQueryData(prefsQuery.queryKey, MePrefs.parse(prefs));
  const { container } = renderWithProviders(<AppearanceSettingsPage />, client);
  return within(container);
}

/** A switch by its group, so the two "Comments" are told apart. */
async function switchIn(
  view: ReturnType<typeof renderSettings>,
  group: string,
  name: string,
) {
  const box = await view.findByRole("group", { name: group });
  return within(box).getByRole<HTMLButtonElement>("switch", { name });
}

describe("spec page preferences (T-234)", () => {
  const SWITCHES = [
    ["Outline", "Outline", "spec_outline"],
    ["Outline", "Comments", "spec_outline_comments"],
    ["Outline", "Changes", "spec_outline_changes"],
    ["Change strip", "Change strip", "spec_strip"],
    ["Change strip", "Comments", "spec_strip_comments"],
    ["Change strip", "Changes", "spec_strip_changes"],
  ] as const;

  it("starts with every part on", async () => {
    const view = renderSettings();
    for (const [group, name] of SWITCHES) {
      const toggle = await switchIn(view, group, name);
      expect(toggle.dataset.state, `${group} › ${name}`).toBe("checked");
      expect(toggle.disabled, `${group} › ${name}`).toBe(false);
    }
  });

  for (const [group, name, key] of SWITCHES) {
    it(`patches ${key} alone`, async () => {
      const spy = vi
        .spyOn(api, "patchMyPrefs")
        .mockResolvedValue(MePrefs.parse({ [key]: false }));
      const view = renderSettings();
      fireEvent.click(await switchIn(view, group, name));

      await waitFor(() => expect(spy).toHaveBeenCalledWith({ [key]: false }));
      // The server merges shallowly: a payload carrying a neighbour would
      // overwrite whatever another tab had just set.
      expect(spy.mock.calls).toHaveLength(1);
      expect(Object.keys(spy.mock.calls[0]?.[0] ?? {})).toEqual([key]);
    });
  }

  it("disables what a part marks while the part is off, showing the stored values", async () => {
    const view = renderSettings({
      spec_outline: false,
      spec_outline_comments: false,
      spec_strip_changes: false,
    });
    const comments = await switchIn(view, "Outline", "Comments");
    const changes = await switchIn(view, "Outline", "Changes");
    expect(comments.disabled).toBe(true);
    expect(changes.disabled).toBe(true);
    expect(comments.dataset.state).toBe("unchecked");
    expect(changes.dataset.state).toBe("checked");

    // The strip is on, so its own two stay live whatever they hold.
    const stripChanges = await switchIn(view, "Change strip", "Changes");
    expect(stripChanges.disabled).toBe(false);
    expect(stripChanges.dataset.state).toBe("unchecked");
    expect((await switchIn(view, "Change strip", "Comments")).disabled).toBe(
      false,
    );
  });
});
