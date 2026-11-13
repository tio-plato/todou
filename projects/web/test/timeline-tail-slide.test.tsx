import { act, fireEvent } from "@testing-library/react";
import type { TimelineComment, TimelinePage } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "../src/components/timeline/timeline.tsx";
import { FakeResizeObserver } from "./fake-resize-observer.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * Past a page, the timeline is a head window and a tail window with the fold
 * between them, and an arrival refetches the newest page: the tail's oldest
 * item slides into the fold and leaves the page, above a reader scrolled up
 * into the tail. happy-dom lays nothing out, so here every box in the list
 * stands 100px tall, one under the other from the top of the page.
 */

const alice = {
  id: 2,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (id: number): TimelineComment => ({
  type: "comment",
  id,
  author: alice,
  body: `body ${id}`,
  component: null,
  created_at: "2026-09-08T10:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

const VIEWPORT = 800;
const ROW = 100;

/**
 * A card of 30 comments, served in small windows: the first 10 to the head,
 * the newest 5 to the tail, the rest folded between them.
 */
async function open() {
  const items = Array.from({ length: 30 }, (_, i) => comment(i + 1));
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
    const tail = url.includes("last=1");
    const page: TimelinePage = {
      items: tail ? items.slice(-5) : items.slice(0, 10),
      prev_cursor: tail ? "p1" : null,
      next_cursor: "c1",
      total_count: items.length,
    };
    const reply = url.includes("/timeline")
      ? page
      : url.includes("/references/config")
        ? { format: { prefix: "T", history: [] }, autolinks: [] }
        : url.includes("/reference-directory")
          ? { entries: [], contested: [], slug_entries: [] }
          : [];
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const state = { y: 0 };
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(VIEWPORT);
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => state.y);
  // Far longer than the list, so the reader is never at the end and nothing
  // follows an arrival.
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
    10_000,
  );
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
    VIEWPORT,
  );
  vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
    if (typeof args[1] === "number") state.y = args[1];
  });
  vi.spyOn(window, "scrollBy").mockImplementation((...args: unknown[]) => {
    if (typeof args[1] === "number") state.y += args[1];
  });
  const unplaced = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const list = this.parentElement;
      if (list?.getAttribute("data-testid") !== "timeline-scroll")
        return unplaced.call(this);
      const top = [...list.children].indexOf(this) * ROW - state.y;
      return { top, bottom: top + ROW, height: ROW } as DOMRect;
    },
  );
  const client = testQueryClient();
  const view = renderWithProviders(
    <Timeline slug="p" issueNumber={7} pendingComments={[]} />,
    client,
  );
  await view.findByText("body 30");
  await view.findByText("body 10");
  const unit = (id: number) =>
    view.container.querySelector(`[data-unit="comment-${id}"]`);
  return {
    unit,
    arrive: async (id: number) => {
      items.push(comment(id));
      await act(() =>
        client.refetchQueries({ queryKey: ["timeline", "p", 7, "tail"] }),
      );
      await view.findByText(`body ${id}`);
    },
    /** The reader's own scroll, gesture first, as a browser delivers it. */
    readerAt: (y: number) => {
      fireEvent.wheel(window);
      state.y = y;
      fireEvent.scroll(window);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
});

describe("the tail sliding into the fold", () => {
  it("leaves what a reader scrolled up into the tail is reading where it was", async () => {
    const page = await open();
    // Head 1–10, the fold, then 26 and 27 above 28, at the top of the screen.
    page.readerAt(13 * ROW);
    expect(page.unit(28)?.getBoundingClientRect().top).toBe(0);
    await page.arrive(31);
    expect(page.unit(26)).toBeNull();
    expect(page.unit(28)?.getBoundingClientRect().top).toBe(0);
  });
});
