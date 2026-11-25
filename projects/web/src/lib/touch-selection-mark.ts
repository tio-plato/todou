import { isApplePlatform } from "@/lib/platform.ts";

/**
 * Set on a pierre host (`diffs-container`) while a selection made with a
 * finger has an end in its shadow root; the
 * `diffs-container[data-touch-selection] > [slot^="annotation-"]` rules in
 * styles.css then let that file's line notes pass the selection handle
 * through.
 */
export const TOUCH_SELECTION_ATTR = "data-touch-selection";

/**
 * Marks the pierre file a touch selection has an end in, for as long as the
 * page lives.
 *
 * While a selection handle is dragged, iOS WebKit hit-tests the point under
 * the finger and, whenever the node it finds is in another tree scope than
 * the end not being dragged, moves the dragged end to the edge of that end's
 * tree (`rangeForPointInRootViewCoordinates`, WebKit bug 187556:
 * https://bugs.webkit.org/show_bug.cgi?id=187556). A line note is light DOM
 * slotted between pierre's rows, so a handle dragged from a code row onto a
 * note threw the selection to the end (or start) of the file. Made
 * transparent to hit-testing, the note leaves pierre's own row under the
 * finger, in the same shadow root.
 *
 * Only a selection with an end in the shadow root is marked: one wholly
 * inside a note is all document, which iOS drags through fine, and passing
 * through the note there would throw that end out of it. Only a touch
 * selection on an Apple platform is marked: the clamp is iOS WebKit's alone,
 * and elsewhere the cost (a note that cannot be pressed while a selection
 * stands) would buy nothing. "Touch" is the type of the last `pointerdown`:
 * a long press and every handle drag start with a touch one, and a mouse or
 * pen press after it hands the notes back.
 */
export function markTouchSelections(doc: Document): void {
  let lastPointer = "";
  let frame = 0;
  const update = () => {
    frame = 0;
    const touch = lastPointer === "touch" && isApplePlatform();
    const hosts = touch ? [...doc.querySelectorAll("diffs-container")] : [];
    const roots = hosts.flatMap((host) =>
      host.shadowRoot ? [host.shadowRoot] : [],
    );
    let range: StaticRange | undefined;
    if (roots.length > 0) {
      try {
        // The dictionary form only; Safari 17 and 18 throw on it, and they
        // are left as they were.
        range = doc
          .getSelection()
          ?.getComposedRanges({ shadowRoots: roots })[0];
      } catch {
        range = undefined;
      }
    }
    const ends =
      range && !range.collapsed
        ? [range.startContainer.getRootNode(), range.endContainer.getRootNode()]
        : [];
    for (const host of hosts) {
      host.toggleAttribute(
        TOUCH_SELECTION_ATTR,
        host.shadowRoot !== null && ends.includes(host.shadowRoot),
      );
    }
    if (!touch) {
      for (const host of doc.querySelectorAll(`[${TOUCH_SELECTION_ATTR}]`)) {
        host.removeAttribute(TOUCH_SELECTION_ATTR);
      }
    }
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(update);
  };
  doc.addEventListener(
    "pointerdown",
    (event) => {
      lastPointer = event.pointerType;
      schedule();
    },
    { capture: true },
  );
  doc.addEventListener("selectionchange", schedule);
}
