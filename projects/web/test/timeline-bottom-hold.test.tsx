import { act, fireEvent, waitFor, within } from "@testing-library/react";
import type {
  TimelineComment,
  TimelineEvent,
  TimelineItem,
  TimelinePage,
} from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "../src/components/timeline/timeline.tsx";
import { usableViewport } from "../src/lib/scroll-insets.ts";
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

/** The reader, whose own comments and events are never news to them. */
const viewer = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const alice = { ...viewer, id: 2, login: "alice", display_name: "Alice" };

const commentBy =
  (author: typeof viewer) =>
  (id: number): TimelineComment => ({
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
/** Someone else's comment. */
const comment = commentBy(alice);
/** The reader's own. */
const own = commentBy(viewer);

/** One of two labels added in a burst, which the timeline folds into a group. */
const labelAddedBy =
  (actor: typeof viewer) =>
  (id: number): TimelineEvent => ({
    type: "event",
    id,
    event_type: "label_added",
    actor,
    payload: { label: { id, name: `label-${id}`, color: "#0f0" } },
    created_at: "2026-09-08T10:00:00Z",
    agent_context: null,
  });
const labelAdded = labelAddedBy(alice);
const ownLabelAdded = labelAddedBy(viewer);

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
      viewer={{ id: viewer.id, isAdmin: false, role: "writer" }}
    />
  );
}

/**
 * The card's timeline, with a page geometry to scroll in. `bottoms` counts the
 * scrolls to the end of the document; `readerAt` is the reader's own scroll,
 * gesture first, the way a browser delivers it; `grow` makes the page taller
 * with no scroll, for whichever observer the test then fires. `paged` serves
 * the timeline the way the server does past a page: the newest 50 items to the
 * tail, the first 50 to the head, and what lies between them unloaded.
 */
async function open(hash = "", { paged = false, initial = 3 } = {}) {
  const items: TimelineItem[] = Array.from({ length: initial }, (_, i) =>
    comment(101 + i),
  );
  const reads = { refused: false };
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
    if (reads.refused && url.includes("/timeline"))
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const tail = !paged || url.includes("last=1");
    const page: TimelinePage = !paged
      ? {
          items: [...items],
          prev_cursor: null,
          next_cursor: "c1",
          total_count: items.length,
        }
      : {
          items: tail ? items.slice(-50) : items.slice(0, 50),
          prev_cursor: tail && items.length > 50 ? "p1" : null,
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
  let scrolls = 0;
  let scrolledTo: unknown = null;
  vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
    scrolls += 1;
    scrolledTo = args[1];
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
  await view.findByText(`body ${100 + initial}`);
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
    items,
    refetch,
    pending: (next: Pending) => act(() => setPending(next)),
    reveals,
    bottoms: () => bottoms,
    scrolls: () => scrolls,
    /** Where the last scroll the page made went. */
    scrolledTo: () => scrolledTo,
    /** What a landing flashed, the way an anchor's is. */
    flashed: () => [...view.container.querySelectorAll(".anchor-flash")],
    at: () => state.y,
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

/** happy-dom's own measure, all zeros, for what no test has placed. */
const unplaced = Element.prototype.getBoundingClientRect;
const placed: Array<{
  match: (el: Element) => boolean;
  top: number;
  height: number;
}> = [];

/**
 * A box of their own for the elements `match` picks, in client coordinates;
 * the rest keep what they had.
 */
function placeAt(
  match: (el: Element) => boolean,
  { top, height }: { top: number; height: number },
) {
  placed.push({ match, top, height });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const box = placed.findLast((p) => p.match(this));
      return box === undefined
        ? unplaced.call(this)
        : ({
            top: box.top,
            bottom: box.top + box.height,
            height: box.height,
          } as DOMRect);
    },
  );
}

/** New messages, named by its count when it shows one. */
const NEW_MESSAGES = /^(New messages|\d+ new messages?)$/;

/**
 * New messages is up: the button, in a layer that is showing. The layer stays
 * mounted, and the button in it keeps its look while it fades out.
 */
function newMessagesShown(view: ReturnType<typeof renderWithProviders>) {
  return (
    view
      .queryByRole("button", { name: NEW_MESSAGES })
      ?.closest("[data-scroll-to-bottom]")
      ?.getAttribute("data-state") === "shown"
  );
}

