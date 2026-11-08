import { fireEvent, render } from "@testing-library/react";
import { createElement, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  atConversationEnd,
  blockFor,
  holdRevealed,
  isHoldingTarget,
  landAtBottom,
  restingScrollY,
  usableViewport,
  useScrollInsets,
} from "../src/lib/scroll-insets.ts";
import { currentIndex } from "../src/lib/spec-change-nav.ts";
import { FakeResizeObserver, resizePage } from "./fake-resize-observer.ts";

// The overlays measured on a 1280×800 screen: shell header 57, floating title
// bar 40, comment composer 93 collapsed — 129, 167 and 385 as a draft grows.
const USABLE = { top: 97, height: 610 };

const CASES: [
  label: string,
  block: { top: number; height: number },
  mode: "auto" | "start" | undefined,
  block_: ScrollLogicalPosition,
  resting: number,
][] = [
  // Centre of the block (1000 + 40) onto centre of the strip (97 + 305).
  [
    "a block shorter than the strip",
    { top: 1000, height: 80 },
    "auto",
    "center",
    638,
  ],
  // Exactly as tall as the strip still centres — `<=`, so the one block that
  // fills the strip perfectly is not thrown to the other branch.
  [
    "a block exactly as tall as the strip",
    { top: 1000, height: 610 },
    "auto",
    "center",
    903,
  ],
  // Top of the block onto top of the strip: 1000 − 97.
  [
    "a block taller than the strip",
    { top: 1000, height: 611 },
    "auto",
    "start",
    903,
  ],
  [
    "a tall block under an explicit start",
    { top: 1000, height: 80 },
    "start",
    "start",
    903,
  ],
  ["no mode given at all", { top: 1000, height: 80 }, undefined, "center", 638],
];

describe("reveal geometry (T-299)", () => {
  for (const [label, block, mode, expectedBlock, resting] of CASES) {
    it(`lands ${label}`, () => {
      expect(blockFor(block, USABLE, mode)).toBe(expectedBlock);
      expect(restingScrollY(block, USABLE, mode)).toBe(resting);
    });
  }

  it.each([0, -120])(
    "tops-aligns rather than centring when the overlays leave %d px",
    (height) => {
      const usable = { top: 97, height };
      const block = { top: 1000, height: 80 };
      expect(blockFor(block, usable)).toBe("start");
      expect(restingScrollY(block, usable)).toBe(903);
    },
  );
});

describe("the landing and the counter agree (T-299)", () => {
  // One taller than the strip, so both branches of the mode are in play.
  const BLOCKS = [
    { top: 200, height: 90 },
    { top: 600, height: 1400 },
    { top: 2400, height: 120 },
    { top: 3000, height: 300 },
  ];

  it("names the stop it just landed on", () => {
    const positions = BLOCKS.map((b) => restingScrollY(b, USABLE));
    // Ascending, or ↑↓ would step in the wrong direction: the top-aligned
    // tall block rests above where the next block can come to rest.
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const [i, pivot] of positions.entries()) {
      expect(currentIndex({ positions, pivot })).toBe(i + 1);
    }
  });
});

describe("usableViewport (T-299)", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("scroll-padding-top");
    document.documentElement.style.removeProperty("scroll-padding-bottom");
  });

  it("reads the strip back off <html>", () => {
    document.documentElement.style.scrollPaddingTop = "97px";
    document.documentElement.style.scrollPaddingBottom = "129px";
    expect(usableViewport()).toEqual({
      top: 97,
      height: window.innerHeight - 226,
    });
  });

  it("treats an unset scroll-padding as no overlay", () => {
    expect(usableViewport()).toEqual({
      top: 0,
      height: window.innerHeight,
    });
  });
});

/**
 * happy-dom answers 0 from every `getBoundingClientRect()`, so heights only
 * reach the hook when the element carries one. `data-h` puts each test's
 * numbers in the markup instead of in a lookup table beside it.
 */
function stubHeights() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const height = Number((this as HTMLElement).dataset?.h ?? 0);
      return { height, width: 0, top: 0, left: 0, bottom: height } as DOMRect;
    },
  );
}

function Harness({ composer }: { composer: "mounted" | "absent" }) {
  const bar = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  useScrollInsets({ top: [bar], bottom: [composerRef] });
  return createElement(
    "div",
    null,
    createElement("div", { ref: bar, "data-h": "40" }),
    composer === "mounted"
      ? createElement(
          "div",
          { ref: composerRef, "data-h": "93" },
          createElement("textarea", { "aria-label": "draft" }),
          createElement("div", null, "quoted line"),
        )
      : null,
    createElement("button", { type: "button" }, "elsewhere"),
  );
}

