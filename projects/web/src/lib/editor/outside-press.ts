import { ViewPlugin } from "@codemirror/view";

/** The node a caret placed at (x, y) would sit in, where the browser says. */
function caretNode(doc: Document, x: number, y: number): Node | null {
  if (typeof doc.caretPositionFromPoint === "function") {
    return doc.caretPositionFromPoint(x, y)?.offsetNode ?? null;
  }
  // Safari before 26.2 and Chromium before 128 have only the older form.
  if (typeof doc.caretRangeFromPoint === "function") {
    return doc.caretRangeFromPoint(x, y)?.startContainer ?? null;
  }
  return null;
}

/**
 * Keep a press on the blank page beside an editor out of it, as a press
 * beside a <textarea> stays out of that.
 *
 * Chromium and WebKit answer a press on something that cannot take focus
 * (the shell's padding, the card page's grid) by placing the caret on the
 * nearest text, and when that text is an editor's, the caret landing in its
 * contenteditable focuses it. A caret equal to the selection already there
 * moves nothing, and a press that only clears a selection over that text
 * places none, so the editor took focus on some presses and not others.
 * Firefox never focuses this way, but a drag or a double press from the same
 * spot selects text inside the unfocused editor.
 *
 * Each of these starts with one selectstart, sent by the press's default
 * action before it moves the caret, and cancelling it keeps the caret and any
 * selection out of the editor. The press itself is left alone, so its other
 * defaults still happen: focus leaves whatever held it (an empty comment box
 * folds), and a press inside a focusable container (a dialog) still hands
 * focus to that. The page's old selection is dropped by hand, as the moving
 * caret would have dropped it, so Quote reply or a spec annotation does not
 * read it afterwards.
 */
export const ignoreOutsidePress = ViewPlugin.define((view) => {
  const doc = view.dom.ownerDocument;
  // Set by a press beside this editor and spent on that press's own
  // selectstart. Firefox sends none for a single press, so the press ending
  // drops it as well: a later selectstart (a keyboard selection elsewhere,
  // Select all from the context menu) is not the press's.
  let beside = false;

  const down = (event: MouseEvent) => {
    if (event.target instanceof Node && view.dom.contains(event.target)) {
      beside = false;
      return;
    }
    const node = caretNode(doc, event.clientX, event.clientY);
    // The whole editor rather than its content: beside a focused empty line
    // WebKit finds the caret in the cursor layer drawn next to the content,
    // and still places it in the content.
    beside = node !== null && view.dom.contains(node);
  };
  // Not checked against the event's target: Chromium and WebKit send it to
  // what was pressed, Firefox to where the new selection starts, which is
  // inside the editor.
  const start = (event: Event) => {
    if (beside) {
      event.preventDefault();
      doc.getSelection()?.removeAllRanges();
    }
    beside = false;
  };
  const end = () => {
    beside = false;
  };

  const controller = new AbortController();
  const listen = { capture: true, signal: controller.signal };
  doc.addEventListener("mousedown", down, listen);
  doc.addEventListener("selectstart", start, listen);
  doc.addEventListener("mouseup", end, listen);
  doc.addEventListener("contextmenu", end, listen);
  return { destroy: () => controller.abort() };
});
