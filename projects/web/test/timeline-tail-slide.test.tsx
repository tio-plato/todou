import { act, cleanup, fireEvent } from "@testing-library/react";
import type {
  TimelineComment,
  TimelineItem,
  TimelinePage,
} from "@todou/shared";
import { type ReactNode, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RevealedRunsProvider } from "../src/components/timeline/revealed-runs.tsx";
import { Timeline } from "../src/components/timeline/timeline.tsx";
import { useScrollInsets } from "../src/lib/scroll-insets.ts";
import { FakeResizeObserver } from "./fake-resize-observer.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * Past a page, the timeline is a head window and a tail window with the fold
 * between them, and an arrival refetches the newest page: the tail's oldest
 * item slides into the fold and leaves the page, above a reader scrolled up
 * into the tail. Content also grows above a reader with no input of theirs:
 * the head arriving after the tail, a Load more, the first load's fill
 * revealed in one go (T-602, T-690), an image.
 *
 * happy-dom lays nothing out, so here the list's children stand one under the
 * other from `above` down the page: a unit 100px tall unless the test grows
 * it, a placeholder's skeleton 60, a unit still behind its placeholder none,
 * the fold block and the head's loading skeletons a unit's height. What
 * follows the list runs on far past the screen, unless the page declares
 * where its conversation ends, which is then the comment box's bottom with a
 * footer below it. A frame delivers what a browser's next frame would: the
 * scroll event of whatever moved the page, then the resizes.
 */