const insets = () => ({
  top: document.documentElement.style.scrollPaddingTop,
  bottom: document.documentElement.style.scrollPaddingBottom,
});

describe("useScrollInsets (T-299)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const header of document.querySelectorAll("header")) header.remove();
  });

  it("sums the shell header, the page's own overlays and a breathing gap", () => {
    const header = document.createElement("header");
    header.dataset.h = "57";
    document.body.append(header);
    stubHeights();

    const view = render(createElement(Harness, { composer: "mounted" }));
    expect(insets()).toEqual({ top: "105px", bottom: "93px" });

    view.unmount();
    expect(insets()).toEqual({ top: "", bottom: "" });
  });

  it("keeps reveals clear of an on-screen keyboard (T-585)", () => {
    stubHeights();
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(714);
    // The keyboard is up and the page has been panned 100px down the layout
    // viewport: the top 100 and the bottom 237 are both out of sight.
    const vv = new EventTarget();
    Object.defineProperties(vv, {
      offsetTop: { value: 100 },
      height: { value: 377 },
      scale: { value: 1 },
    });
    vi.stubGlobal("visualViewport", vv);
    render(createElement(Harness, { composer: "mounted" }));
    expect(insets()).toEqual({ top: "148px", bottom: "330px" });
  });

  it("counts a ref pointing at nothing as no overlay", () => {
    stubHeights();
    // A trashed card renders no composer at all, and a fallback height would
    // reserve a strip for an overlay that is not there.
    render(createElement(Harness, { composer: "absent" }));
    expect(insets()).toEqual({ top: "48px", bottom: "0px" });
  });

  it("drops an overlay's inset while focus is inside it (T-519)", () => {
    stubHeights();
    const view = render(createElement(Harness, { composer: "mounted" }));
    expect(insets()).toEqual({ top: "48px", bottom: "93px" });

    // The caret lives inside the sticky composer, so it always sits in the
    // composer's own inset: Chrome's caret reveal scrolled on every keystroke.
    view.getByLabelText("draft").focus();
    expect(insets()).toEqual({ top: "48px", bottom: "0px" });

    view.getByText("elsewhere").focus();
    expect(insets()).toEqual({ top: "48px", bottom: "93px" });
  });

  it("drops an overlay's inset while a mouse press that began inside it lasts", () => {
    stubHeights();
    const view = render(createElement(Harness, { composer: "mounted" }));
    view.getByLabelText("draft").focus();
    const quote = view.getByText("quoted line");

    // Every engine's drag-select autoscroll honours scroll-padding, and a
    // press on the composer's own text takes focus out of it: the pointer sat
    // in the composer's inset and the page scrolled to its end.
    fireEvent.pointerDown(quote, { pointerType: "mouse" });
    view.getByText("elsewhere").focus();
    expect(insets().bottom).toBe("0px");

    fireEvent.pointerUp(quote, { pointerType: "mouse" });
    expect(insets().bottom).toBe("93px");

    // A press outside every overlay leaves them all counted: a drag from the
    // page down onto the composer is what the inset is there to scroll.
    const outside = view.getByText("elsewhere");
    fireEvent.pointerDown(outside, { pointerType: "mouse" });
    expect(insets()).toEqual({ top: "48px", bottom: "93px" });
    fireEvent.pointerUp(outside, { pointerType: "mouse" });

    // Dragging a selection starts a drag and drop instead, and Chromium and
    // Firefox end the press with a pointercancel.
    fireEvent.pointerDown(quote, { pointerType: "mouse" });
    expect(insets().bottom).toBe("0px");
    fireEvent.pointerCancel(quote, { pointerType: "mouse" });
    expect(insets().bottom).toBe("93px");

    // iOS drags a selection handle with one touch pointerdown and never ends
    // it: a finger would leave the inset at 0 until the next press.
    fireEvent.pointerDown(quote, { pointerType: "touch" });
    expect(insets().bottom).toBe("93px");

    // A right-click's menu may keep the pointerup from the page.
    fireEvent.pointerDown(quote, { pointerType: "mouse", button: 2 });
    expect(insets().bottom).toBe("93px");
  });
});

