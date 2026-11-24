import { fireEvent, render } from "@testing-library/react";
import { createElement, useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  atConversationEnd,
  blockFor,
  GLIDE_END_EVENT,
  holdRevealed,
  isGliding,
  isHoldingTarget,
  landAtBottom,
  type ReadingPlace,
  restingScrollY,
  revealAboveEnd,
  revealBlock,
  usableViewport,
  useReadingList,
  useScrollInsets,
} from "../src/lib/scroll-insets.ts";
import { currentIndex } from "../src/lib/spec-change-nav.ts";
import {
  useAutoHideHeader,
  VIEWPORT_CHROME_EVENT,
} from "../src/lib/viewport-chrome.ts";
import {
  FakeResizeObserver,
  resizeElement,
  resizePage,
} from "./fake-resize-observer.ts";
import { stubVisualViewport } from "./visual-viewport.ts";

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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  // The keyboard is up and the page panned 100px down the layout viewport:
  // the strip is the visual viewport's 377 less both overlays, wherever the
  // engine starts its client coordinates.
  it.each([
    ["iOS WebKit, at the visual viewport's top", 2000, 48],
    ["CSSOM View, at the layout viewport's top", 2100, 148],
    // The page has just scrolled itself up from 2150: iOS moves `scrollY` and
    // client rects at once, but `pageTop` only at the visual viewport's next
    // update, as measured on a real iPhone with the keyboard up.
    ["iOS WebKit, before pageTop catches up with the page's scroll", 2150, 48],
  ])(
    "measures the strip inside the visual viewport, from where the engine puts client coordinates: %s",
    (_engine, pageTop, top) => {
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(714);
      vi.spyOn(window, "scrollY", "get").mockReturnValue(2000);
      stubVisualViewport({ offsetTop: 100, height: 377, pageTop });
      document.documentElement.style.scrollPaddingTop = "48px";
      document.documentElement.style.scrollPaddingBottom = "93px";
      expect(usableViewport()).toEqual({ top, height: 236 });
    },
  );
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
    document.documentElement.style.removeProperty("--header-hide");
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

  it("leaves the keyboard and a panned page out of the padding", () => {
    // The keyboard is up and the page has been panned 100px down the layout
    // viewport. The engine resolves the padding against the visual viewport,
    // which already ends at the keyboard; counting the pan as well lands each
    // caret reveal past the caret, and iOS reveals it on every keystroke.
    // The header rides the visual viewport's top, which client coordinates
    // put 100px down where they start at the layout viewport's top.
    const header = document.createElement("header");
    header.dataset.h = "57";
    header.dataset.top = "100";
    document.body.append(header);
    stubHeights();
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(714);
    stubVisualViewport({ offsetTop: 100, height: 377 });
    render(createElement(Harness, { composer: "mounted" }));
    expect(insets()).toEqual({ top: "105px", bottom: "93px" });
  });

  it("counts only what still shows of a header slid partly away (T-594)", () => {
    const header = document.createElement("header");
    header.dataset.h = "57";
    document.body.append(header);
    stubHeights();
    render(createElement(Harness, { composer: "mounted" }));
    expect(insets().top).toBe("105px");

    // The header settles 40px out of view and announces it.
    header.dataset.top = "-40";
    document.documentElement.style.setProperty("--header-hide", "40px");
    window.dispatchEvent(new Event(VIEWPORT_CHROME_EVENT));
    expect(insets().top).toBe("65px");
  });

  it("counts a ref pointing at nothing as no overlay", () => {
    stubHeights();
    // A trashed card renders no composer at all, and a fallback height would
    // reserve a strip for an overlay that is not there.
    render(createElement(Harness, { composer: "absent" }));
    expect(insets()).toEqual({ top: "48px", bottom: "0px" });
  });

  it("lands clear of an overlay while a link in it holds focus", () => {
    stubHeights();
    const view = render(createElement(Harness, { composer: "mounted" }));
    // A clicked link keeps focus, and one that lands the page elsewhere from
    // a bar dropped out of the landing brings its target up under the bar.
    const bar = view.container.querySelector('[data-h="40"]');
    if (bar === null) throw new Error("the harness has no top bar");
    const link = document.createElement("a");
    link.href = "#elsewhere";
    link.textContent = "jump";
    bar.append(link);
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(usableViewport()).toEqual({
      top: 48,
      height: window.innerHeight - 48 - 93,
    });
  });

  it("drops an overlay's inset while an editable region in it holds focus", () => {
    stubHeights();
    const view = render(createElement(Harness, { composer: "mounted" }));
    // What the composer's editor actually is: CodeMirror's contenteditable,
    // not a textarea.
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    view.getByLabelText("draft").after(editor);
    editor.focus();
    expect(document.activeElement).toBe(editor);
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

  it("keeps a reveal that brought a control below the screen into sight", () => {
    stubHeights();
    const view = render(createElement(Harness, { composer: "mounted" }));
    const draft = view.getByLabelText("draft");
    const page = pagePosition(1000);

    // A composer sitting in the page further down, not pinned to the bottom:
    // put back, the page would leave its control below the screen.
    draft.dataset.top = String(window.innerHeight + 220);
    draft.dataset.h = "40";
    fireEvent.keyDown(window, { key: "Tab" });
    page.y = 1400;
    draft.focus();
    expect(page.y).toBe(1400);
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
    const during: { top: string; bottom: string }[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {
      during.push(insets());
    });
    const target = document.createElement("div");
    document.body.append(target);

    // Focus in the title bar, then in the composer: each lets go of its own
    // edge, and the landing still clears both.
    for (const holder of [
      view.getByText("back"),
      view.getByLabelText("draft"),
    ]) {
      holder.focus();
      const before = insets();
      revealBlock(target, { flash: false });
      expect(during.pop()).toEqual({ top: "105px", bottom: "93px" });
      expect(insets()).toEqual(before);
    }
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

function EndHarness() {
  const end = useRef<HTMLDivElement>(null);
  // The overlays pinned to the top, with the breathing gap 100px, a round
  // number for the landings below.
  const bar = useRef<HTMLDivElement>(null);
  useScrollInsets({ top: [bar], end });
  return createElement(
    "div",
    null,
    createElement("div", { ref: bar, "data-h": "92" }),
    createElement("div", { ref: end, "data-end": "" }),
  );
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
    for (const el of document.querySelectorAll("[data-top]")) el.remove();
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
        const { dataset } = this as HTMLElement;
        const bottom = dataset?.end === "" ? end.y - scroll.y : 0;
        const top =
          dataset?.top === undefined ? 0 : Number(dataset.top) - scroll.y;
        const height = Number(dataset?.h ?? 0);
        return { top, bottom, height, width: 0, left: 0 } as DOMRect;
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

  /** An item at page coordinate `y`. */
  function item(y: number) {
    const el = document.createElement("div");
    el.dataset.top = String(y);
    document.body.append(el);
    return el;
  }

  // New messages' landing on the first new item.
  it("puts an item under the top overlays when enough of the page follows it", () => {
    const { targets } = page({ y: 2000 });
    const el = item(500);
    revealAboveEnd(el);
    expect(targets).toEqual([500 - 100]);
    expect(el.classList.contains("anchor-flash")).toBe(true);
  });

  it("holds an item it put under the overlays there as the page grows", () => {
    const end = { y: 2000 };
    const { targets } = page(end);
    revealAboveEnd(item(500));
    expect(isHoldingTarget()).toBe(true);
    end.y = 2600;
    resizePage();
    expect(targets).toEqual([
      500 - usableViewport().top,
      500 - usableViewport().top,
    ]);
  });

  it("stops at the end while too little follows the item, and lets it rise as more loads", () => {
    const end = { y: 2000 };
    const { targets } = page(end);
    const el = item(1500);
    revealAboveEnd(el);
    expect(targets).toEqual([2000 - VIEWPORT]);
    expect(el.classList.contains("anchor-flash")).toBe(true);
    // A landing on the end for now: what arrives meanwhile is followed.
    expect(isHoldingTarget()).toBe(false);
    // Images below it load, and there is room for it to go all the way up.
    end.y = 2600;
    resizePage();
    expect(targets).toEqual([2000 - VIEWPORT, 1500 - usableViewport().top]);
    expect(isHoldingTarget()).toBe(true);
  });

  // iOS scrolling to the top at a tap on the status bar, find in page
  // scrolling to a match: neither sends an input a hold hears.
  it("lets go of New messages' landing once the page is moved off it with no input", () => {
    const { targets, moveTo } = page({ y: 2000 });
    revealAboveEnd(item(500));
    moveTo(0);
    fireEvent.scroll(window);
    resizePage();
    expect(targets).toEqual([500 - usableViewport().top]);
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

  it("keeps holding an item above what grew, as the page moves by just what it grew", () => {
    const end = { y: 2000 };
    const { targets, moveTo, setHeight } = page(end);
    revealAboveEnd(item(500));
    const placed = 500 - usableViewport().top;
    // An image below the item loads, and scroll anchoring on the comment
    // box below moves the page down with the box, away from the item.
    end.y = 2300;
    setHeight(HEIGHT + 300);
    moveTo(placed + 300);
    fireEvent.scroll(window);
    resizePage();
    expect(targets).toEqual([placed, placed]);
  });

  it("keeps holding through anchoring after it has put the page back on a taller one", () => {
    const end = { y: 2000 };
    const { targets, moveTo, setHeight } = page(end);
    revealAboveEnd(item(500));
    const placed = 500 - usableViewport().top;
    end.y = 2600;
    setHeight(HEIGHT + 600);
    resizePage();
    // Shrunk by 300 below the item, the page moving up with the comment box.
    end.y = 2300;
    setHeight(HEIGHT + 300);
    moveTo(placed - 300);
    fireEvent.scroll(window);
    resizePage();
    expect(targets).toEqual([placed, placed, placed]);
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

  /**
   * A landing asked to glide, frame by frame. `now` is the clock the glide
   * reads; each frame advances it, runs the frame's callback and the
   * placement made once the frame is drawn, then delivers the scroll that
   * made, as the browser does at the start of the next frame.
   */
  describe("gliding to its stop (T-211)", () => {
    let now = 0;

    function glide() {
      vi.useFakeTimers({
        toFake: [
          "requestAnimationFrame",
          "cancelAnimationFrame",
          "setTimeout",
          "clearTimeout",
        ],
      });
      now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
    }

    function frames(count: number, ms = 16) {
      for (let i = 0; i < count; i++) {
        now += ms;
        // The frame's callback, then the placement once it is drawn.
        vi.advanceTimersToNextTimer();
        vi.advanceTimersToNextTimer();
        fireEvent.scroll(window);
      }
    }

    function reducedMotion(reduce: boolean) {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: reduce && query === "(prefers-reduced-motion: reduce)",
      }));
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("comes closer every frame and stops where landing at once would, then holds it", () => {
      glide();
      const end = { y: 4000 };
      const { targets } = page(end);
      landAtBottom({ glide: true });
      // Nothing moves before the first frame.
      expect(targets).toEqual([]);
      frames(40);
      const stop = 4000 - VIEWPORT;
      expect(targets.length).toBeGreaterThan(5);
      for (let i = 1; i < targets.length; i++)
        expect(targets[i]).toBeGreaterThan(targets[i - 1]);
      expect(targets[0]).toBeGreaterThan(0);
      expect(targets.at(-1)).toBe(stop);
      // Not let go by its own frames' scrolls: the page growing is followed.
      end.y = 4400;
      resizePage();
      expect(targets.at(-1)).toBe(4400 - VIEWPORT);
      expect(isGliding()).toBe(false);
    });

    it("lands at once for a reader who asked for less motion", () => {
      glide();
      reducedMotion(true);
      const { targets } = page({ y: 4000 });
      landAtBottom({ glide: true });
      expect(targets).toEqual([4000 - VIEWPORT]);
    });

    it("carries the path along when the page grows above the stop, and still stops on it", () => {
      glide();
      const end = { y: 4000 };
      const { targets, setHeight } = page(end);
      landAtBottom({ glide: true });
      frames(3);
      const before = targets.at(-1) ?? 0;
      // 400 grows above the end before the next frame.
      end.y = 4400;
      setHeight(HEIGHT + 400);
      resizePage();
      // On the path, moved with the stop, not on the stop.
      expect(targets.at(-1)).toBe(before + 400);
      expect(targets.at(-1)).toBeLessThan(4400 - VIEWPORT);
      frames(40);
      expect(targets.at(-1)).toBe(4400 - VIEWPORT);
    });

    it.each([
      ["between two frames", 0],
      ["between a frame and the placement after it", 1],
    ])("stops where it got to at the reader's input %s", (_, callbacks) => {
      glide();
      const end = { y: 4000 };
      const { targets } = page(end);
      const ended = vi.fn();
      window.addEventListener(GLIDE_END_EVENT, ended);
      landAtBottom({ glide: true });
      frames(3);
      // The next frame's callback has run, its placement still to come.
      for (let i = 0; i < callbacks; i++) {
        now += 16;
        vi.advanceTimersToNextTimer();
      }
      const placed = [...targets];
      fireEvent.wheel(window);
      frames(40);
      end.y = 4400;
      resizePage();
      expect(targets).toEqual(placed);
      expect(placed.at(-1)).toBeLessThan(4000 - VIEWPORT);
      expect(ended).toHaveBeenCalledTimes(1);
      expect(isGliding()).toBe(false);
      window.removeEventListener(GLIDE_END_EVENT, ended);
    });

    // The observer's report as it starts observing comes in the first frame,
    // after the frame's callback and before the placement after it: placed
    // there, iOS can draw the sticky header a frame late.
    it("puts nothing in the frame at the observer's first report, the page not grown", () => {
      glide();
      const { targets } = page({ y: 4000 });
      landAtBottom({ glide: true });
      now += 16;
      vi.advanceTimersToNextTimer();
      resizePage();
      expect(targets).toEqual([]);
      vi.advanceTimersToNextTimer();
      expect(targets).toHaveLength(1);
    });

    it("goes straight to the stop at a frame later than the whole glide", () => {
      glide();
      const { targets } = page({ y: 4000 });
      landAtBottom({ glide: true });
      frames(2);
      // A second's long task holds the next frame back.
      frames(1, 1000);
      expect(targets).toHaveLength(3);
      expect(targets.at(-1)).toBe(4000 - VIEWPORT);
      expect(isGliding()).toBe(false);
      frames(10);
      expect(targets).toHaveLength(3);
    });
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
      moveTo(y);
      expect(atConversationEnd()).toBe(expected);
    });
  });
});

describe("the reader's place", () => {
  const VIEWPORT = 800;
  const ROW = 100;
  const KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"];

  /**
   * The first unit still showing, or the one a click landed in, and those
   * after it to fall back on.
   */
  function firstShowing(
    list: HTMLElement,
    clicked?: Element,
  ): ReadingPlace | null {
    const units = [...list.children];
    const at =
      clicked === undefined
        ? units.findIndex((u) => u.getBoundingClientRect().bottom > 0)
        : units.findIndex((u) => u.contains(clicked));
    const place = (el: Element) => ({
      key: el.getAttribute("data-unit") ?? "",
      top: el.getBoundingClientRect().top,
    });
    const unit = units[at];
    if (unit === undefined) return null;
    return { ...place(unit), after: units.slice(at + 1).map(place) };
  }

  /** A landing made as the page mounts, ahead of the list's own effect. */
  function Landing() {
    useLayoutEffect(() => {
      releases.push(landAtBottom());
    }, []);
    return null;
  }

  function ReadingList({
    keys,
    header,
    landFirst,
  }: {
    keys: string[];
    header: boolean;
    landFirst: boolean;
  }) {
    const list = useRef<HTMLDivElement>(null);
    useAutoHideHeader(header);
    useReadingList(list, firstShowing, (el, key) =>
      el.querySelector<HTMLElement>(`[data-unit="${key}"]`),
    );
    return createElement(
      "div",
      { ref: list },
      ...keys.map((key) => createElement("div", { key, "data-unit": key })),
      landFirst ? createElement(Landing, { key: "landing" }) : null,
    );
  }

  let releases: Array<() => void> = [];
  afterEach(() => {
    for (const release of releases) release();
    releases = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeResizeObserver.instances = [];
    for (const header of document.querySelectorAll("header")) header.remove();
    document.documentElement.style.removeProperty("--header-hide");
  });

  /**
   * The list's units, `ROW` tall one under the other from `above` down the
   * page, followed by a long rest of the page, or a page `height` tall.
   */
  function mount({
    y = 0,
    above = 0,
    height,
    header = false,
    whole = false,
    landFirst = false,
  }: {
    y?: number;
    above?: number;
    height?: number;
    header?: boolean;
    /** Whether the page lands as it mounts, in the list's own commit. */
    landFirst?: boolean;
    /** Whether the page scrolls by whole pixels, as Chromium does. */
    whole?: boolean;
  } = {}) {
    const page = {
      y,
      above,
      keys: KEYS,
      /** Heights past a unit's own row, by key. */
      grown: {} as Record<string, number>,
    };
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(VIEWPORT);
    const heightOf = (key: string) => ROW + (page.grown[key] ?? 0);
    const listHeight = () =>
      page.keys.reduce((sum, key) => sum + heightOf(key), 0);
    const docHeight = () => height ?? page.above + listHeight() + 2000;
    vi.spyOn(
      document.documentElement,
      "scrollHeight",
      "get",
    ).mockImplementation(docHeight);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
      VIEWPORT,
    );
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => page.y);
    const clamp = (y: number) =>
      Math.min(docHeight() - VIEWPORT, Math.max(0, y));
    const scrollBy = vi
      .spyOn(window, "scrollBy")
      .mockImplementation((...args: unknown[]) => {
        page.y = clamp(page.y + Number(args[1]));
        if (whole) page.y = Math.round(page.y);
      });
    vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
      page.y = clamp(Number(args[1]));
    });
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const measure = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        const key = this.getAttribute("data-unit") ?? "";
        const at = page.keys.indexOf(key);
        if (at === -1) return { top: 0, bottom: 0, height: 0 } as DOMRect;
        const before = page.keys.slice(0, at);
        const top =
          page.above + before.reduce((sum, k) => sum + heightOf(k), 0) - page.y;
        return {
          top,
          bottom: top + heightOf(key),
          height: heightOf(key),
        } as DOMRect;
      });
    if (header) {
      const el = document.createElement("header");
      Object.defineProperty(el, "offsetHeight", { value: 93 });
      document.body.append(el);
    }
    const list = (key: string) =>
      createElement(ReadingList, { key, keys: page.keys, header, landFirst });
    const view = render(list("page"));
    return {
      page,
      view,
      scrollBy,
      measure,
      /** The column the list stands in: its own parent. */
      column: () => view.container,
      /** Where a unit's top is on screen. */
      topOf: (key: string) =>
        view.container
          .querySelector(`[data-unit="${key}"]`)
          ?.getBoundingClientRect().top,
      /** The page, minus `key`. */
      remove: (key: string) => {
        page.keys = page.keys.filter((k) => k !== key);
        view.rerender(list("page"));
      },
      /** Another page's list in this one's place, in one commit. */
      replace: () => view.rerender(list("next")),
      /** The reader's own scroll, gesture first, as a browser delivers it. */
      readerAt: (to: number) => {
        fireEvent.wheel(window);
        page.y = to;
        fireEvent.scroll(window);
      },
    };
  }

  it("puts the unit a reader scrolled to back as the page grows above it", () => {
    const { page, readerAt, topOf } = mount();
    readerAt(450);
    expect(topOf("e")).toBe(-50);
    page.above += 300;
    resizePage();
    expect(page.y).toBe(750);
    expect(topOf("e")).toBe(-50);
  });

  it("falls back on the unit after it once the one being read is gone", () => {
    const { page, readerAt, topOf, remove } = mount();
    readerAt(450);
    expect(topOf("f")).toBe(50);
    remove("e");
    page.above += 300;
    resizePage();
    expect(topOf("f")).toBe(50);
  });

  it("leaves a landing on the end alone to hold the page", () => {
    const { page, readerAt, scrollBy, remove } = mount();
    readerAt(450);
    releases.push(landAtBottom());
    page.above += 300;
    resizePage();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(page.y).toBe(page.above + KEYS.length * ROW + 2000 - VIEWPORT);
    // A commit moving the units, with no resize the hold would hear.
    remove("a");
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("picks at a press that scrolls nothing when nothing is kept yet", () => {
    const { page, topOf } = mount({ y: 450 });
    fireEvent.pointerDown(window);
    page.above += 300;
    resizePage();
    expect(topOf("e")).toBe(-50);
  });

  it("measures nothing at a key the reader types once their place is kept", () => {
    const { readerAt, measure } = mount();
    readerAt(450);
    measure.mockClear();
    for (let i = 0; i < 5; i++) fireEvent.keyDown(window, { key: "a" });
    expect(measure).not.toHaveBeenCalled();
  });

  it("keeps the reader's own scroll its event has yet to report", () => {
    const { page, readerAt, topOf, remove } = mount();
    readerAt(450);
    // Applied before its scroll event, as Firefox and iOS apply a fling, or
    // CodeMirror revealing a caret in an animation frame.
    page.y += 50;
    page.above += 300;
    resizePage();
    expect(topOf("e")).toBe(-100);
    // The same through a commit, with the list itself changing.
    page.y += 30;
    remove("a");
    expect(topOf("e")).toBe(-130);
  });

  it("turns the browser's anchoring off while it keeps a unit, and back on", () => {
    const { readerAt, view } = mount();
    const anchoring = () =>
      document.documentElement.style.getPropertyValue("overflow-anchor");
    expect(anchoring()).toBe("");
    readerAt(450);
    expect(anchoring()).toBe("none");
    // Past every unit: nothing to keep.
    readerAt(5000);
    expect(anchoring()).toBe("");
    // A landing holds the page and keeps no unit of the reader's meanwhile.
    readerAt(450);
    releases.push(landAtBottom());
    expect(anchoring()).toBe("");
    readerAt(450);
    view.unmount();
    expect(anchoring()).toBe("");
  });

  it("puts back when only the column holding the list resizes", () => {
    const { page, readerAt, topOf, column } = mount();
    readerAt(450);
    // A taller sidebar sets the page's height: only the column grows.
    page.above += 300;
    resizeElement(column());
    expect(topOf("e")).toBe(-50);
  });

  it("hands a landing over only to the list there when it began", () => {
    const { page, scrollBy, replace } = mount();
    const release = landAtBottom();
    // The next page's list arrives, then the old page's landing lets go as
    // the old page unmounts, the reader having touched neither.
    replace();
    release();
    page.y = 450;
    fireEvent.scroll(window);
    page.above += 300;
    resizePage();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("hands a landing begun in the commit declaring the list over to it", () => {
    const { page, topOf } = mount({ landFirst: true });
    // Let go with no input, as a route change or a target leaving would.
    releases[0]?.();
    page.y = 450;
    fireEvent.scroll(window);
    page.above += 300;
    resizePage();
    expect(topOf("e")).toBe(-50);
  });

  it("keeps the unit a click took through the scroll its last put back made", () => {
    const { page, readerAt, topOf, view } = mount();
    readerAt(450);
    page.above += 300;
    resizePage();
    // A click on g before the scroll event of that put back arrives.
    const g = view.container.querySelector('[data-unit="g"]');
    if (g !== null) fireEvent.click(g);
    expect(topOf("g")).toBe(150);
    fireEvent.scroll(window);
    // What lies between the top of the screen and g grows.
    page.grown.f = 300;
    resizePage();
    expect(topOf("g")).toBe(150);
  });

  it("falls back on where the next unit stood as of the last put back", () => {
    const { page, readerAt, topOf, remove } = mount();
    readerAt(450);
    expect(topOf("f")).toBe(50);
    // An image loads in the unit being read: what follows it moves down.
    page.grown.e = 300;
    resizePage();
    expect(topOf("f")).toBe(350);
    remove("e");
    expect(topOf("f")).toBe(350);
  });

  it("lets no scroll step's rounding add up over many small put backs", () => {
    const { page, readerAt, topOf } = mount({ whole: true });
    readerAt(450);
    for (let i = 0; i < 50; i++) {
      page.above += 0.4;
      const before = page.y;
      resizePage();
      // The browser reports the owner's own scroll a frame later.
      if (page.y !== before) fireEvent.scroll(window);
    }
    expect(Math.abs((topOf("e") ?? 0) + 50)).toBeLessThanOrEqual(0.5);
  });

  it("keeps the reader where a hold on a target that left the page let go", () => {
    const { page, topOf } = mount({ y: 450 });
    const target = document.createElement("div");
    document.body.append(target);
    releases.push(holdRevealed(target, document.body));
    target.remove();
    resizePage();
    expect(topOf("e")).toBe(-50);
    page.above += 300;
    resizePage();
    expect(topOf("e")).toBe(-50);
  });

  it("moves nothing before the reader's first input or a landing's end", () => {
    const { page, scrollBy } = mount();
    // A fold opened toward a comment link's target, say, with the page
    // cut short by the browser meanwhile.
    page.y = 450;
    fireEvent.scroll(window);
    page.above += 300;
    resizePage();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(page.y).toBe(450);
  });

  describe("and the auto-hiding header", () => {
    const hidden = () =>
      document.documentElement.style.getPropertyValue("--header-hide");
    const touch = (type: "touchstart" | "touchmove") =>
      window.dispatchEvent(new Event(type));
    /** A finger dragging the page to `to`, still down. */
    const drag = (page: { y: number }, to: number) => {
      touch("touchstart");
      touch("touchmove");
      page.y = to;
      window.dispatchEvent(new Event("scroll"));
    };

    it("stays where the reader's drag left it as the page keeps their place", () => {
      const { page, topOf } = mount({ y: 2000, above: 1800, header: true });
      drag(page, 2030);
      expect(hidden()).toBe("30px");
      page.above += 300;
      resizePage();
      expect(topOf("c")).toBe(-30);
      // The scroll the owner made, a frame later.
      window.dispatchEvent(new Event("scroll"));
      expect(hidden()).toBe("30px");
      // The drag goes on, and the header with it.
      touch("touchmove");
      page.y += 10;
      window.dispatchEvent(new Event("scroll"));
      expect(hidden()).toBe("40px");
    });

    it("hears how far the page really moved, short of the way at its end", () => {
      // Its last offset is 4200, and the reader drags right down to near it.
      const { page } = mount({
        y: 4000,
        above: 3900,
        height: 5000,
        header: true,
      });
      drag(page, 4100);
      expect(hidden()).toBe("93px");
      page.above += 300;
      resizePage();
      expect(page.y).toBe(4200);
      window.dispatchEvent(new Event("scroll"));
      expect(hidden()).toBe("93px");
    });
  });
});