/**
 * The window listeners still attached, of those added from this call on: a
 * listener goes when it is removed or when its signal aborts.
 */
function trackWindowListeners() {
  type Entry = {
    type: string;
    listener: EventListenerOrEventListenerObject;
    capture: boolean;
  };
  const live = new Set<Entry>();
  const capture = (options?: boolean | EventListenerOptions) =>
    typeof options === "boolean" ? options : Boolean(options?.capture);
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    const entry = { type, listener, capture: capture(options) };
    live.add(entry);
    if (typeof options === "object")
      options.signal?.addEventListener("abort", () => live.delete(entry));
    add(type, listener, options);
  }) as typeof window.addEventListener);
  vi.spyOn(window, "removeEventListener").mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    for (const entry of live) {
      if (
        entry.type === type &&
        entry.listener === listener &&
        entry.capture === capture(options)
      )
        live.delete(entry);
    }
    remove(type, listener, options);
  }) as typeof window.removeEventListener);
  return () => [...live].map((entry) => entry.type);
}

/** A click as a browser delivers it: the press first, which ends a hold. */
function clickNewMessages(view: ReturnType<typeof renderWithProviders>) {
  const button = view.getByRole("button", { name: NEW_MESSAGES });
  fireEvent.pointerDown(button);
  fireEvent.click(button);
}

/**
 * What New messages is called while it shows, its count in its name; null
 * while it does not. Its look stays on the hidden layer, so a name alone
 * cannot tell a button up from one faded out.
 */
function shownAs(view: ReturnType<typeof renderWithProviders>) {
  const button = view.queryByRole("button", { name: NEW_MESSAGES });
  return button
    ?.closest("[data-scroll-to-bottom]")
    ?.getAttribute("data-state") === "shown"
    ? (button.getAttribute("aria-label") ?? button.textContent?.trim() ?? null)
    : null;
}

