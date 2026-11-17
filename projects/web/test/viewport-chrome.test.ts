import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usableViewport, useScrollInsets } from "../src/lib/scroll-insets.ts";
import {
  useAutoHideHeader,
  useVisualViewportInsets,
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
  const touch = (type: "touchstart" | "touchend") =>
    window.dispatchEvent(new Event(type));

  it("slides away with the reader's scroll and back as they turn round", () => {
    mount();
    touch("touchstart");
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
    scrollTo(2030);
    touch("touchend");
    vi.advanceTimersByTime(200);
    expect(hidden()).toBe("0px");
  });

  it("cannot stay hidden over the top of the page", () => {
    y = 0;
    mount();
    touch("touchstart");
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
    scrollTo(5000 - 714 + 40);
    expect(hidden()).toBe("");
  });

  it("does nothing where it is not enabled, and cleans up on the way out", () => {
    const off = mount(false);
    touch("touchstart");
    scrollTo(2100);
    expect(hidden()).toBe("");
    off.unmount();

    const on = mount();
    touch("touchstart");
    scrollTo(2150);
    expect(hidden()).not.toBe("");
    on.unmount();
    expect(hidden()).toBe("");
  });

  describe("and the scroll insets", () => {
    function WithInsets() {
      useAutoHideHeader(true);
      useScrollInsets({});
      return null;
    }
    beforeEach(() => {
      // A sticky header slides by `--header-hide`, at once here: no
      // transition runs in the test.
      const header = document.querySelector("header") as HTMLElement;
      vi.spyOn(header, "getBoundingClientRect").mockImplementation(() => {
        const slid = Number.parseFloat(hidden() || "0");
        return {
          top: -slid,
          bottom: HEADER - slid,
          height: HEADER,
        } as DOMRect;
      });
      render(createElement(WithInsets));
      expect(root.style.scrollPaddingTop).toBe(`${8 + HEADER}px`);
    });

    it("follow the header once it has settled", () => {
      touch("touchstart");
      scrollTo(2060);
      touch("touchend");
      vi.advanceTimersByTime(120 + 170);
      expect(root.style.scrollPaddingTop).toBe("8px");
    });

    it("follow the header while the reader drags it", () => {
      touch("touchstart");
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
    scrollTo(2150);
    expect(hidden()).toBe(`${HEADER}px`);
    view.rerender(createElement(Probe, { enabled: true, page: "/b" }));
    expect(hidden()).toBe("");
    // And still follows the reader there.
    touch("touchstart");
    scrollTo(2180);
    expect(hidden()).toBe("30px");
  });
});
