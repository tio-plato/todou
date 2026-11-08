import { act, fireEvent, waitFor } from "@testing-library/react";
import type { TimelineComment, TimelinePage } from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "../src/components/timeline/timeline.tsx";
import {
  FakeResizeObserver,
  resizeElement,
  resizePage,
} from "./fake-resize-observer.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * Every landing on the end of the timeline stays there while the card goes on
 * loading (T-527): opening the card, following a new item, and New messages.
 * happy-dom lays nothing out, so what is observable is that a resize of the
 * page asks for the end again; how far the page would have drifted without it
 * is measured in a browser.
 */

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (id: number): TimelineComment => ({
  type: "comment",
  id,
  author,
  body: `body ${id}`,
  component: null,
  created_at: "2026-09-08T10:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

const HEIGHT = 10_000;
const VIEWPORT = 800;

type Pending = Array<{ key: number; comment: TimelineComment }>;
/** The page's own comments still being sent, set from the test. */
let setPending: (pending: Pending) => void = () => {};
function TimelineWithPending() {
  const [pending, set] = useState<Pending>([]);
  setPending = set;
  return (
    <Timeline
      slug="p"
      issueNumber={7}
      pendingComments={pending}
      viewer={{ id: 1, isAdmin: false, role: "writer" }}
    />
  );
}

/**
 * The card's timeline, with a page geometry to scroll in. `bottoms` counts the
 * scrolls to the end of the document; `readerAt` is the reader's own scroll,
 * gesture first, the way a browser delivers it; `grow` makes the page taller
 * with no scroll, for whichever observer the test then fires.
 */
async function open(hash = "") {
  const items = [comment(101), comment(102), comment(103)];
  const reads = { refused: false };
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
    if (reads.refused && url.includes("/timeline"))
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const page: TimelinePage = {
      items: [...items],
      prev_cursor: null,
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
  const state = { y: 0, height: HEIGHT };
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(VIEWPORT);
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => state.y);
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockImplementation(
    () => state.height,
  );
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
    VIEWPORT,
  );
  let bottoms = 0;
  vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
    // The largest offset there is, never `scrollHeight` itself: iOS takes
    // the overshoot literally for a frame and shows a blank screen (T-585).
    if (args[1] === state.height - VIEWPORT) {
      bottoms += 1;
      state.y = state.height - VIEWPORT;
    }
  });
  const reveals: string[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
  ) {
    reveals.push(this.id);
  });
  const client = testQueryClient();
  const view = renderWithProviders(<TimelineWithPending />, client, {
    initialEntry: `/${hash}`,
  });
  await view.findByText("body 103");
  const refetch = () =>
    act(() =>
      client.refetchQueries({ queryKey: ["timeline", "p", 7, "tail"] }),
    );
  const arrive = async (id: number) => {
    items.push(comment(id));
    await refetch();
    await view.findByText(`body ${id}`);
  };
  return {
    view,
    arrive,
    refetch,
    pending: (next: Pending) => act(() => setPending(next)),
    reveals,
    bottoms: () => bottoms,
    grow: (by: number) => {
      state.height += by;
    },
    /** Whether the timeline's reads are refused, as a revoked share is. */
    refuse: (refused: boolean) => {
      reads.refused = refused;
    },
    /** Where a reveal put the viewport, which is no gesture of the reader's. */
    revealedAt: (y: number) => {
      state.y = y;
      fireEvent.scroll(window);
    },
    readerAt: (y: number) => {
      fireEvent.wheel(window);
      state.y = y;
      fireEvent.scroll(window);
    },
  };
}

/** New messages is up. */
function newMessagesShown(view: ReturnType<typeof renderWithProviders>) {
  return view.queryByRole("button", { name: "New messages" }) !== null;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
});