/** The number New messages shows beside its name, or null with none. */
function countShown(view: ReturnType<typeof renderWithProviders>) {
  return (
    view
      .getByRole("button", { name: NEW_MESSAGES })
      .querySelector("span[aria-hidden]")?.textContent ?? null
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
  placed.length = 0;
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
    expect(newMessagesShown(page.view)).toBe(true);
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
    // Short, its top where the end has gone.
    placeAt((el) => el.id === "comment-104", {
      top: VIEWPORT + 600 - 100,
      height: 80,
    });
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
    placeAt((el) => el.id === "comment-104", {
      top: VIEWPORT + 1200 - 100,
      height: 80,
    });
    await page.arrive(104);
    await waitFor(() => expect(page.bottoms()).toBe(2));
  });

  it("goes to the end, not up, while the opening holds the end and no scroll has said where", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.items.push(labelAdded(200), labelAdded(201));
    await page.refetch();
    await page.view.findByTestId("event-group");
    const bottoms = page.bottoms();
    placeAt((el) => el.getAttribute("data-unit") === "group-200", {
      top: -500,
      height: 600,
    });
    page.items.push(labelAdded(202));
    await page.refetch();
    await waitFor(() => expect(page.bottoms()).toBe(bottoms + 1));
  });

  it("goes to the end, not up, from below where the hold last put the reader", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.items.push(labelAdded(200), labelAdded(201));
    await page.refetch();
    await page.view.findByTestId("event-group");
    // Something above grows, and scroll anchoring moves the page down with
    // the end before the hold has put it there itself.
    page.grow(300);
    page.revealedAt(HEIGHT + 300 - VIEWPORT);
    const bottoms = page.bottoms();
    // The group starts between where the hold put the page and where it is.
    placeAt((el) => el.getAttribute("data-unit") === "group-200", {
      top: -150,
      height: 600,
    });
    page.items.push(labelAdded(202));
    await page.refetch();
    await waitFor(() => expect(page.bottoms()).toBe(bottoms + 1));
  });

  it("leaves a reader half a screen above the end there when they send", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(HEIGHT - VIEWPORT - 400);
    await page.pending([{ key: 1, comment: own(104) }]);
    expect(page.bottoms()).toBe(1);
  });

  it("follows a reader at the end whose draft pushed the end down", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(HEIGHT - VIEWPORT);
    // The composer grows with the draft: the page does, the list does not.
    page.grow(300);
    resizePage();
    // Short, on the viewport's bottom edge: what follows it is the end.
    placeAt((el) => el.id === "comment-104", {
      top: VIEWPORT - 100,
      height: 80,
    });
    await page.arrive(104);
    await waitFor(() => expect(page.bottoms()).toBe(2));
  });

  it("shows a long item arriving at the end from its top, unflashed", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(HEIGHT - VIEWPORT);
    // Three screens long, starting just above the end the reader is at, and
    // the page grown by as much. No resize: where the reader is would be
    // read against the grown page before the arrival is.
    placeAt((el) => el.id === "comment-104", { top: 300, height: 3000 });
    page.grow(3000);
    await page.arrive(104);
    expect(page.scrolledTo()).toBe(
      HEIGHT - VIEWPORT + 300 - usableViewport().top,
    );
    expect(page.flashed()).toEqual([]);
    const scrolls = page.scrolls();
    // Held on its top: what comes next is announced, not followed.
    await page.arrive(105);
    expect(newMessagesShown(page.view)).toBe(true);
    expect(page.scrolls()).toBe(scrolls);
  });

  it("lands the reader's own long comment at the end, and announces nothing as it is replaced", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(HEIGHT - VIEWPORT);
    placeAt((el) => el.getAttribute("data-unit") === "pending-1", {
      top: 300,
      height: 3000,
    });
    page.grow(3000);
    await page.pending([{ key: 1, comment: own(104) }]);
    expect(page.bottoms()).toBe(2);
    page.items.push(own(104));
    await page.refetch();
    await page.pending([]);
    expect(newMessagesShown(page.view)).toBe(false);
  });

  it("goes to the end, not up, for an event folded into a group above", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(HEIGHT - VIEWPORT);
    page.items.push(labelAdded(200), labelAdded(201));
    await page.refetch();
    await page.view.findByTestId("event-group");
    page.readerAt(HEIGHT - VIEWPORT);
    const bottoms = page.bottoms();
    // The group starts above the reader, and the next label joins it.
    placeAt((el) => el.getAttribute("data-unit") === "group-200", {
      top: -500,
      height: 600,
    });
    page.items.push(labelAdded(202));
    await page.refetch();
    await waitFor(() => expect(page.bottoms()).toBe(bottoms + 1));
    expect(page.view.getAllByTestId("event-group")).toHaveLength(1);
  });

  it("New messages holds the first new item it jumps to", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    await page.arrive(104);
    await page.arrive(105);
    clickNewMessages(page.view);
    // The first the reader has not seen, not the last that arrived.
    expect(page.flashed().map((el) => el.id)).toEqual(["comment-104"]);
    expect(page.bottoms()).toBe(1);
    const placed = page.scrolls();
    resizePage();
    expect(page.scrolls()).toBe(placed + 1);
    expect(page.bottoms()).toBe(1);
  });

  it("New messages lands on the group an event arrived folded into", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    page.items.push(labelAdded(200), labelAdded(201));
    await page.refetch();
    const group = await page.view.findByTestId("event-group");
    // Events alone are announced with no number: only comments are counted.
    expect(shownAs(page.view)).toBe("New messages");
    expect(countShown(page.view)).toBeNull();
    clickNewMessages(page.view);
    expect(page.flashed()).toEqual([group.parentElement]);
    expect(page.bottoms()).toBe(1);
  });

  it("raises nothing for the reader's own comment sent while away", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    // Sent while away: first a pending row, then the comment it became.
    await page.pending([{ key: 1, comment: own(104) }]);
    expect(newMessagesShown(page.view)).toBe(false);
    page.items.push(own(104));
    await page.refetch();
    expect(newMessagesShown(page.view)).toBe(false);
    await page.pending([]);
    expect(newMessagesShown(page.view)).toBe(false);
  });

  it("raises nothing when the reader's own comment fails to send", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(HEIGHT - VIEWPORT - 400);
    await page.pending([{ key: 1, comment: own(104) }]);
    // The send fails: the row leaves the timeline for the composer's retry.
    await page.pending([]);
    expect(newMessagesShown(page.view)).toBe(false);
  });

  it("raises nothing for the reader's own events", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    page.items.push(ownLabelAdded(200), ownLabelAdded(201));
    await page.refetch();
    await page.view.findByTestId("event-group");
    expect(newMessagesShown(page.view)).toBe(false);
  });

  it("counts the comments others sent since the reader left, not their /me actions", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    page.items.push(comment(104), comment(105), {
      ...comment(106),
      kind: "action",
    });
    await page.refetch();
    await page.view.findByText("body 105");
    expect(shownAs(page.view)).toBe("2 new messages");
    expect(countShown(page.view)).toBe("2");
    await page.arrive(107);
    expect(shownAs(page.view)).toBe("3 new messages");
    expect(countShown(page.view)).toBe("3");
  });

  it("leaves the reader's own items out of the count and the landing", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    await page.pending([{ key: 1, comment: own(104) }]);
    page.items.push(own(104));
    await page.refetch();
    await page.pending([]);
    await page.arrive(105);
    expect(shownAs(page.view)).toBe("1 new message");
    clickNewMessages(page.view);
    expect(page.flashed().map((el) => el.id)).toEqual(["comment-105"]);
  });

  it("counts a comment that arrived while the reader's own was still sending", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(HEIGHT - VIEWPORT);
    await page.pending([{ key: 1, comment: own(106) }]);
    page.readerAt(0);
    // Someone else's arrives above the row still sending; the row then
    // becomes the comment created after it.
    await page.arrive(105);
    page.items.push(own(106));
    await page.refetch();
    await page.pending([]);
    expect(shownAs(page.view)).toBe("1 new message");
    clickNewMessages(page.view);
    expect(page.flashed().map((el) => el.id)).toEqual(["comment-105"]);
  });

  it("shows someone else's long comment from its top when it arrives above the reader's own still sending", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(HEIGHT - VIEWPORT);
    await page.pending([{ key: 1, comment: own(104) }]);
    expect(page.bottoms()).toBe(2);
    // The refresh after the send, with the row still at the end: the
    // reader's own comment, then someone else's three screens long.
    placeAt((el) => el.id === "comment-105", { top: 300, height: 3000 });
    page.grow(3000);
    page.items.push(own(104), comment(105));
    await page.refetch();
    await page.view.findByText("body 105");
    const top = HEIGHT - VIEWPORT + 300 - usableViewport().top;
    expect(page.scrolledTo()).toBe(top);
    await page.pending([]);
    expect(page.scrolledTo()).toBe(top);
    expect(newMessagesShown(page.view)).toBe(false);
  });

  it("shows 99+ past 99", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    for (let id = 104; id < 204; id++) page.items.push(comment(id));
    await page.refetch();
    await page.view.findByText("body 203");
    expect(shownAs(page.view)).toBe("100 new messages");
    expect(countShown(page.view)).toBe("99+");
  });

  it("keeps its number while it fades out", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    await page.arrive(104);
    await page.arrive(105);
    clickNewMessages(page.view);
    const button = page.view.getByRole("button", { name: "2 new messages" });
    expect(
      button.closest("[data-scroll-to-bottom]")?.getAttribute("data-state"),
    ).toBe("hidden");
    expect(countShown(page.view)).toBe("2");
  });

  it("counts down as the reader scrolls the new comments into view", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    await page.arrive(104);
    await page.arrive(105);
    expect(shownAs(page.view)).toBe("2 new messages");
    // The start of the first comes into view, between header and composer.
    placeAt((el) => el.id === "comment-104", { top: 300, height: 100 });
    page.readerAt(100);
    expect(shownAs(page.view)).toBe("1 new message");
    placeAt((el) => el.id === "comment-105", { top: 400, height: 100 });
    page.readerAt(200);
    expect(newMessagesShown(page.view)).toBe(false);
  });

  it("counts an arrival below the screen, not one whose start is already on it", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    // Below the composer: not in view yet.
    placeAt((el) => el.id === "comment-104", {
      top: VIEWPORT + 100,
      height: 100,
    });
    await page.arrive(104);
    expect(shownAs(page.view)).toBe("1 new message");
    // On screen as it arrives, and no scroll after it.
    placeAt((el) => el.id === "comment-105", { top: 300, height: 100 });
    await page.arrive(105);
    expect(shownAs(page.view)).toBe("1 new message");
  });

  it("lands on the first new comment not yet seen", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    await page.arrive(104);
    await page.arrive(105);
    placeAt((el) => el.id === "comment-104", { top: 300, height: 100 });
    page.readerAt(100);
    clickNewMessages(page.view);
    expect(page.flashed().map((el) => el.id)).toEqual(["comment-105"]);
  });

  it("counts what arrives behind a fold while the item last seen is in the tail", async () => {
    // 120 in all: the first 50 in the head, the newest 50 in the tail.
    const page = await open("", { paged: true, initial: 120 });
    await waitFor(() => expect(page.bottoms()).toBe(1));
    await page.view.findByText("body 150");
    page.readerAt(0);
    await page.arrive(221);
    await page.arrive(222);
    expect(shownAs(page.view)).toBe("2 new messages");
  });

  it("counts what arrives once the head and the tail meet, with no fold", async () => {
    const page = await open("", { paged: true, initial: 40 });
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    // 70 in all: the item last seen is in the head, and nothing is folded.
    for (let id = 141; id < 171; id++) page.items.push(comment(id));
    await page.refetch();
    await page.view.findByText("body 170");
    await page.view.findByText("body 101");
    expect(shownAs(page.view)).toBe("30 new messages");
  });

  it("takes an item of a kind it does not know for someone else's, with no number", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    // From a newer server: neither an author nor an actor.
    page.items.push({
      type: "poll",
      id: 300,
      created_at: "2026-09-08T10:00:00Z",
    } as unknown as TimelineItem);
    await page.refetch();
    await page.view.findByText("Unknown timeline item: poll");
    expect(shownAs(page.view)).toBe("New messages");
    expect(newMessagesShown(page.view)).toBe(true);
  });

  it("writes no number once the arrivals outgrow what is loaded", async () => {
    const page = await open("", { paged: true });
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    await page.arrive(104);
    await page.arrive(105);
    expect(shownAs(page.view)).toBe("2 new messages");
    // 123 in all: the tail holds the newest 50, the head the first 50, and
    // the 23 between them, after the last item seen, are not loaded.
    for (let id = 106; id < 224; id++) page.items.push(comment(id));
    await page.refetch();
    await page.view.findByText("body 223");
    await page.view.findByText("body 150");
    expect(shownAs(page.view)).toBe("New messages");
    expect(countShown(page.view)).toBeNull();
    clickNewMessages(page.view);
    expect(page.flashed().map((el) => el.id)).toEqual(["comment-104"]);
  });

  it("New messages goes to the end when the last item seen is gone", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    await page.arrive(104);
    page.items.splice(
      page.items.findIndex((item) => item.id === 103),
      1,
    );
    await page.refetch();
    await waitFor(() => expect(page.view.queryByText("body 103")).toBeNull());
    // With nothing to count from, no number.
    expect(shownAs(page.view)).toBe("New messages");
    clickNewMessages(page.view);
    expect(page.bottoms()).toBe(2);
  });

  it("New messages, holding the first new item, announces what comes next", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    await page.arrive(104);
    clickNewMessages(page.view);
    // Where the landing put the page, at the end.
    page.revealedAt(HEIGHT - VIEWPORT);
    expect(newMessagesShown(page.view)).toBe(false);
    await page.arrive(105);
    // Not followed off the item the reader was sent to, but told.
    expect(page.bottoms()).toBe(1);
    expect(newMessagesShown(page.view)).toBe(true);
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
    expect(newMessagesShown(page.view)).toBe(true);
  });
});