const alice = {
  id: 2,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (id: number, hidden = false): TimelineComment => ({
  type: "comment",
  id,
  author: alice,
  body: `body ${id}`,
  component: null,
  created_at: "2026-09-08T10:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: hidden ? "2026-09-08T11:00:00Z" : null,
  agent_context: null,
});

const VIEWPORT = 800;
const ROW = 100;
const SKELETON = 60;
/** Everything after the list where no end is declared. */
const BELOW = 3000;
/** The comment box ending the conversation, and the footer after it. */
const COMPOSER = 200;
const FOOTER = 300;

type Options = {
  /** Comments on the card, numbered from 1. */
  total?: number;
  /** Comments the head serves per page, and the tail serves. */
  head?: number;
  tail?: number;
  /** The comments that are hidden. */
  hidden?: number[];
  /** Heights past a unit's own, by unit key. */
  grown?: Record<string, number>;
  /** How far down the page the list starts. */
  above?: number;
  /** Whether the page declares where its conversation ends. */
  end?: boolean;
  /** Whether the head's pages wait for the test to let them through. */
  holdHead?: boolean;
};

/** A page that declares its column as where its conversation ends. */
function Column({ children }: { children: ReactNode }) {
  const column = useRef<HTMLDivElement>(null);
  useScrollInsets({ end: column });
  return <div ref={column}>{children}</div>;
}

async function open({
  total = 30,
  head = 10,
  tail = 5,
  hidden = [],
  grown = {},
  above = 0,
  end = false,
  holdHead = false,
}: Options = {}) {
  const items: TimelineItem[] = Array.from({ length: total }, (_, i) =>
    comment(i + 1, hidden.includes(i + 1)),
  );
  // Head pages held back, each let through by the test.
  const heldHead: Array<() => void> = [];
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = new URL(String(input), "http://todou.example");
    if (url.pathname.endsWith("/timeline")) {
      const last = url.searchParams.get("last") === "1";
      const after = url.searchParams.get("after");
      if (!last && holdHead)
        await new Promise<void>((done) => heldHead.push(done));
      const from = after === null ? 0 : Number(after.slice(1)) * head;
      const page: TimelinePage = last
        ? {
            items: items.slice(-tail),
            prev_cursor: items.length > tail ? "p1" : null,
            next_cursor: "t1",
            total_count: items.length,
          }
        : {
            items: items.slice(from, from + head),
            prev_cursor: null,
            next_cursor: `h${from / head + 1}`,
            total_count: items.length,
          };
      return Response.json(page);
    }
    return Response.json(
      url.pathname.endsWith("/references/config")
        ? { format: { prefix: "T", history: [] }, autolinks: [] }
        : url.pathname.endsWith("/reference-directory")
          ? { entries: [], contested: [], slug_entries: [] }
          : [],
    );
  }) as typeof fetch);
  // Idle callbacks held until the case runs them, each with no time left:
  // one unit per callback, so the fill goes at the pace the case sets.
  const idle = new Map<number, IdleRequestCallback>();
  let idleIds = 0;
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    idle.set(++idleIds, callback);
    return idleIds;
  });
  vi.stubGlobal("cancelIdleCallback", (id: number) => idle.delete(id));
  /** The oldest idle callback still waiting, taken off the queue. */
  const nextIdle = () => {
    const [first] = idle;
    if (first === undefined) return undefined;
    idle.delete(first[0]);
    return first[1];
  };
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);

  const state = {
    y: 0,
    /** Where the last scroll event found the page. */
    sent: 0,
    above,
    grown: new Map(Object.entries(grown)),
  };
  const listOf = () =>
    document.querySelector<HTMLElement>('[data-testid="timeline-scroll"]');
  const heightOf = (child: Element) => {
    if (child.hasAttribute("data-unfilled")) return SKELETON;
    if (child.classList.contains("h-0")) return 0;
    const unit = child.getAttribute("data-unit");
    if (unit !== null) return ROW + (state.grown.get(unit) ?? 0);
    // The fold block and the head's loading skeletons; the list's end
    // marker holds nothing.
    return child.childElementCount > 0 ? ROW : 0;
  };
  const listHeight = () =>
    [...(listOf()?.children ?? [])].reduce((sum, c) => sum + heightOf(c), 0);
  const docHeight = () =>
    state.above + listHeight() + (end ? COMPOSER + FOOTER : BELOW);
  const max = () => Math.max(0, docHeight() - VIEWPORT);
  const clamp = (y: number) => Math.min(max(), Math.max(0, y));

  vi.spyOn(window, "innerHeight", "get").mockReturnValue(VIEWPORT);
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => state.y);
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockImplementation(
    docHeight,
  );
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
    VIEWPORT,
  );
  /** The vertical offset of a scroll called as `(x, y)` or `({ top })`. */
  const offset = (args: unknown[]) =>
    typeof args[0] === "object"
      ? (args[0] as ScrollToOptions | null)?.top
      : (args[1] as number | undefined);
  const scrollTo = vi
    .spyOn(window, "scrollTo")
    .mockImplementation((...args: unknown[]) => {
      const y = offset(args);
      if (y !== undefined) state.y = clamp(y);
    });
  const scrollBy = vi
    .spyOn(window, "scrollBy")
    .mockImplementation((...args: unknown[]) => {
      const y = offset(args);
      if (y !== undefined) state.y = clamp(state.y + y);
    });
  // Each child of the list, and what it holds, at the child's own place.
  const unplaced = Element.prototype.getBoundingClientRect;
  const box = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const list = listOf();
      if (list === null) return unplaced.call(this);
      if (this === list) return box(state.above - state.y, listHeight());
      if (end && this === list.parentElement)
        return box(state.above - state.y, listHeight() + COMPOSER);
      let child: Element | null = this;
      while (child !== null && child.parentElement !== list)
        child = child.parentElement;
      if (child === null) return unplaced.call(this);
      let top = state.above;
      for (const before of list.children) {
        if (before === child) break;
        top += heightOf(before);
      }
      return box(top - state.y, heightOf(child));
    },
  );

  // The size each observer last heard of each element it watches.
  const heard = new Map<FakeResizeObserver, Map<Element, number>>();
  const sizeOf = (el: Element) =>
    el === document.body ? docHeight() : el.getBoundingClientRect().height;
  /** A browser's next frame: the scroll event, then the resizes. */
  const frame = () =>
    act(async () => {
      if (state.y !== state.sent) {
        state.sent = state.y;
        fireEvent.scroll(window);
      }
      for (const observer of [...FakeResizeObserver.instances]) {
        if (observer.disconnected) continue;
        const sizes = heard.get(observer) ?? new Map<Element, number>();
        heard.set(observer, sizes);
        let resized = false;
        for (const el of observer.observed) {
          const size = sizeOf(el);
          if (sizes.get(el) !== size) resized = true;
          sizes.set(el, size);
        }
        if (resized) observer.fire();
      }
    });
  /** Frames until nothing moves any more. */
  const settle = async () => {
    for (let i = 0; i < 6; i++) await frame();
  };

  const client = testQueryClient();
  const timeline = (
    <RevealedRunsProvider card="p/7">
      <Timeline slug="p" issueNumber={7} pendingComments={[]} />
    </RevealedRunsProvider>
  );
  const view = renderWithProviders(
    end ? <Column>{timeline}</Column> : timeline,
    client,
  );
  await view.findByText(`body ${total}`);
  if (total > tail && !holdHead) await view.findByText(`body ${head}`);
  await settle();

  const unit = (key: string | number) =>
    view.container.querySelector<HTMLElement>(
      `[data-unit="${typeof key === "number" ? `comment-${key}` : key}"]`,
    );
  /** Where a unit's top is on screen. */
  const topOf = (key: string | number) =>
    unit(key)?.getBoundingClientRect().top;
  return {
    view,
    unit,
    topOf,
    frame,
    settle,
    at: () => state.y,
    max,
    scrollTo,
    scrollBy,
    /** The page as tall as all it holds, the way the browser reports it. */
    docHeight,
    arrive: async (id: number) => {
      items.push(comment(id));
      await act(() =>
        client.refetchQueries({ queryKey: ["timeline", "p", 7, "tail"] }),
      );
      await view.findByText(`body ${id}`);
      await settle();
    },
    /** Let the oldest head page still held back through. */
    releaseHead: async () => {
      for (let i = 0; i < 50 && heldHead.length === 0; i++)
        await act(() => Promise.resolve());
      await act(async () => {
        heldHead.shift()?.();
      });
    },
    /** Run every idle callback the fill has asked for, as they come. */
    fillAll: async () => {
      for (let run = nextIdle(); run; run = nextIdle()) {
        const callback = run;
        await act(async () => {
          callback({ didTimeout: true, timeRemaining: () => 0 });
        });
      }
      await settle();
    },
    /** Run the fill's next idle callback alone. */
    fillOne: async () => {
      const callback = nextIdle();
      await act(async () => {
        callback?.({ didTimeout: true, timeRemaining: () => 0 });
      });
      await settle();
    },
    /** What lies above the list grows, in no commit of the timeline's. */
    growAbove: async (by: number) => {
      state.above += by;
      await settle();
    },
    /** One unit grows, in no commit of the timeline's: an image loading. */
    growUnit: async (key: string, by: number) => {
      state.grown.set(key, (state.grown.get(key) ?? 0) + by);
      await settle();
    },
    /** The reader's own scroll, gesture first, as a browser delivers it. */
    readerAt: (y: number) => {
      fireEvent.wheel(window);
      state.y = clamp(y);
      state.sent = state.y;
      fireEvent.scroll(window);
    },
    /** Something with no input behind it moves the page: find in page. */
    movedTo: async (y: number) => {
      state.y = clamp(y);
      await settle();
    },
    /** A press that scrolls nothing, on `el`. */
    press: (el: Element) => {
      fireEvent.pointerDown(el);
      fireEvent.pointerUp(el);
      fireEvent.click(el);
    },
  };
}