describe("one hold per page (T-527)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeResizeObserver.instances = [];
    document.body.replaceChildren();
  });

  function target(id: string) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
    return el;
  }

  it("retires the older landing when a newer one is held", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const reveals: string[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
      this: Element,
    ) {
      reveals.push(this.id);
    });
    const bottoms = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const releaseAnchor = holdRevealed(target("anchor"), document.body);
    expect(isHoldingTarget()).toBe(true);
    const releaseEnd = landAtBottom();
    // The end is not a target an arriving item would be yanked off.
    expect(isHoldingTarget()).toBe(false);
    resizePage();
    expect(reveals).toEqual([]);
    expect(bottoms).toHaveBeenCalledTimes(2);
    // The stale release must not drop the newer hold on its way out.
    releaseAnchor();
    resizePage();
    expect(bottoms).toHaveBeenCalledTimes(3);
    releaseEnd();
    resizePage();
    expect(bottoms).toHaveBeenCalledTimes(3);
  });

  it("lets go of a target that has left the document", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const reveal = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    const el = target("gone");
    holdRevealed(el, document.body);
    el.remove();
    resizePage();
    expect(reveal).not.toHaveBeenCalled();
    expect(isHoldingTarget()).toBe(false);
  });
});

function EndHarness() {
  const end = useRef<HTMLDivElement>(null);
  useScrollInsets({ end });
  return createElement("div", { ref: end, "data-end": "" });
}

/**
 * The bottom of the conversation, not of the document: on a phone the sidebar
 * follows the comment box, and a landing at the document's end buried the box
 * under it.
 */
