import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import type { SpecReviewDraft } from "../src/lib/spec-drafts.ts";
import { renderWithProviders } from "./render.tsx";

// A chip's popover opens to the chip's left, so its alignment axis is
// vertical, and the popover layer's sticky="always" (T-388) pushed it back
// onto the viewport however far the chip had scrolled away — it stayed
// pinned to the top edge over unrelated text. It has to leave with its chip.

const DRAFT: SpecReviewDraft = {
  id: "d1",
  anchor: {
    path: "design.md",
    version: 1,
    line_start: 1,
    line_end: 1,
    col_start: null,
    col_end: null,
  },
  quote: "Alpha beta gamma.",
  body: "needs a caveat",
};

// happy-dom lays nothing out, so Floating UI sees what these stubs say: a
// landscape phone's viewport, the chip where the test puts it, and the
// popover at the size Chromium draws it.
const VIEWPORT = { width: 750, height: 402 };
const POPOVER = { width: 384, height: 124 };

function stub(element: Element, key: string, value: number) {
  Object.defineProperty(element, key, { configurable: true, value });
}

describe("annotation chip popover", () => {
  it("scrolls out of the viewport with its chip", async () => {
    stub(document.documentElement, "clientWidth", VIEWPORT.width);
    stub(document.documentElement, "clientHeight", VIEWPORT.height);

    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"Alpha beta gamma.\n"}
        annotations={[
          {
            key: DRAFT.id,
            kind: "draft",
            draft: DRAFT,
            start: 1,
            end: 1,
            colStart: null,
            colEnd: null,
          },
        ]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const chip = await view.findByLabelText(/comment\(s\) on this block/);
    let chipTop = 100;
    chip.getBoundingClientRect = () => new DOMRect(700, chipTop, 30, 22);
    fireEvent.click(chip);

    const wrapper = (await view.findByText("needs a caveat")).closest(
      "[data-radix-popper-content-wrapper]",
    ) as HTMLElement;
    const popoverTop = () => {
      const y = /^translate\([-\d.]+px, ([-\d.]+)px\)$/.exec(
        wrapper.style.transform,
      );
      return y === null ? null : Number(y[1]);
    };
    // Until its first position Radix parks the wrapper at
    // translate(0, -200%), which is above the viewport by itself.
    await waitFor(() => expect(popoverTop()).not.toBeNull());
    // The wrapper exists only once the popover is open, so its size is
    // stubbed now; the next scroll measures it anew.
    stub(wrapper, "offsetWidth", POPOVER.width);
    stub(wrapper, "offsetHeight", POPOVER.height);

    const scrollChipTo = async (top: number) => {
      const before = wrapper.style.transform;
      chipTop = top;
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      await waitFor(() => expect(wrapper.style.transform).not.toBe(before));
      return popoverTop() as number;
    };

    // Level with the chip while it is on screen.
    expect(await scrollChipTo(150)).toBe(150);
    // The chip has gone wholly above the viewport: the popover goes too.
    expect((await scrollChipTo(-600)) + POPOVER.height).toBeLessThanOrEqual(0);
    // Scrolled back until part of the chip shows at the top: the popover is
    // pushed onto the viewport again, 8px clear, not left over the edge.
    expect(await scrollChipTo(-10)).toBe(8);
  });
});

// Below `sm` the popover opens centred on the visible part of the screen,
// with its top no lower than its chip's and its bottom no higher, and then
// rides with the page. happy-dom lays nothing out and draws no stylesheet,
// so the ride-along layer is no containing block here and the wrapper's
// transform is in viewport coordinates, from these stubs: an upright phone,
// the chip where the test puts it, and the popover at a capped height.
const PHONE = { width: 390, height: 844 };
const CAPPED = 300;
const CHIP = 24;

const happyDom = globalThis as unknown as {
  happyDOM: { setViewport(size: { width?: number; height?: number }): void };
};

describe("annotation chip popover on a phone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document.documentElement, "clientWidth");
    Reflect.deleteProperty(document.documentElement, "clientHeight");
    happyDom.happyDOM.setViewport({ width: 1024, height: 768 });
  });

  async function openAt(chipTop: number) {
    happyDom.happyDOM.setViewport(PHONE);
    stub(document.documentElement, "clientWidth", PHONE.width);
    stub(document.documentElement, "clientHeight", PHONE.height);
    // The content exists only once the popover opens, which is when its
    // height is read, so the stub has to be in place before the click.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.slot === "popover-content" ? CAPPED : 0;
      },
    );
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"Alpha beta gamma.\n"}
        annotations={[
          {
            key: DRAFT.id,
            kind: "draft",
            draft: DRAFT,
            start: 1,
            end: 1,
            colStart: null,
            colEnd: null,
          },
        ]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const chip = await view.findByLabelText(/comment\(s\) on this block/);
    chip.getBoundingClientRect = () => new DOMRect(366, chipTop, CHIP, CHIP);
    fireEvent.click(chip);
    const wrapper = (await view.findByText("needs a caveat")).closest(
      "[data-radix-popper-content-wrapper]",
    ) as HTMLElement;
    // It is placed twice as it opens, the second time once its offset is
    // known; both land within the click's microtasks, so one macrotask
    // later the wrapper holds the last.
    await act(() => new Promise((done) => setTimeout(done, 0)));
    // Only y: x comes from the popover's width, which happy-dom leaves NaN.
    const y = /^translate\([^,]+, ([-\d.]+)px\)$/.exec(wrapper.style.transform);
    expect(y).not.toBeNull();
    return Number(y?.[1]);
  }

  it("centres on the window where the browser has no visual viewport", async () => {
    // happy-dom has no API either, and says so the way such engines do:
    // undefined, not the null the DOM types admit.
    expect(window.visualViewport).toBeUndefined();
    const top = await openAt(400);
    expect(top + CAPPED / 2).toBe(PHONE.height / 2);
  });

  it("reaches down to a chip too low in the visible part to centre beside", async () => {
    // The visible part shorter than the window, as with a keyboard up. An
    // EventTarget: Floating UI listens to it for scrolls.
    vi.stubGlobal(
      "visualViewport",
      Object.assign(new EventTarget(), { offsetTop: 0, height: 600 }),
    );
    const chipTop = 500;
    const top = await openAt(chipTop);
    expect(top + CAPPED).toBe(chipTop + CHIP);
  });
});