afterEach(() => {
  // Unmounted while the stubs it cleans up against are still in place.
  cleanup();
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

  it("leaves the reader's place where it was as the fold block first appears", async () => {
    // Head 1–10 and tail 11–15 meet: no fold yet. 11 stands taller than the
    // fold block that takes its place.
    const page = await open({ total: 15, grown: { "comment-11": 50 } });
    expect(page.view.queryByTestId("fold-block")).toBeNull();
    page.readerAt(11 * ROW);
    const before = page.topOf(12);
    await page.arrive(16);
    expect(page.unit(11)).toBeNull();
    expect(page.view.queryByTestId("fold-block")).not.toBeNull();
    expect(page.topOf(12)).toBe(before);
  });

  it("counts a new comment that slid in just below the screen as unseen", async () => {
    const page = await open();
    // The seam, 26, three rows down; 30 on the screen's last row.
    page.readerAt(8 * ROW);
    expect(page.topOf(30)).toBe(7 * ROW);
    await page.arrive(31);
    // 26 left above the reader, so 31 starts where the screen ends.
    expect(page.topOf(31)).toBe(VIEWPORT);
    expect(
      page.view.getByRole("button", { name: "1 new message" }),
    ).toBeTruthy();
  });
});

describe("Load more (T-30)", () => {
  const loadMore = async (page: Awaited<ReturnType<typeof open>>) => {
    const button = page.view.getByRole("button", { name: "Load more" });
    page.press(button);
    await page.view.findByText("body 20");
    await page.settle();
  };

  it("keeps the tail where it was when the seam is in the screen's upper half", async () => {
    const page = await open();
    // The fold block a row down, the seam two.
    page.readerAt(9 * ROW);
    const tail = page.topOf(26);
    expect(tail).toBe(2 * ROW);
    await loadMore(page);
    expect(page.topOf(26)).toBe(tail);
  });

  it("opens the chunk where the button was when the seam is in the lower half", async () => {
    const page = await open();
    // The fold block five rows down, the seam six.
    page.readerAt(5 * ROW);
    const fold = page.view.getByTestId("fold-block").getBoundingClientRect();
    const head = page.topOf(10);
    await loadMore(page);
    expect(page.topOf(11)).toBe(fold.top);
    expect(page.topOf(10)).toBe(head);
  });
});

