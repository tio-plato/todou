import { fireEvent, render } from "@testing-library/react";
import { createElement, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blockFor,
  holdRevealed,
  isHoldingTarget,
  landAtBottom,
  restingScrollY,
  revealBlock,
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
 * numbers in the markup instead of in a lookup table beside it, and `data-top`
 * moves an element off the top edge.
 */
function stubHeights() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const { h, top: y } = (this as HTMLElement).dataset ?? {};
      const height = Number(h ?? 0);
      const top = Number(y ?? 0);
      return {
        height,
        width: 0,
        top,
        left: 0,
        bottom: top + height,
      } as DOMRect;
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
    createElement(
      "div",
      { ref: bar, "data-h": "40", "data-top": "56" },
      createElement(
        "a",
        { href: "#", "data-h": "24", "data-top": "64" },
        "back",
      ),
    ),
    composer === "mounted"
      ? createElement(
          "div",
          {
            ref: composerRef,
            "data-h": "93",
            "data-top": String(window.innerHeight - 93),
          },
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

    // Leaving the window mid-press sends its pointerup somewhere else.
    fireEvent.pointerDown(quote, { pointerType: "mouse" });
    expect(insets().bottom).toBe("0px");
    fireEvent.blur(window);
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

/** The shell header at `top`, holding one button 16px below its top edge. */
function shellHeader(top = 0): HTMLButtonElement {
  const header = document.createElement("header");
  header.dataset.h = "57";
  header.dataset.top = String(top);
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.h = "24";
  button.dataset.top = String(top + 16);
  header.append(button);
  document.body.append(header);
  return button;
}

/** `window.scrollY`, moved only by the test and by `window.scrollTo`. */
function pagePosition(y: number): { y: number } {
  const page = { y };
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => page.y);
  vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
    const [first, second] = args;
    page.y =
      typeof first === "object" && first !== null
        ? ((first as ScrollToOptions).top ?? page.y)
        : Number(second);
  });
  return page;
}

describe("focus inside an overlay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const header of document.querySelectorAll("header")) header.remove();
  });

  it("leaves the control holding focus uncovered by the inset", () => {
    const button = shellHeader();
    stubHeights();
    const view = render(createElement(Harness, { composer: "mounted" }));
    const top = () => Number.parseFloat(insets().top);

    // WebKit reveals a newly focused control against the inset after
    // focusin, and both engines reveal the caret against it while typing: an
    // inset reaching over the control scrolls the page, and the sticky
    // overlay rides along, so nothing is ever revealed.
    button.focus();
    expect(top()).toBeLessThanOrEqual(16);
    view.getByText("back").focus();
    expect(top()).toBeLessThanOrEqual(64);
  });

  it("keeps the composer holding focus uncovered once scrolling pins it", () => {
    stubHeights();
    const view = render(createElement(Harness, { composer: "mounted" }));
    const draft = view.getByLabelText("draft");
    const composer = draft.parentElement as HTMLElement;

    // Focused where it sits in the page at its end, short of the bottom edge;
    // then the reader scrolls up and it pins there. Nothing re-measures on
    // scroll, and a caret behind the inset scrolls the page on every key.
    composer.dataset.top = String(window.innerHeight - 400);
    draft.focus();
    composer.dataset.top = String(window.innerHeight - 93);
    fireEvent.scroll(window);
    expect(Number.parseFloat(insets().bottom)).toBeLessThanOrEqual(0);
  });

  it("puts the page back when Tab's reveal moved it under a pinned control", () => {
    shellHeader();
    stubHeights();
    const view = render(createElement(Harness, { composer: "mounted" }));
    const page = pagePosition(1000);

    // Chromium reveals the new focus before its focus event, against the
    // inset of the moment the old one lost it, with every overlay counted.
    fireEvent.keyDown(window, { key: "Tab" });
    page.y = 554;
    view.getByText("back").focus();
    expect(page.y).toBe(1000);
  });

  it("keeps a reveal of a control outside every overlay", () => {
    shellHeader();
    stubHeights();
    const view = render(createElement(Harness, { composer: "mounted" }));
    const page = pagePosition(1000);

    // A comment link hidden behind the title bar is what the inset is for.
    fireEvent.keyDown(window, { key: "Tab" });
    page.y = 554;
    view.getByText("elsewhere").focus();
    expect(page.y).toBe(554);
  });

  it("forgets where a keystroke found the page once its task is over", async () => {
    shellHeader();
    stubHeights();
    const view = render(createElement(Harness, { composer: "mounted" }));
    const page = pagePosition(1000);

    // The reader scrolls away and clicks into an overlay much later: the old
    // position is no longer theirs to be put back to.
    fireEvent.keyDown(window, { key: "Tab" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    page.y = 554;
    view.getByText("back").focus();
    expect(page.y).toBe(554);
  });

  it("keeps a reveal that brought an overlay's control on screen", () => {
    // Slid away above the viewport, as the header does on a narrow screen
    // while the reader scrolls down: putting the page back would leave the
    // focused control out of sight.
    const button = shellHeader(-57);
    stubHeights();
    render(createElement(Harness, { composer: "mounted" }));
    const page = pagePosition(1000);

    fireEvent.keyDown(window, { key: "Tab" });
    page.y = 554;
    button.focus();
    expect(page.y).toBe(554);
  });

  it("lands targets clear of every overlay whatever holds focus", () => {
    shellHeader();
    stubHeights();
    const view = render(createElement(Harness, { composer: "mounted" }));
    view.getByText("back").focus();

    // A link or button in the title bar keeps focus while the landing it
    // asked for runs; the counter beside ↑↓ measures against the same strip.
    expect(usableViewport()).toEqual({
      top: 105,
      height: window.innerHeight - 105 - 93,
    });
  });

  it("reveals clear of every overlay and hands the inset back after", () => {
    shellHeader();
    stubHeights();
    const view = render(createElement(Harness, { composer: "mounted" }));
    view.getByText("back").focus();
    const during: string[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {
      during.push(insets().top);
    });
    const target = document.createElement("div");
    document.body.append(target);
    const before = insets();

    revealBlock(target, { flash: false });
    expect(during).toEqual(["105px"]);
    expect(insets()).toEqual(before);
    target.remove();
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