describe("landings on the end of the timeline (T-527)", () => {
  it("opening the card lands on the end again each time the page grows", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    resizePage();
    resizePage();
    expect(page.bottoms()).toBe(3);
  });

  it.each([
    ["wheel", () => fireEvent.wheel(window)],
    ["touchstart", () => fireEvent.touchStart(window)],
    ["pointerdown", () => fireEvent.pointerDown(window)],
    ["keydown", () => fireEvent.keyDown(window, { key: "ArrowUp" })],
  ])("hands the viewport back at the first %s", async (_, input) => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    input();
    resizePage();
    expect(page.bottoms()).toBe(1);
  });

  it("a reader who scrolled up is not pulled back as the page grows", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(2_000);
    resizePage();
    await page.arrive(104);
    resizePage();
    expect(page.bottoms()).toBe(1);
    expect(
      page.view.getByRole("button", { name: "New messages" }),
    ).toBeTruthy();
  });

  it("leaves a reader the page was moved off the end of, with no input, where they are", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    // A tap on iOS's status bar, find in page: the opening's hold hears no
    // input from either.
    page.revealedAt(2_000);
    await page.arrive(104);
    resizePage();
    expect(page.bottoms()).toBe(1);
    expect(newMessagesShown(page.view)).toBe(true);
  });

  it("following a new item at the end holds the end too", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    // Still at the end, but no longer under the opening's hold.
    page.readerAt(HEIGHT - VIEWPORT);
    await page.arrive(104);
    await waitFor(() => expect(page.bottoms()).toBe(2));
    resizePage();
    expect(page.bottoms()).toBe(3);
  });

  it("leaves a reader half a screen above the end where they are", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    // Reading the last comment, its end still below the viewport.
    page.readerAt(HEIGHT - VIEWPORT - 400);
    await page.arrive(104);
    expect(page.bottoms()).toBe(1);
    expect(newMessagesShown(page.view)).toBe(true);
  });

  it("leaves a reader the list grew away from, with no scroll, where they are", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(HEIGHT - VIEWPORT);
    // An image loading in the last comment: the end moves down a screen and a
    // half, and nothing scrolls.
    page.grow(1200);
    resizeElement(page.view.getByTestId("timeline-scroll"));
    await page.arrive(104);
    expect(page.bottoms()).toBe(1);
    expect(newMessagesShown(page.view)).toBe(true);
  });

  it("reads where the reader is off the list mounted again after a refused read", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.refuse(true);
    await page.refetch();
    const retry = await page.view.findByRole("button", { name: "Retry" });
    page.refuse(false);
    fireEvent.click(retry);
    await waitFor(() =>
      expect(page.view.queryByRole("button", { name: "Retry" })).toBeNull(),
    );
    page.readerAt(HEIGHT - VIEWPORT);
    page.grow(1200);
    resizeElement(page.view.getByTestId("timeline-scroll"));
    await page.arrive(104);
    expect(page.bottoms()).toBe(1);
    expect(newMessagesShown(page.view)).toBe(true);
  });

  it("follows a reader at the end through a resize that rewraps the list", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    const list = page.view.getByTestId("timeline-scroll");
    const windowWidth = vi
      .spyOn(window, "innerWidth", "get")
      .mockReturnValue(1000);
    resizeElement(list, 800);
    page.readerAt(HEIGHT - VIEWPORT);
    // A narrower window: the same items wrap taller, and nothing scrolls.
    windowWidth.mockReturnValue(800);
    page.grow(600);
    resizeElement(list, 600);
    await page.arrive(104);
    await waitFor(() => expect(page.bottoms()).toBe(2));
  });

  it("reads where the reader is as the list grows a scrollbar narrower", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    const list = page.view.getByTestId("timeline-scroll");
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    resizeElement(list, 800);
    page.readerAt(HEIGHT - VIEWPORT);
    // An image loading in a page that did not scroll before: the scrollbar
    // it brings takes from the list, not the window.
    page.grow(1200);
    resizeElement(list, 785);
    await page.arrive(104);
    expect(page.bottoms()).toBe(1);
    expect(newMessagesShown(page.view)).toBe(true);
  });

  it("follows a reader the opening still holds, though the list grew before it put them back", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    // An image loading: the list's observer hears of it before the hold
    // does, so the reader reads as off the end.
    page.grow(1200);
    resizeElement(page.view.getByTestId("timeline-scroll"));
    await page.arrive(104);
    await waitFor(() => expect(page.bottoms()).toBe(2));
  });

  it("leaves a reader half a screen above the end there when they send", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(HEIGHT - VIEWPORT - 400);
    await page.pending([{ key: 1, comment: comment(104) }]);
    expect(page.bottoms()).toBe(1);
  });

  it("follows a reader at the end whose draft pushed the end down", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(HEIGHT - VIEWPORT);
    // The composer grows with the draft: the page does, the list does not.
    page.grow(300);
    resizePage();
    await page.arrive(104);
    await waitFor(() => expect(page.bottoms()).toBe(2));
  });

  it("New messages holds the end it jumps to", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    await page.arrive(104);
    const button = page.view.getByRole("button", { name: "New messages" });
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(page.bottoms()).toBe(2);
    resizePage();
    expect(page.bottoms()).toBe(3);
  });

  it("lets go when the timeline unmounts", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.view.unmount();
    resizePage();
    expect(page.bottoms()).toBe(1);
  });

  it("a held #comment- landing is not traded for the end when an item arrives", async () => {
    const page = await open("#comment-102");
    await waitFor(() => expect(page.reveals).toContain("comment-102"));
    // The anchor sits at the end: follow-bottom's own test.
    page.revealedAt(HEIGHT - VIEWPORT);
    await page.arrive(104);
    resizePage();
    expect(page.bottoms()).toBe(0);
    expect(page.reveals.at(-1)).toBe("comment-102");
  });
});