describe("the head arriving after the tail", () => {
  it("leaves what a reader scrolled up into the tail is reading where it was", async () => {
    const page = await open({ holdHead: true });
    // The head's skeletons, then 26 above 27, which shows its lower half.
    page.readerAt(250);
    const before = page.topOf(27);
    expect(before).toBe(-50);
    await page.releaseHead();
    await page.view.findByText("body 10");
    await page.settle();
    expect(page.topOf(27)).toBe(before);
  });
});

describe("the first load's fill (T-602, T-690)", () => {
  it("leaves the unit a reader scrolled to where it was once the fill is revealed", async () => {
    // 1–6 wait as placeholders above 7–12.
    const page = await open({ total: 12, tail: 50 });
    expect(page.unit("comment-1")?.hasAttribute("data-unfilled")).toBe(true);
    // Six skeletons, then 7, with 8 at the top of the screen.
    page.readerAt(6 * SKELETON + ROW);
    const before = page.topOf(8);
    expect(before).toBe(0);
    await page.fillAll();
    expect(page.unit("comment-1")?.hasAttribute("data-unfilled")).toBe(false);
    expect(page.topOf(8)).toBe(before);
  });
});

describe("a hidden run revealed (T-281)", () => {
  it("opens downward from where the run was", async () => {
    const page = await open({ total: 8, tail: 50, hidden: [3, 4, 5] });
    // 1, 2, the run of three, 6, 7, 8: the run at the top of the screen.
    page.readerAt(2 * ROW);
    expect(page.topOf("hidden-3")).toBe(0);
    page.press(page.view.getByRole("button", { name: "Reveal" }));
    await page.view.findByText("body 3");
    await page.settle();
    expect(page.at()).toBe(2 * ROW);
    expect(page.topOf(3)).toBe(0);
    expect(page.topOf(6)).toBe(3 * ROW);
  });
});
