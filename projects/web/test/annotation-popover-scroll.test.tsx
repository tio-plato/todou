import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
