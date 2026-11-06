import { render } from "@testing-library/react";
import { createElement, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDockCover } from "../src/lib/dock-cover.ts";
import { FakeResizeObserver } from "./fake-resize-observer.ts";

/**
 * happy-dom lays nothing out, so each element carries the box the hook reads:
 * `data-h` its height, `data-top` its top edge.
 */
function stubBoxes() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const { h, top } = (this as HTMLElement).dataset ?? {};
      const height = Number(h ?? 0);
      const y = Number(top ?? 0);
      return {
        height,
        width: 0,
        top: y,
        left: 0,
        bottom: y + height,
      } as DOMRect;
    },
  );
}

/** The issue page's dock, absent while the card is in the trash. */
function Page({
  trashed = false,
  height = "93",
  folded = false,
}: {
  trashed?: boolean;
  height?: string;
  folded?: boolean;
}) {
  const dock = useRef<HTMLDivElement>(null);
  useDockCover(dock);
  if (trashed) return null;
  return createElement(
    "div",
    {
      ref: dock,
      "data-h": height,
      style: { position: folded ? "static" : "sticky" },
    },
    folded
      ? createElement("button", {
          type: "button",
          "data-composer-opener": "",
          "data-h": "32",
          // 16px above a 300px keyboard on an 844px screen.
          "data-top": String(844 - 300 - 16 - 32),
        })
      : null,
  );
}

const cover = () =>
  document.documentElement.style.getPropertyValue("--dock-cover");

describe("useDockCover", () => {
  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    stubBoxes();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty("--vv-bottom");
  });

  it("publishes the floating dock's height, and nothing once the page is gone", () => {
    const view = render(createElement(Page));
    expect(cover()).toBe("93px");

    view.unmount();
    expect(cover()).toBe("");
  });

  it("follows the dock the trash swaps out", () => {
    const view = render(createElement(Page));
    expect(cover()).toBe("93px");

    view.rerender(createElement(Page, { trashed: true }));
    expect(cover()).toBe("0px");

    view.rerender(createElement(Page, { height: "129" }));
    expect(cover()).toBe("129px");

    // A draft grows the restored dock: the observer has to be reading that
    // one, not the element the trash took away.
    const restored = view.container.firstElementChild as HTMLElement;
    restored.dataset.h = "251";
    for (const observer of FakeResizeObserver.instances) observer.fire();
    expect(cover()).toBe("251px");
  });

  it("counts the Comment button, not the folded dock, from where it rides", () => {
    // The shell has published a keyboard, and the button sits above it.
    document.documentElement.style.setProperty("--vv-bottom", "300px");
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);

    render(createElement(Page, { folded: true, height: "67" }));
    expect(cover()).toBe("48px");
  });
});
