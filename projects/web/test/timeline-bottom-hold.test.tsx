import { act, fireEvent, waitFor, within } from "@testing-library/react";
import type { TimelineComment, TimelinePage } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "../src/components/timeline/timeline.tsx";
import { FakeResizeObserver, resizePage } from "./fake-resize-observer.ts";
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

/**
 * The card's timeline, with a page geometry to scroll in. `bottoms` counts the
 * scrolls to the end of the document; `readerAt` is the reader's own scroll,
 * gesture first, the way a browser delivers it.
 */
async function open(hash = "") {
  const items = [comment(101), comment(102), comment(103)];
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
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
  const state = { y: 0 };
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(VIEWPORT);
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => state.y);
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
    HEIGHT,
  );
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
    VIEWPORT,
  );
  let bottoms = 0;
  vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
    // The largest offset there is, never `scrollHeight` itself: iOS takes
    // the overshoot literally for a frame and shows a blank screen (T-585).
    if (args[1] === HEIGHT - VIEWPORT) {
      bottoms += 1;
      state.y = HEIGHT - VIEWPORT;
    }
  });
  const reveals: string[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
  ) {
    reveals.push(this.id);
  });
  const client = testQueryClient();
  const view = renderWithProviders(
    <Timeline
      slug="p"
      issueNumber={7}
      pendingComments={[]}
      viewer={{ id: 1, isAdmin: false, role: "writer" }}
    />,
    client,
    { initialEntry: `/${hash}` },
  );
  await view.findByText("body 103");
  const arrive = async (id: number) => {
    items.push(comment(id));
    await act(() =>
      client.refetchQueries({ queryKey: ["timeline", "p", 7, "tail"] }),
    );
    await view.findByText(`body ${id}`);
  };
  return {
    view,
    arrive,
    reveals,
    bottoms: () => bottoms,
    at: () => state.y,
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

/**
 * New messages is up: the button, in a layer that is showing. The layer stays
 * mounted, and the button in it keeps its look while it fades out.
 */
function newMessagesShown(view: ReturnType<typeof renderWithProviders>) {
  return (
    view
      .queryByRole("button", { name: "New messages" })
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
    // The anchor sits within a screen of the end: follow-bottom's own test.
    page.revealedAt(HEIGHT - VIEWPORT - 300);
    await page.arrive(104);
    resizePage();
    expect(page.bottoms()).toBe(0);
    expect(page.reveals.at(-1)).toBe("comment-102");
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
    // Within a screen of the end, and turning the wheel there.
    page.readerAt(HEIGHT - VIEWPORT - 300);
    fireEvent.wheel(window, { deltaY: 100 });
    await page.arrive(104);
    await waitFor(() => expect(page.bottoms()).toBe(2));
    page.revealedAt(page.at());
    expect(page.shown()).toBe(false);
  });

  it("takes no direction from a landing after a drag that sent no release", async () => {
    const page = await openAway();
    page.readerAt(HEIGHT - VIEWPORT - 300);
    // A scrollbar press that never sent its pointerup, and no move since.
    fireEvent.pointerDown(document.documentElement);
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

  it("is New messages when something arrives, whichever way the reader scrolls", async () => {
    const page = await openAway();
    await page.arrive(104);
    const layer = page.layer() as HTMLElement;
    expect(page.shown()).toBe(true);
    expect(
      within(layer)
        .getAllByRole("button")
        .map((b) => b.textContent?.trim()),
    ).toEqual(["New messages"]);
    page.reader(page.wheel(-100), -100);
    expect(page.shown()).toBe(true);
  });
});
