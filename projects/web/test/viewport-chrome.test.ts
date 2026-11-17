import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  holdRevealed,
  landAtBottom,
  revealBlock,
  usableViewport,
  useScrollInsets,
} from "../src/lib/scroll-insets.ts";
import {
  useAutoHideHeader,
  useVisualViewportInsets,
  VIEWPORT_CHROME_EVENT,
  visualViewportInsets,
} from "../src/lib/viewport-chrome.ts";

const root = document.documentElement;

/** A visual viewport the tests can move, the way a keyboard or a pan does. */
function stubVisualViewport(state: {
  offsetTop: number;
  height: number;
  scale?: number;
}) {
  const vv = new EventTarget();
  Object.defineProperties(vv, {
    offsetTop: { get: () => state.offsetTop },
    height: { get: () => state.height },
    scale: { get: () => state.scale ?? 1 },
  });
  vi.stubGlobal("visualViewport", vv);
  return (next: Partial<typeof state>) => {
    Object.assign(state, next);
    vv.dispatchEvent(new Event("resize"));
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
  root.removeAttribute("style");
  root.removeAttribute("data-header-settling");
});

describe("visual viewport insets (T-585)", () => {
  beforeEach(() => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(714);
  });

  it("reads a keyboard as the layout viewport's covered bottom", () => {
    stubVisualViewport({ offsetTop: 0, height: 377 });
    expect(visualViewportInsets()).toEqual({ top: 0, bottom: 337 });
  });

  it("splits a panned keyboard page between the two edges", () => {
    stubVisualViewport({ offsetTop: 300, height: 377 });
    expect(visualViewportInsets()).toEqual({ top: 300, bottom: 37 });
  });

  it("leaves the edges where they are under a pinch zoom", () => {
    stubVisualViewport({ offsetTop: 120, height: 357, scale: 2 });
    expect(visualViewportInsets()).toEqual({ top: 0, bottom: 0 });
  });

  it("publishes both edges on <html> and follows the keyboard", () => {
    const move = stubVisualViewport({ offsetTop: 0, height: 714 });
    const view = render(
      createElement(() => {
        useVisualViewportInsets();
        return null;
      }),
    );
    expect(root.style.getPropertyValue("--vv-bottom")).toBe("0px");

    move({ height: 377 });
    expect(root.style.getPropertyValue("--vv-bottom")).toBe("337px");
    move({ offsetTop: 300 });
    expect(root.style.getPropertyValue("--vv-top")).toBe("300px");
    expect(root.style.getPropertyValue("--vv-bottom")).toBe("37px");

    view.unmount();
    expect(root.style.getPropertyValue("--vv-top")).toBe("");
  });
});

