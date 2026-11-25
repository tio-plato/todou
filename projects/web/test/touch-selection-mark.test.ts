import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markTouchSelections,
  TOUCH_SELECTION_ATTR,
} from "../src/lib/touch-selection-mark.ts";

/** A pierre file: code rows in the shadow root, one note slotted between them. */
function sourceFile() {
  const host = document.createElement("diffs-container");
  const shadow = host.attachShadow({ mode: "open" });
  for (const n of [1, 2]) {
    const row = document.createElement("div");
    row.setAttribute("data-line", String(n));
    row.textContent = `line ${n} plainword`;
    shadow.append(row);
  }
  const slot = document.createElement("div");
  slot.setAttribute("slot", "annotation-1");
  const note = document.createElement("p");
  note.textContent = "A note under line one";
  slot.append(note);
  host.append(slot);
  document.body.append(host);
  return {
    host,
    row: shadow.querySelector('[data-line="1"]')?.firstChild as Text,
    note: note.firstChild as Text,
  };
}

function press(pointerType: string) {
  document.body.dispatchEvent(
    new PointerEvent("pointerdown", { pointerType, bubbles: true }),
  );
}

/** What `getComposedRanges` reports next; happy-dom has no such method. */
function select(
  start: Text,
  startOffset: number,
  end: Text,
  endOffset: number,
) {
  const range = {
    startContainer: start,
    startOffset,
    endContainer: end,
    endOffset,
    collapsed: start === end && startOffset === endOffset,
  };
  Object.assign(document.getSelection() as Selection, {
    getComposedRanges: () => [range],
  });
  document.dispatchEvent(new Event("selectionchange"));
}

const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("markTouchSelections", () => {
  it("marks the file a touch selection has an end in", async () => {
    const platform = vi.spyOn(navigator, "platform", "get");
    platform.mockReturnValue("iPhone");
    const file = sourceFile();
    const other = sourceFile();
    markTouchSelections(document);
    const marked = () => [
      file.host.hasAttribute(TOUCH_SELECTION_ATTR),
      other.host.hasAttribute(TOUCH_SELECTION_ATTR),
    ];

    press("touch");
    select(file.row, 7, file.row, 16);
    await frame();
    expect(marked()).toEqual([true, false]);

    select(file.row, 7, file.row, 7);
    await frame();
    expect(marked()).toEqual([false, false]);

    select(file.row, 7, file.row, 16);
    await frame();
    expect(marked()).toEqual([true, false]);
    press("mouse");
    await frame();
    expect(marked()).toEqual([false, false]);

    // A selection inside a note keeps the note hit-testable: iOS drags
    // within it fine, and passing through would throw the end out of it.
    press("touch");
    select(file.note, 2, file.note, 6);
    await frame();
    expect(marked()).toEqual([false, false]);

    platform.mockReturnValue("Linux x86_64");
    press("touch");
    select(file.row, 7, file.row, 16);
    await frame();
    expect(marked()).toEqual([false, false]);
  });
});