describe("landing on the end of the conversation", () => {
  const VIEWPORT = 800;
  const HEIGHT = 5000;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeResizeObserver.instances = [];
    document.documentElement.style.removeProperty("scroll-padding-top");
  });

  /**
   * A page whose declared end sits at `end.y`; returns every scroll target,
   * `moveTo` for a scroll no landing made, and `setHeight` for the page
   * growing.
   */
  function page(end: { y: number }) {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const scroll = { y: 0, height: HEIGHT };
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(VIEWPORT);
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => scroll.y);
    vi.spyOn(
      document.documentElement,
      "scrollHeight",
      "get",
    ).mockImplementation(() => scroll.height);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
      VIEWPORT,
    );
    const targets: number[] = [];
    vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
      scroll.y = Number(args[1]);
      targets.push(scroll.y);
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const bottom =
          (this as HTMLElement).dataset?.end === "" ? end.y - scroll.y : 0;
        return { top: 0, bottom, height: 0, width: 0, left: 0 } as DOMRect;
      },
    );
    render(createElement(EndHarness));
    return {
      targets,
      moveTo: (y: number) => {
        scroll.y = y;
      },
      setHeight: (height: number) => {
        scroll.height = height;
      },
    };
  }

  it("puts the declared end on the viewport's bottom, again as the page grows", () => {
    const end = { y: 2000 };
    const { targets } = page(end);
    landAtBottom();
    expect(targets).toEqual([2000 - VIEWPORT]);
    end.y = 2600;
    resizePage();
    expect(targets).toEqual([2000 - VIEWPORT, 2600 - VIEWPORT]);
  });

  /**
   * A keyboard 300 high, with the page pushed 100 down the layout viewport.
   * Chromium and Firefox measure client coordinates from the layout
   * viewport, Safari on iOS from the visual one, whose page offset is then
   * the window's own, as measured on a real iPhone.
   *
   * `"lagging"` is that iPhone right after the page scrolled itself with the
   * keyboard up: `scrollY` and client rects move at once, while `pageTop`
   * keeps the offset from before the landing until the visual viewport next
   * updates, a frame or two later.
   */
  function keyboard(origin: "layout" | "visual" | "lagging") {
    const vv = new EventTarget();
    Object.defineProperties(vv, {
      offsetTop: { value: 100 },
      height: { value: VIEWPORT - 300 - 100 },
      scale: { value: 1 },
      pageTop: {
        get: () =>
          origin === "lagging"
            ? 0
            : window.scrollY + (origin === "layout" ? 100 : 0),
      },
    });
    vi.stubGlobal("visualViewport", vv);
  }

  it("puts it above an on-screen keyboard", () => {
    keyboard("layout");
    const { targets } = page({ y: 2000 });
    landAtBottom();
    // The keyboard's top edge, 100 + 400 down the layout viewport.
    expect(targets).toEqual([2000 - 500]);
  });

  it("puts it above an on-screen keyboard where client coordinates start at the visual viewport", () => {
    keyboard("visual");
    const { targets } = page({ y: 2000 });
    landAtBottom();
    // The keyboard's top edge, 400 down the visual viewport.
    expect(targets).toEqual([2000 - 400]);
  });

  it("stays above the keyboard while iOS has yet to catch up with its own landing", () => {
    keyboard("lagging");
    const { targets } = page({ y: 2000 });
    landAtBottom();
    // The hold's next placement, before the visual viewport has updated.
    resizePage();
    // Both on the keyboard's top edge, 400 down the visual viewport.
    expect(targets).toEqual([2000 - 400, 2000 - 400]);
  });

  it.each([
    // Past the largest offset iOS shows a blank frame (T-585).
    ["past the document's end", 6000, HEIGHT - VIEWPORT],
    ["within the first screen", 300, 0],
  ])("stays within the page for an end %s", (_, y, landed) => {
    const { targets } = page({ y });
    landAtBottom();
    expect(targets).toEqual([landed]);
  });

  it("keeps holding through the scroll its own placement made", () => {
    const { targets } = page({ y: 2000 });
    landAtBottom();
    fireEvent.scroll(window);
    resizePage();
    expect(targets).toEqual([2000 - VIEWPORT, 2000 - VIEWPORT]);
  });

  it("keeps holding through a scroll that comes after the page grew and before it is put back", () => {
    const end = { y: 2000 };
    const { targets } = page(end);
    landAtBottom();
    // The end has moved away, and the page has not: nothing moved it.
    end.y = 2600;
    fireEvent.scroll(window);
    resizePage();
    expect(targets).toEqual([2000 - VIEWPORT, 2600 - VIEWPORT]);
  });

  it("keeps holding through the scroll of a placement after the page grew again", () => {
    const end = { y: 2000 };
    const { targets } = page(end);
    landAtBottom();
    end.y = 2600;
    resizePage();
    // Grown again before the scroll of that placement comes.
    end.y = 3200;
    fireEvent.scroll(window);
    resizePage();
    expect(targets).toEqual([
      2000 - VIEWPORT,
      2600 - VIEWPORT,
      3200 - VIEWPORT,
    ]);
  });

  it("keeps holding through scroll anchoring, which moves the page with its target", () => {
    const end = { y: 2000 };
    const { targets, moveTo } = page(end);
    landAtBottom();
    // Something above grows by 300, and the page moves with what is on screen.
    end.y = 2300;
    moveTo(2300 - VIEWPORT);
    fireEvent.scroll(window);
    resizePage();
    expect(targets).toEqual([2000 - VIEWPORT, 2300 - VIEWPORT]);
  });

  it("keeps holding through anchoring on what grew above, as more grows below", () => {
    const end = { y: 2000 };
    const { targets, moveTo, setHeight } = page(end);
    landAtBottom();
    // 300 above what is on screen, which anchoring moves the page by, and
    // 200 below it, before the end.
    end.y = 2500;
    setHeight(HEIGHT + 500);
    moveTo(2000 - VIEWPORT + 300);
    fireEvent.scroll(window);
    resizePage();
    expect(targets).toEqual([2000 - VIEWPORT, 2500 - VIEWPORT]);
  });

  // iOS scrolling to the top at a tap on the status bar while an image is
  // still loading.
  it("lets go of a landing moved off with no input while the page grows", () => {
    const end = { y: 2000 };
    const { targets, moveTo, setHeight } = page(end);
    landAtBottom();
    end.y = 2300;
    setHeight(HEIGHT + 300);
    moveTo(0);
    fireEvent.scroll(window);
    resizePage();
    expect(targets).toEqual([2000 - VIEWPORT]);
  });

  it("lets go of a landing moved off with no input once it has put the page back on a taller one", () => {
    const end = { y: 2000 };
    const { targets, moveTo, setHeight } = page(end);
    landAtBottom();
    end.y = 2600;
    setHeight(HEIGHT + 600);
    resizePage();
    moveTo(0);
    fireEvent.scroll(window);
    resizePage();
    expect(targets).toEqual([2000 - VIEWPORT, 2600 - VIEWPORT]);
  });

  describe("atConversationEnd", () => {
    // The end at 2000 lands the page at 2000 - VIEWPORT.
    it.each([
      [true, "where a landing on the bottom puts them", 2000 - VIEWPORT],
      [true, "a line or two above that", 2000 - VIEWPORT - 30],
      [false, "reading the last screen", 2000 - VIEWPORT - 300],
      [true, "past it, the end still on screen", 1500],
      [false, "past it, the end under the top overlays", 1950],
    ])("answers %s for a reader %s", (expected, _, y) => {
      const { moveTo } = page({ y: 2000 });
      document.documentElement.style.scrollPaddingTop = "100px";
      moveTo(y);
      expect(atConversationEnd()).toBe(expected);
    });
  });
});