/**
 * happy-dom's IntersectionObserver never calls back; this one does when the
 * test says where the end of the list is.
 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  disconnected = false;
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  fire(isIntersecting: boolean) {
    if (this.disconnected) return;
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

/**
 * The scroll-to-bottom button: hidden until the reader scrolls down with the
 * end of the conversation still below, gone again when they scroll up or
 * reach the end. Directions come from the reader's input and count once the
 * window has moved that way; the page's own scrolls carry no input.
 */
describe("the scroll-to-bottom button", () => {
  afterEach(() => {
    FakeIntersectionObserver.instances = [];
    for (const el of document.querySelectorAll("[data-test-editable]"))
      el.remove();
  });

  async function openAway() {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    // Up in the body, with no direction to it: a wheel without a delta.
    page.readerAt(2_000);
    const layer = () =>
      page.view.container.querySelector<HTMLElement>("[data-scroll-to-bottom]");
    const shown = () => {
      const el = layer();
      // Hidden is both: unseen, and out of reach of a click or Tab.
      if (el?.dataset.state === "shown" && !el.hasAttribute("inert"))
        return true;
      if (el?.dataset.state === "hidden" && el.hasAttribute("inert"))
        return false;
      throw new Error(`layer half shown: ${el?.outerHTML}`);
    };
    /** Where the end of the conversation is, as the observer reports it. */
    const endBelow = (below: boolean) =>
      act(() => {
        for (const observer of FakeIntersectionObserver.instances)
          observer.fire(!below);
      });
    /** The reader's input, then the window moving by `dy`. */
    const reader = (input: () => void, dy: number) => {
      input();
      page.revealedAt(page.at() + dy);
    };
    const wheel = (deltaY: number) => () => fireEvent.wheel(window, { deltaY });
    endBelow(true);
    return { ...page, layer, shown, endBelow, reader, wheel };
  }

  it("stays hidden while the reader has not scrolled", async () => {
    const page = await openAway();
    expect(page.layer()).not.toBeNull();
    expect(page.shown()).toBe(false);
  });

  it("shows on a scroll down, and lands on the end when clicked", async () => {
    const page = await openAway();
    page.reader(page.wheel(100), 100);
    expect(page.shown()).toBe(true);
    const button = page.view.getByRole("button", { name: "Scroll to bottom" });
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(page.bottoms()).toBe(2);
    resizePage();
    expect(page.bottoms()).toBe(3);
    expect(page.shown()).toBe(false);
  });

  it("hides on a scroll up", async () => {
    const page = await openAway();
    page.reader(page.wheel(100), 100);
    expect(page.shown()).toBe(true);
    page.reader(page.wheel(-100), -100);
    expect(page.shown()).toBe(false);
  });

  it("takes no direction from its own landing", async () => {
    const page = await openAway();
    page.reader(page.wheel(100), 100);
    // Turned again just before the click: the landing comes within a second.
    fireEvent.wheel(window, { deltaY: 100 });
    const button = page.view.getByRole("button", { name: "Scroll to bottom" });
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    page.revealedAt(page.at());
    expect(page.shown()).toBe(false);
  });

  it("takes no direction from following a new item", async () => {
    const page = await openAway();
    // At the end, a little short of it, and turning the wheel there.
    page.readerAt(HEIGHT - VIEWPORT - 30);
    fireEvent.wheel(window, { deltaY: 100 });
    // Short, on the viewport's bottom edge: what follows it is the end.
    placeAt((el) => el.id === "comment-104", {
      top: VIEWPORT - 100,
      height: 80,
    });
    await page.arrive(104);
    await waitFor(() => expect(page.bottoms()).toBe(2));
    page.revealedAt(page.at());
    expect(page.shown()).toBe(false);
  });

  it("takes no direction from a landing after a drag that sent no release", async () => {
    const page = await openAway();
    // At the end, a little short of it.
    page.readerAt(HEIGHT - VIEWPORT - 30);
    // A scrollbar press that never sent its pointerup, and no move since.
    fireEvent.pointerDown(document.documentElement);
    placeAt((el) => el.id === "comment-104", {
      top: VIEWPORT - 100,
      height: 80,
    });
    await page.arrive(104);
    await waitFor(() => expect(page.bottoms()).toBe(2));
    page.revealedAt(page.at());
    expect(page.shown()).toBe(false);
  });

  it("ends a scrollbar drag that sent no release at the next move", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const page = await openAway();
    // Dragging the scrollbar: the movement itself is the direction.
    fireEvent.pointerDown(document.documentElement);
    page.revealedAt(page.at() + 100);
    expect(page.shown()).toBe(true);
    page.reader(page.wheel(-100), -100);
    expect(page.shown()).toBe(false);
    // Let go outside the window: no pointerup, only a move with no button.
    fireEvent.pointerMove(window, { buttons: 0 });
    clock += 2_000;
    page.revealedAt(page.at() + 100);
    expect(page.shown()).toBe(false);
  });

  it("lets go of the window and the observer when it unmounts", async () => {
    const live = trackWindowListeners();
    const page = await openAway();
    page.view.unmount();
    expect(live()).toEqual([]);
    expect(
      FakeIntersectionObserver.instances.every((o) => o.disconnected),
    ).toBe(true);
  });

  it.each([
    ["the page moves by itself", () => {}, 100],
    ["a wheel scrolls something inside the page", "wheel", 0],
    ["the window barely moves", "wheel", 4],
  ] as const)("stays hidden when %s", async (_, input, dy) => {
    const page = await openAway();
    page.reader(input === "wheel" ? page.wheel(100) : input, dy);
    expect(page.shown()).toBe(false);
  });

  it("takes the scrolling keys, unless they are typing", async () => {
    const page = await openAway();
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    editable.dataset.testEditable = "";
    document.body.append(editable);
    page.reader(() => fireEvent.keyDown(editable, { key: "ArrowDown" }), 100);
    expect(page.shown()).toBe(false);
    page.reader(
      () => fireEvent.keyDown(document.body, { key: "ArrowDown" }),
      100,
    );
    expect(page.shown()).toBe(true);
  });

  it("takes a finger dragging the page down", async () => {
    const page = await openAway();
    page.reader(() => {
      fireEvent.touchStart(window, { touches: [{ clientY: 500 }] });
      fireEvent.touchMove(window, { touches: [{ clientY: 480 }] });
      fireEvent.touchMove(window, { touches: [{ clientY: 440 }] });
    }, 60);
    expect(page.shown()).toBe(true);
  });

  it("hides at the end, and waits for the next scroll down", async () => {
    const page = await openAway();
    page.reader(page.wheel(100), 100);
    expect(page.shown()).toBe(true);
    page.endBelow(false);
    expect(page.shown()).toBe(false);
    page.endBelow(true);
    expect(page.shown()).toBe(false);
  });

  it("points New messages up at items above a reader past the end", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    // The list's end above the viewport, as in a phone's sidebar below the
    // comment box; read as the item arrives, with no scroll to say so.
    const list = page.view.getByTestId("timeline-scroll");
    const measure = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        // The new comment above the viewport with the rest: never in view,
        // so not seen.
        return this === list
          ? ({ top: -900, bottom: -100, height: 800 } as DOMRect)
          : this.id === "comment-104"
            ? ({ top: -500, bottom: -400, height: 100 } as DOMRect)
            : measure.call(this);
      },
    );
    await page.arrive(104);
    expect(newMessagesShown(page.view)).toBe(true);
    const button = page.view.getByRole("button", { name: NEW_MESSAGES });
    expect(button.querySelector(".lucide-arrow-up")).not.toBeNull();
    clickNewMessages(page.view);
    expect(page.flashed().map((el) => el.id)).toEqual(["comment-104"]);
  });

  it("turns New messages back down when a resize brings the list's end below the header", async () => {
    const page = await open();
    await waitFor(() => expect(page.bottoms()).toBe(1));
    page.readerAt(0);
    const list = page.view.getByTestId("timeline-scroll");
    const bottom = { y: -100 };
    const measure = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        return this === list
          ? ({ top: bottom.y - 800, bottom: bottom.y, height: 800 } as DOMRect)
          : measure.call(this);
      },
    );
    await page.arrive(104);
    const arrow = () =>
      page.view
        .getByRole("button", { name: NEW_MESSAGES })
        .querySelector(".lucide-arrow-up, .lucide-arrow-down")
        ?.getAttribute("class");
    expect(arrow()).toContain("lucide-arrow-up");
    // A rotation, with no scroll: the list's end is now on screen below.
    bottom.y = 500;
    fireEvent(window, new Event("resize"));
    expect(arrow()).toContain("lucide-arrow-down");
  });

  it("takes no direction from the landing New messages makes", async () => {
    const page = await openAway();
    await page.arrive(104);
    // Turned just before the click: the landing comes within a second.
    fireEvent.wheel(window, { deltaY: 100 });
    clickNewMessages(page.view);
    // Down to the first new item, the page's own scroll.
    page.revealedAt(page.at() + 500);
    expect(page.shown()).toBe(false);
  });

  it("is New messages when something arrives, whichever way the reader scrolls", async () => {
    const page = await openAway();
    await page.arrive(104);
    const layer = page.layer() as HTMLElement;
    expect(page.shown()).toBe(true);
    expect(
      within(layer)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim()),
    ).toEqual(["1 new message"]);
    page.reader(page.wheel(-100), -100);
    expect(page.shown()).toBe(true);
  });
});