describe("auto-hiding header (T-585)", () => {
  const HEADER = 93;
  let y = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    y = 2000;
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => y);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(714);
    vi.spyOn(root, "scrollHeight", "get").mockReturnValue(5000);
    const header = document.createElement("header");
    Object.defineProperty(header, "offsetHeight", { value: HEADER });
    document.body.append(header);
  });
  // A click on an in-page link moves the fragment.
  afterEach(() => {
    location.hash = "";
  });

  function Probe({ enabled, page }: { enabled: boolean; page?: string }) {
    useAutoHideHeader(enabled, page);
    return null;
  }
  function mount(enabled = true) {
    return render(createElement(Probe, { enabled }));
  }
  const hidden = () => root.style.getPropertyValue("--header-hide");
  const scrollTo = (next: number) => {
    y = next;
    window.dispatchEvent(new Event("scroll"));
  };
  const touch = (type: "touchstart" | "touchmove" | "touchend") =>
    window.dispatchEvent(new Event(type));
  /** A finger drag just let go: its window still open, its settle pending. */
  const drag = (to: number) => {
    touch("touchstart");
    touch("touchmove");
    scrollTo(to);
    touch("touchend");
  };
  /** The reader slides the header out, lets go, and the window lapses. */
  const slideAway = () => {
    drag(2200);
    vi.advanceTimersByTime(700);
  };
  const tap = () => {
    touch("touchstart");
    touch("touchend");
  };
  const click = (el: Element) =>
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  const link = (href: string) => {
    const a = document.createElement("a");
    a.href = href;
    document.body.append(a);
    return a;
  };
  const press = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  /** A block whose `scrollIntoView` moves the page to `to`, as a jump does. */
  const block = (to: number, during: () => void = () => {}) => {
    const el = document.createElement("div");
    document.body.append(el);
    vi.spyOn(el, "scrollIntoView").mockImplementation(() => {
      during();
      y = to;
    });
    return el;
  };
  // Scrolls queue their events for the next frame, after the call.
  const scrolled = () => window.dispatchEvent(new Event("scroll"));

  it("slides away with the reader's scroll and back as they turn round", () => {
    mount();
    touch("touchstart");
    touch("touchmove");
    scrollTo(2030);
    expect(hidden()).toBe("30px");
    scrollTo(2200);
    // Never further than its own height.
    expect(hidden()).toBe(`${HEADER}px`);
    scrollTo(2180);
    expect(hidden()).toBe(`${HEADER - 20}px`);
  });

  it("stays put while the page places itself", () => {
    mount();
    // A landing or an anchor jump with no input behind it.
    scrollTo(3500);
    expect(hidden()).toBe("");
  });

  it("settles fully out once the finger lifts, never under it", () => {
    mount();
    touch("touchstart");
    touch("touchmove");
    scrollTo(2060);
    vi.advanceTimersByTime(500);
    // A pause is not a release.
    expect(hidden()).toBe("60px");

    touch("touchend");
    vi.advanceTimersByTime(200);
    expect(hidden()).toBe(`${HEADER}px`);
    expect(root.hasAttribute("data-header-settling")).toBe(true);
  });

  it("settles back in from less than half way", () => {
    mount();
    touch("touchstart");
    touch("touchmove");
    scrollTo(2030);
    touch("touchend");
    vi.advanceTimersByTime(200);
    expect(hidden()).toBe("0px");
  });

  it("cannot stay hidden over the top of the page", () => {
    y = 0;
    mount();
    touch("touchstart");
    touch("touchmove");
    scrollTo(60);
    expect(hidden()).toBe("60px");
    // More than half out, but what it would cover is the page's own start.
    touch("touchend");
    vi.advanceTimersByTime(200);
    expect(hidden()).toBe("0px");
  });

  it("ignores the bounce past either end", () => {
    mount();
    touch("touchstart");
    touch("touchmove");
    scrollTo(5000 - 714 + 40);
    expect(hidden()).toBe("");
  });

  it("does nothing where it is not enabled, and cleans up on the way out", () => {
    const off = mount(false);
    touch("touchstart");
    touch("touchmove");
    scrollTo(2100);
    expect(hidden()).toBe("");
    off.unmount();

    const on = mount();
    touch("touchstart");
    touch("touchmove");
    scrollTo(2150);
    expect(hidden()).not.toBe("");
    on.unmount();
    expect(hidden()).toBe("");
  });

  it("tells the page each time it moves, and only then", () => {
    mount();
    const heard = vi.fn();
    window.addEventListener(VIEWPORT_CHROME_EVENT, heard);
    touch("touchstart");
    touch("touchmove");
    scrollTo(2060);
    scrollTo(2200);
    expect(heard).toHaveBeenCalledTimes(2);
    // All the way out: scrolling on moves nothing.
    scrollTo(2300);
    scrollTo(2400);
    expect(heard).toHaveBeenCalledTimes(2);
    window.removeEventListener(VIEWPORT_CHROME_EVENT, heard);
  });

  describe("and the scroll insets", () => {
    function WithInsets() {
      useAutoHideHeader(true);
      useScrollInsets({});
      return null;
    }
    beforeEach(() => {
      // A sticky header slides by `--header-hide`: at once under a finger,
      // over the 150ms transition in styles.css while it settles.
      let from = 0;
      let to = 0;
      let since = 0;
      const slid = () =>
        from + (to - from) * Math.min(1, (Date.now() - since) / 150);
      const setProperty = root.style.setProperty.bind(root.style);
      vi.spyOn(root.style, "setProperty").mockImplementation(
        (name, value, priority) => {
          if (name === "--header-hide") {
            const next = Number.parseFloat(value ?? "0");
            from = root.hasAttribute("data-header-settling") ? slid() : next;
            to = next;
            since = Date.now();
          }
          setProperty(name, value, priority);
        },
      );
      const header = document.querySelector("header") as HTMLElement;
      vi.spyOn(header, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            top: -slid(),
            bottom: HEADER - slid(),
            height: HEADER,
          }) as DOMRect,
      );
      render(createElement(WithInsets));
      expect(root.style.scrollPaddingTop).toBe(`${8 + HEADER}px`);
    });

    it("follow the header once it has settled", () => {
      touch("touchstart");
      touch("touchmove");
      scrollTo(2060);
      touch("touchend");
      vi.advanceTimersByTime(120 + 170);
      expect(root.style.scrollPaddingTop).toBe("8px");
    });

    it("follow the header while the reader drags it", () => {
      touch("touchstart");
      touch("touchmove");
      scrollTo(2060);
      // One frame on, long before it would settle: a caret revealed now
      // has to clear the header where it stands.
      vi.advanceTimersByTime(16);
      expect(root.style.scrollPaddingTop).toBe(`${8 + HEADER - 60}px`);
      expect(usableViewport().top).toBe(8 + HEADER - 60);
    });
  });

  it("comes back in view on the next page (T-594)", () => {
    const view = render(createElement(Probe, { enabled: true, page: "/a" }));
    touch("touchstart");
    touch("touchmove");
    scrollTo(2150);
    expect(hidden()).toBe(`${HEADER}px`);
    view.rerender(createElement(Probe, { enabled: true, page: "/b" }));
    expect(hidden()).toBe("");
    // And still follows the reader there.
    touch("touchstart");
    touch("touchmove");
    scrollTo(2180);
    expect(hidden()).toBe("30px");
  });

  it("takes a tap for no scroll of the reader's", () => {
    mount();
    slideAway();
    expect(hidden()).toBe(`${HEADER}px`);
    // What follows a tap is a jump or a keyboard opening, not the reader.
    tap();
    scrollTo(900);
    expect(hidden()).toBe(`${HEADER}px`);
  });

  it("stays out of a link's jump near the top, and as sticky shows it", () => {
    mount();
    slideAway();
    tap();
    click(link("#top-comment"));
    scrollTo(50);
    vi.advanceTimersByTime(200);
    // Not settled back in by the tap's release; sticky leaves 50px out.
    expect(hidden()).toBe("50px");
  });

  it("follows the page keys, never typing", () => {
    mount();
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    press(field, "a");
    press(field, "ArrowDown");
    // The browser bringing the caret into view.
    scrollTo(2100);
    expect(hidden()).toBe("");

    press(document.body, "PageDown");
    scrollTo(2300);
    expect(hidden()).toBe(`${HEADER}px`);
  });

  it("follows a press on the page's scrollbar, never one on its content", () => {
    mount();
    const content = document.createElement("div");
    document.body.append(content);
    content.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    scrollTo(2100);
    expect(hidden()).toBe("");

    root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    scrollTo(2300);
    expect(hidden()).toBe(`${HEADER}px`);
  });

  it("shuts the reader's window on a click, until they scroll again", () => {
    mount();
    drag(2200);
    expect(hidden()).toBe(`${HEADER}px`);
    click(link("#comment-7"));
    // The browser jumping to the fragment.
    scrollTo(900);
    expect(hidden()).toBe(`${HEADER}px`);

    touch("touchstart");
    touch("touchmove");
    scrollTo(880);
    expect(hidden()).toBe(`${HEADER - 20}px`);
  });

  it.each([
    {
      landing: "up to a block",
      reader: () => drag(2200),
      land: () => {
        const target = block(900);
        revealBlock(target);
        return holdRevealed(target, document.body);
      },
      header: `${HEADER}px`,
    },
    {
      landing: "down to the end",
      reader: () => {
        vi.spyOn(root, "clientHeight", "get").mockReturnValue(714);
        vi.spyOn(window, "scrollTo").mockImplementation(
          (...args: unknown[]) => {
            y = Number(args[1]);
          },
        );
        press(document.body, "PageDown");
      },
      land: landAtBottom,
      header: "",
    },
  ])(
    "stays put for the app's own landing $landing",
    ({ reader, land, header }) => {
      mount();
      reader();
      expect(hidden()).toBe(header);
      const release = land();
      scrolled();
      expect(hidden()).toBe(header);
      release();
    },
  );

  it.each([
    { state: "half way", after: 0 },
    // Mid-transition the header's edge reads half way through its slide.
    { state: "settling", after: 130 },
  ])("puts a header $state in place before a landing measures", ({ after }) => {
    mount();
    let announced = false;
    const listen = () => {
      announced = true;
    };
    window.addEventListener(VIEWPORT_CHROME_EVENT, listen);
    touch("touchstart");
    touch("touchmove");
    scrollTo(2040);
    touch("touchend");
    vi.advanceTimersByTime(after);
    announced = false;

    let seen: { hidden: string; settling: boolean; announced: boolean } | null =
      null;
    const target = block(900, () => {
      seen = {
        hidden: hidden(),
        settling: root.hasAttribute("data-header-settling"),
        announced,
      };
    });
    revealBlock(target);
    // Less than half out, so in: the snap's own rule.
    expect(seen).toEqual({ hidden: "0px", settling: false, announced: true });

    scrolled();
    vi.advanceTimersByTime(200);
    expect(hidden()).toBe("0px");
    window.removeEventListener(VIEWPORT_CHROME_EVENT, listen);
  });
});
