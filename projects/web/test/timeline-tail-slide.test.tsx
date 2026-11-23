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
import { TimelineDivider } from "../src/components/timeline/timeline-divider.tsx";
import { endHeldAt, useScrollInsets } from "../src/lib/scroll-insets.ts";
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
 * footer below it, the body's Edit button in the 40px right above the list,
 * and a shell header over the screen's top where the case asks for one. The
 * timeline's divider line, where the case asks for it, stands right before
 * the list: 16px while it carries the hidden count, 1px as a plain rule.
 * A frame delivers what a browser's next frame would: the scroll event of
 * whatever moved the page, then the resizes.
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
  /** How far down the page the list starts, its divider line first. */
  above?: number;
  /** Whether the page declares where its conversation ends. */
  end?: boolean;
  /** Whether the head's pages wait for the test to let them through. */
  holdHead?: boolean;
  /** How tall a shell header over the screen's top is, if there is one. */
  header?: number;
  /** Whether the timeline's divider line stands right before the list. */
  divider?: boolean;
};

/**
 * A page that declares its column as where its conversation ends, the card's
 * body, down to its Edit button, right above the list, and the comment box
 * right below it.
 */
function Column({ children }: { children: ReactNode }) {
  const column = useRef<HTMLDivElement>(null);
  useScrollInsets({ end: column });
  return (
    <div ref={column}>
      <button type="button">Edit</button>
      {children}
      <textarea aria-label="Write a comment" />
    </div>
  );
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
  header,
  divider = false,
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
  /** The divider line's height: the hidden count's row, or a rule. */
  const leadHeight = () => {
    if (!divider) return 0;
    const lead = listOf()?.previousElementSibling;
    return lead?.getAttribute("data-testid") === "timeline-divider" ? 16 : 1;
  };
  /** Where the list itself starts on the page, below its divider line. */
  const listAt = () => state.above + leadHeight();
  const docHeight = () =>
    listAt() + listHeight() + (end ? COMPOSER + FOOTER : BELOW);
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
      if (this === list) return box(listAt() - state.y, listHeight());
      if (end && this === list.parentElement)
        return box(
          state.above - state.y,
          leadHeight() + listHeight() + COMPOSER,
        );
      if (end && this === list.parentElement?.firstElementChild)
        return box(state.above - 40 - state.y, 40);
      if (divider && this === list.previousElementSibling)
        return box(state.above - state.y, leadHeight());
      if (end && this.matches('[aria-label="Write a comment"]'))
        return box(listAt() + listHeight() - state.y, COMPOSER);
      if (header !== undefined && this.closest("header") !== null)
        return box(0, header);
      let child: Element | null = this;
      while (child !== null && child.parentElement !== list)
        child = child.parentElement;
      if (child === null) return unplaced.call(this);
      let top = listAt();
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
      {divider && <TimelineDivider />}
      <Timeline slug="p" issueNumber={7} pendingComments={[]} />
    </RevealedRunsProvider>
  );
  const content = end ? <Column>{timeline}</Column> : timeline;
  const view = renderWithProviders(
    header === undefined ? (
      content
    ) : (
      <>
        <header>
          <button type="button">Menu</button>
        </header>
        {content}
      </>
    ),
    client,
  );
  await view.findByText(`body ${total}`);
  // The head in: the fold block where a gap is left, else its last comment
  // that shows (it may still be a placeholder where the fold block is).
  let lastShown = head;
  while (hidden.includes(lastShown)) lastShown -= 1;
  if (total > head + tail && !holdHead) await view.findByTestId("fold-block");
  else if (total > tail && !holdHead)
    await view.findByText(`body ${lastShown}`);
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
    /** Where a landing on the end puts the page, with an end declared. */
    endTarget: () => clamp(listAt() + listHeight() + COMPOSER - VIEWPORT),
    scrollTo,
    scrollBy,
    /** The page as tall as all it holds, the way the browser reports it. */
    docHeight,
    /** Comments arriving, all of them in one refetch of the newest page. */
    arrive: async (...ids: number[]) => {
      for (const id of ids) items.push(comment(id));
      await act(() =>
        client.refetchQueries({ queryKey: ["timeline", "p", 7, "tail"] }),
      );
      for (const id of ids) await view.findByText(`body ${id}`);
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
    /** The reader's wheel, its scroll not yet applied. */
    wheel: () => fireEvent.wheel(window),
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

describe("the reader's place, kept by one owner", () => {
  it("leaves a reader who can see what precedes the list to the browser", async () => {
    // The list's top 300px down the screen, the body above it in view.
    const page = await open({ total: 5, tail: 50, above: 2000 });
    page.readerAt(1700);
    page.scrollBy.mockClear();
    await page.growAbove(300);
    expect(page.scrollBy).not.toHaveBeenCalled();
    expect(page.at()).toBe(1700);
  });

  it("keeps the tail still through two arrivals with no scroll between", async () => {
    const page = await open();
    // The seam, 26, on top of the screen: the unit the reader reads.
    page.readerAt(11 * ROW);
    const before = page.topOf(28);
    await page.arrive(31);
    await page.arrive(32);
    expect(page.unit(27)).toBeNull();
    expect(page.topOf(28)).toBe(before);
  });

  it("keeps the tail still when one refetch slides two items out", async () => {
    const page = await open();
    page.readerAt(11 * ROW);
    const before = page.topOf(28);
    await page.arrive(31, 32);
    expect(page.unit(26)).toBeNull();
    expect(page.unit(27)).toBeNull();
    expect(page.topOf(28)).toBe(before);
  });

  it("keeps the tail with the seam in the upper half even with the body in view", async () => {
    // A head side of one row: the list's top, and the body above it, still
    // on screen, the seam above the middle.
    const page = await open({ head: 1, above: 300 });
    page.readerAt(250);
    expect(page.topOf(26)).toBe(2 * ROW + 300 - 250);
    const before = page.topOf(27);
    await page.arrive(31);
    expect(page.unit(26)).toBeNull();
    expect(page.topOf(27)).toBe(before);
    page.press(page.view.getByRole("button", { name: "Load more" }));
    await page.view.findByText("body 2");
    await page.settle();
    expect(page.topOf(27)).toBe(before);
  });

  it("keeps the tail when the reader presses the body above the list", async () => {
    // The body's Edit button on screen, the seam in the upper half.
    const page = await open({ head: 1, above: 300, end: true });
    page.readerAt(250);
    page.press(page.view.getByRole("button", { name: "Edit" }));
    const before = page.topOf(27);
    await page.arrive(31);
    expect(page.unit(26)).toBeNull();
    expect(page.topOf(27)).toBe(before);
  });

  it("keeps the tail when the reader clicks into it with the body in view", async () => {
    const page = await open({ head: 1, above: 300 });
    page.readerAt(250);
    page.press(page.unit(27) as HTMLElement);
    const before = page.topOf(27);
    await page.arrive(31);
    expect(page.unit(26)).toBeNull();
    expect(page.topOf(27)).toBe(before);
  });

  it("keeps the tail as the head arrives with the body still in view", async () => {
    // The head's skeletons, then 26 two rows down: the body above the list.
    const page = await open({ holdHead: true, above: 300 });
    page.readerAt(200);
    expect(page.topOf(26)).toBe(2 * ROW);
    const before = page.topOf(27);
    await page.releaseHead();
    await page.view.findByTestId("fold-block");
    await page.settle();
    expect(page.topOf(27)).toBe(before);
  });

  it("judges Load more by the seam, not by a row clicked before it", async () => {
    const page = await open();
    // 9 and 10 on top, the fold, the seam three rows down.
    page.readerAt(8 * ROW);
    page.press(page.unit(10) as HTMLElement);
    const tail = page.topOf(26);
    page.press(page.view.getByRole("button", { name: "Load more" }));
    await page.view.findByText("body 20");
    await page.settle();
    expect(page.topOf(26)).toBe(tail);
  });

  it("keeps a reader at the end there when skeletons fill the screen above", async () => {
    // The last six rows half height: skeletons show above them at the end.
    const short = Object.fromEntries(
      [7, 8, 9, 10, 11, 12].map((id) => [`comment-${id}`, -ROW / 2]),
    );
    const page = await open({ total: 12, tail: 50, end: true, grown: short });
    expect(page.at()).toBe(page.endTarget());
    expect(page.topOf("comment-3")).toBeGreaterThanOrEqual(0);
    page.press(page.view.container);
    await page.fillAll();
    expect(page.unit("comment-1")?.hasAttribute("data-unfilled")).toBe(false);
    expect(page.at()).toBe(page.endTarget());
  });

  it("keeps a reader at the end of a card with a head side there too", async () => {
    // The seam far above the screen, the tail's last six rows half height,
    // skeletons above them at the end.
    const short = Object.fromEntries(
      [25, 26, 27, 28, 29, 30].map((id) => [`comment-${id}`, -ROW / 2]),
    );
    const page = await open({ tail: 12, end: true, grown: short });
    expect(page.at()).toBe(page.endTarget());
    expect(page.unit("comment-20")?.hasAttribute("data-unfilled")).toBe(true);
    expect(page.topOf("comment-20")).toBeGreaterThanOrEqual(0);
    page.press(page.view.container);
    await page.fillAll();
    expect(page.unit("comment-20")?.hasAttribute("data-unfilled")).toBe(false);
    expect(page.at()).toBe(page.endTarget());
  });

  it("opens a run revealed above the seam downward from where it was", async () => {
    // 1–7, the run of 8–10, the fold, then the tail from 26.
    const page = await open({ hidden: [8, 9, 10] });
    // The run on top of the screen, the seam two rows down.
    page.readerAt(7 * ROW);
    expect(page.topOf("hidden-8")).toBe(0);
    expect(page.topOf(26)).toBe(2 * ROW);
    page.press(page.view.getByRole("button", { name: "Reveal" }));
    await page.view.findByText("body 8");
    await page.settle();
    expect(page.topOf(8)).toBe(0);
  });

  it("leaves a reader on what precedes the list alone as it grows above the list", async () => {
    const page = await open({ total: 5, tail: 50, above: 2000 });
    page.readerAt(0);
    page.scrollBy.mockClear();
    await page.growAbove(300);
    expect(page.scrollBy).not.toHaveBeenCalled();
    expect(page.at()).toBe(0);
  });

  it("keeps the unit on screen where it was once the fill is revealed after a press", async () => {
    // Landed on the end: 7 on top of the screen, the skeletons of 1–6 above.
    const page = await open({ total: 12, tail: 50, end: true });
    expect(page.topOf(7)).toBe(0);
    page.press(page.view.container);
    await page.fillAll();
    expect(page.unit("comment-1")?.hasAttribute("data-unfilled")).toBe(false);
    expect(page.topOf(7)).toBe(0);
  });

  it("brings the unit a skeleton stood for in where the skeleton was", async () => {
    const page = await open({ total: 12, tail: 50, end: true });
    // 6 filled, still behind its placeholder.
    await page.fillOne();
    expect(page.unit("comment-6")?.classList.contains("h-0")).toBe(true);
    // Five skeletons above, then 6's on top of the screen.
    page.readerAt(5 * SKELETON);
    const skeleton = page.topOf("comment-6-placeholder");
    expect(skeleton).toBe(0);
    // A fill that moves nothing leaves it where it is.
    await page.fillOne();
    expect(page.topOf("comment-6-placeholder")).toBe(skeleton);
    await page.fillAll();
    expect(page.topOf(6)).toBe(skeleton);
  });

  it("keeps a reader where find in page moved them off the landing", async () => {
    const page = await open({ total: 12, tail: 50, end: true });
    // Landed on the end, 7 on top; moved down a row with no input.
    await page.movedTo(page.at() + ROW);
    expect(page.topOf(8)).toBe(0);
    await page.fillAll();
    expect(page.topOf(8)).toBe(0);
  });
});

describe("a card whose list starts on screen, read at its end", () => {
  // A short card: the body above the list in view at the end, the first two
  // comments long, the last six half a row.
  const SHORT = {
    "comment-1": 3000,
    "comment-2": 3000,
    ...Object.fromEntries(
      [3, 4, 5, 6, 7, 8].map((id) => [`comment-${id}`, -ROW / 2]),
    ),
  };
  const shortCard = (more: Options = {}) =>
    open({ total: 8, tail: 50, end: true, above: 300, grown: SHORT, ...more });
  /** The column the list stands in: blank space in it, say. */
  const column = (page: Awaited<ReturnType<typeof open>>) =>
    page.view.getByTestId("timeline-scroll").parentElement as HTMLElement;

  it("keeps a reader at the end as the long comments reveal after a press", async () => {
    // Landed on the end, the list's top 180px down the screen, the long
    // comments still skeletons.
    const page = await shortCard();
    expect(page.at()).toBe(120);
    expect(page.unit("comment-1")?.hasAttribute("data-unfilled")).toBe(true);
    page.press(column(page));
    await page.fillAll();
    expect(page.unit("comment-1")?.hasAttribute("data-unfilled")).toBe(false);
    expect(page.at()).toBe(page.endTarget());
  });

  it("opens a run revealed at its end downward, and keeps it there as the long comments reveal", async () => {
    const page = await shortCard({
      hidden: [7],
      grown: { ...SHORT, "hidden-7": -ROW / 2, "comment-7": 200 },
    });
    const before = page.topOf("hidden-7");
    page.press(page.view.getByRole("button", { name: "Reveal" }));
    await page.view.findByText("body 7");
    await page.settle();
    await page.fillAll();
    expect(page.topOf(7)).toBe(before);
  });

  it("opens the card's last hidden comment where its run was as the divider shrinks", async () => {
    const page = await shortCard({
      divider: true,
      hidden: [7],
      grown: { ...SHORT, "hidden-7": -ROW / 2, "comment-7": 200 },
    });
    expect(page.view.queryByTestId("timeline-divider")).not.toBeNull();
    const before = page.topOf("hidden-7");
    page.press(page.view.getByRole("button", { name: "Reveal" }));
    await page.view.findByText("body 7");
    await page.settle();
    expect(page.view.queryByTestId("timeline-divider")).toBeNull();
    await page.fillAll();
    expect(page.topOf(7)).toBe(before);
  });

  it("puts back what grows in the list, and leaves what grows above it, at the end", async () => {
    const page = await shortCard();
    page.press(column(page));
    await page.growUnit("comment-4", 100);
    expect(page.at()).toBe(page.endTarget());
    const y = page.at();
    page.scrollBy.mockClear();
    await page.growAbove(40);
    expect(page.scrollBy).not.toHaveBeenCalled();
    expect(page.at()).toBe(y);
    await page.growUnit("comment-5", 100);
    expect(page.at()).toBe(y + 100);
  });

  it("keeps the end against what grows above once the reveal took the body out of view", async () => {
    const page = await shortCard();
    page.press(column(page));
    await page.fillAll();
    expect(page.at()).toBe(page.endTarget());
    await page.growAbove(500);
    expect(page.at()).toBe(page.endTarget());
  });

  it("keeps the reader's own scroll its event has yet to report", async () => {
    const page = await shortCard();
    page.press(column(page));
    // Applied with no scroll event yet: a fling, a caret revealed.
    window.scrollTo(0, page.at() + 30);
    await page.fillAll();
    expect(page.at()).toBe(page.endTarget() + 30);
  });

  it("keeps a reader at the end who pressed the comment box below the list", async () => {
    const page = await shortCard();
    page.press(page.view.getByRole("textbox", { name: "Write a comment" }));
    await page.fillAll();
    expect(page.unit("comment-1")?.hasAttribute("data-unfilled")).toBe(false);
    expect(page.at()).toBe(page.endTarget());
  });

  it("keeps a reader at the end who pressed the header over the screen's top", async () => {
    // The header precedes the list, its bottom the top overlays' edge.
    const page = await shortCard({ header: 60 });
    expect(page.at()).toBe(120);
    page.press(page.view.getByRole("button", { name: "Menu" }));
    await page.fillAll();
    expect(page.unit("comment-1")?.hasAttribute("data-unfilled")).toBe(false);
    expect(page.at()).toBe(page.endTarget());
  });

  it("leaves a reader at the end who pressed the body above the list to the browser", async () => {
    const page = await shortCard();
    const edit = page.view.getByRole("button", { name: "Edit" });
    const before = edit.getBoundingClientRect().top;
    page.press(edit);
    await page.fillAll();
    expect(page.unit("comment-1")?.hasAttribute("data-unfilled")).toBe(false);
    expect(edit.getBoundingClientRect().top).toBe(before);
  });

  it("keeps the body's editor put when the reader types after pressing it", async () => {
    const page = await shortCard();
    const edit = page.view.getByRole("button", { name: "Edit" });
    const before = edit.getBoundingClientRect().top;
    page.press(edit);
    fireEvent.keyDown(edit, { key: "a" });
    await page.fillAll();
    expect(page.unit("comment-1")?.hasAttribute("data-unfilled")).toBe(false);
    expect(edit.getBoundingClientRect().top).toBe(before);
  });

  it("lets go of the end when a key lands on the body", async () => {
    const page = await shortCard();
    const edit = page.view.getByRole("button", { name: "Edit" });
    const before = edit.getBoundingClientRect().top;
    page.press(column(page));
    // Typed in the body, the focus moved there by the keyboard.
    fireEvent.keyDown(edit, { key: "a" });
    await page.fillAll();
    expect(page.unit("comment-1")?.hasAttribute("data-unfilled")).toBe(false);
    expect(edit.getBoundingClientRect().top).toBe(before);
  });
});

describe("the head arriving under a landing on the end", () => {
  it("leaves the end held when the page grew above it in between", async () => {
    const page = await open({ holdHead: true, end: true, above: 1000 });
    expect(page.at()).toBe(page.endTarget());
    // An image above loads first, and the hold puts the page back.
    await page.growAbove(500);
    expect(page.at()).toBe(page.endTarget());
    await page.releaseHead();
    await page.view.findByText("body 10");
    await page.settle();
    expect(endHeldAt()).not.toBeNull();
    await page.growAbove(300);
    expect(page.at()).toBe(page.endTarget());
  });

  it("keeps the end through the reader's first scroll in the frame the head arrives", async () => {
    const page = await open({ holdHead: true, end: true, above: 1000 });
    expect(page.at()).toBe(page.endTarget());
    // The head commits, and the reader's wheel comes before the next frame.
    await page.releaseHead();
    await page.view.findByTestId("fold-block");
    page.wheel();
    await page.settle();
    expect(page.at()).toBe(page.endTarget());
  });
});
