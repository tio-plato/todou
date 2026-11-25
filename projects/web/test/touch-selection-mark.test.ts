import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markTouchSelections,
  TOUCH_SELECTION_ATTR,
} from "../src/lib/touch-selection-mark.ts";

/** A pierre file: code rows in the shadow root, one note slotted between them. */
function sourceFile(doc: Document) {
  const host = doc.createElement("diffs-container");
  const shadow = host.attachShadow({ mode: "open" });
  for (const n of [1, 2]) {
    const row = doc.createElement("div");
    row.setAttribute("data-line", String(n));
    row.textContent = `line ${n} plainword`;
    shadow.append(row);
  }
  const slot = doc.createElement("div");
  slot.setAttribute("slot", "annotation-1");
  const note = doc.createElement("p");
  note.textContent = "A note under line one";
  slot.append(note);
  host.append(slot);
  doc.body.append(host);
  return {
    host,
    row: shadow.querySelector('[data-line="1"]')?.firstChild as Text,
    note: note.firstChild as Text,
  };
}

/**
 * Where `getComposedRanges` reports a boundary point: one inside a shadow
 * root the caller did not pass is moved out to its host, as the API does.
 */
function rescoped(node: Node, offset: number, roots: ShadowRoot[]) {
  let root = node.getRootNode();
  while (root instanceof ShadowRoot && !roots.includes(root)) {
    const parent = root.host.parentNode as Node;
    offset = [...parent.childNodes].indexOf(root.host);
    node = parent;
    root = node.getRootNode();
  }
  return { node, offset };
}

/**
 * A document of its own per case, with two files in it: the module cannot be
 * taken off a document, and reads the platform whenever it likes.
 */
function page(platform: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const doc = document.implementation.createHTMLDocument();
  const file = sourceFile(doc);
  const other = sourceFile(doc);
  markTouchSelections(doc);
  return {
    doc,
    file,
    press(pointerType: string, target: Element = doc.body) {
      target.dispatchEvent(
        new PointerEvent("pointerdown", { pointerType, bubbles: true }),
      );
    },
    /** happy-dom has no `getComposedRanges`; this stands in for it. */
    select(start: Text, startOffset: number, end: Text, endOffset: number) {
      Object.assign(doc.getSelection() as Selection, {
        getComposedRanges: ({
          shadowRoots = [],
        }: {
          shadowRoots?: ShadowRoot[];
        } = {}) => {
          const s = rescoped(start, startOffset, shadowRoots);
          const e = rescoped(end, endOffset, shadowRoots);
          return [
            {
              startContainer: s.node,
              startOffset: s.offset,
              endContainer: e.node,
              endOffset: e.offset,
              collapsed: s.node === e.node && s.offset === e.offset,
            },
          ];
        },
      });
      doc.dispatchEvent(new Event("selectionchange"));
    },
    marked: () => [
      file.host.hasAttribute(TOUCH_SELECTION_ATTR),
      other.host.hasAttribute(TOUCH_SELECTION_ATTR),
    ],
  };
}

const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("markTouchSelections", () => {
  it("marks the file a touch selection has an end in", async () => {
    const { file, press, select, marked } = page("iPhone");
    press("touch");
    select(file.row, 7, file.row, 16);
    await frame();
    expect(marked()).toEqual([true, false]);
  });

  it("marks the file whichever end is in its rows", async () => {
    const { file, press, select, marked } = page("iPhone");
    press("touch");
    select(file.note, 2, file.row, 16);
    await frame();
    expect(marked()).toEqual([true, false]);
    select(file.row, 7, file.note, 6);
    await frame();
    expect(marked()).toEqual([true, false]);
  });

  it("unmarks it once the selection collapses", async () => {
    const { file, press, select, marked } = page("iPhone");
    press("touch");
    select(file.row, 7, file.row, 16);
    await frame();
    select(file.row, 7, file.row, 7);
    await frame();
    expect(marked()).toEqual([false, false]);
  });

  it("unmarks it on a mouse press, even one kept from the document", async () => {
    const { doc, file, press, select, marked } = page("iPhone");
    press("touch");
    select(file.row, 7, file.row, 16);
    await frame();
    const button = doc.createElement("button");
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    doc.body.append(button);
    press("mouse", button);
    await frame();
    expect(marked()).toEqual([false, false]);
  });

  // iOS drags a handle within a note fine; passing through the note would
  // throw that end out of it.
  it("leaves a selection inside a note unmarked", async () => {
    const { file, press, select, marked } = page("iPhone");
    press("touch");
    select(file.note, 2, file.note, 6);
    await frame();
    expect(marked()).toEqual([false, false]);
  });

  it("marks nothing off Apple platforms", async () => {
    const { file, press, select, marked } = page("Linux x86_64");
    press("touch");
    select(file.row, 7, file.row, 16);
    await frame();
    expect(marked()).toEqual([false, false]);
  });
});
