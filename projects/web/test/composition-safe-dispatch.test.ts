import { Language, LRLanguage, syntaxTree } from "@codemirror/language";
import {
  EditorState,
  type Extension,
  StateEffect,
  type StateEffectType,
  StateField,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parser as jsonParser } from "@lezer/json";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compositionSafeDispatch } from "../src/lib/editor/composition-safe-dispatch.ts";

// The cast reaches @codemirror/view internals the module under test also
// depends on; a CodeMirror that renames them fails these tests first.
type Internals = {
  inputState: { composing: number };
  observer: { delayedFlush: number; flush(): boolean };
};

// The background parser's field and the effect it dispatches its work with,
// both left out of @codemirror/language's typings.
const parse = Language as unknown as {
  state: StateField<unknown>;
  setState: StateEffectType<unknown>;
};

// A position-carrying effect, and a field holding its latest value: whether
// the field moved says when a held transaction took effect, and its value
// whether the position went through the deletion that arrived meanwhile.
const mark = StateEffect.define<number>({
  map: (pos, changes) => changes.mapPos(pos),
});
const marked = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    let latest = value;
    for (const effect of tr.effects) if (effect.is(mark)) latest = effect.value;
    return latest;
  },
});

const openViews: EditorView[] = [];
let frames: FrameRequestCallback[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const view of openViews.splice(0)) view.destroy();
});

// "abc wom" with an open composition whose last letter the IME has just
// deleted from the DOM, the read of that deletion deferred to the next frame
// the way @codemirror/view defers it on iOS.
async function deferredDeletion({
  composing,
  extensions = [],
}: {
  composing: boolean;
  extensions?: Extension;
}): Promise<EditorView & Internals> {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc: "abc wom",
      extensions: [marked, extensions],
    }),
    dispatchTransactions: compositionSafeDispatch,
  }) as EditorView & Internals;
  openViews.push(view);
  view.dispatch({});
  // An idle editor has measured already; a pending measure would read the
  // DOM itself, since measuring forces CodeMirror's deferred read.
  otherFrameCallbacksRun();
  view.inputState.composing = 1;
  // The frame CodeMirror asked for when it saw the text shrink.
  view.observer.delayedFlush = 999;
  const text = view.contentDOM.querySelector(".cm-line")?.firstChild;
  if (!(text instanceof Text)) throw new Error("no text node in the line");
  text.nodeValue = "abc wo";
  // Deliver the MutationObserver record; flush() leaves it queued while the
  // read is deferred.
  await Promise.resolve();
  // Deleting the last pinyin letter ends the composition at once.
  if (!composing) view.inputState.composing = -1;
  return view;
}

// CodeMirror's own deferred read, the first callback of the next frame.
function deferredReadRuns(view: EditorView & Internals) {
  view.observer.delayedFlush = -1;
  view.observer.flush();
}

// Every other frame callback registered meanwhile, in order.
function otherFrameCallbacksRun() {
  for (const callback of frames.splice(0)) callback(performance.now());
}

// Whatever else the event loop has queued, short of the next frame.
async function tasksRun() {
  await new Promise((resolve) => setTimeout(resolve));
}

function nextFrame(view: EditorView & Internals) {
  deferredReadRuns(view);
  otherFrameCallbacksRun();
}

describe("compositionSafeDispatch", () => {
  it("keeps a deletion mid-composition from being written back", async () => {
    const view = await deferredDeletion({ composing: true });

    view.dispatch({ effects: mark.of(7) });
    await tasksRun();

    expect(view.contentDOM.textContent).toBe("abc wo");
    expect(view.state.field(marked)).toBeNull();
    nextFrame(view);
    expect(view.state.doc.toString()).toBe("abc wo");
    expect(view.state.field(marked)).toBe(6);
  });

  it("holds as well once the deletion has ended the composition", async () => {
    const view = await deferredDeletion({ composing: false });

    view.dispatch({ effects: mark.of(7) });
    await tasksRun();

    expect(view.contentDOM.textContent).toBe("abc wo");
    expect(view.state.field(marked)).toBeNull();
    nextFrame(view);
    expect(view.state.doc.toString()).toBe("abc wo");
    expect(view.state.field(marked)).toBe(6);
  });

  it("waits for the read when a frame comes before it", async () => {
    const view = await deferredDeletion({ composing: true });
    view.dispatch({ effects: mark.of(7) });
    await tasksRun();

    // The read was put off to a later frame than the one this one ran in.
    otherFrameCallbacksRun();

    expect(view.contentDOM.textContent).toBe("abc wo");
    expect(view.state.field(marked)).toBeNull();
    nextFrame(view);
    expect(view.state.doc.toString()).toBe("abc wo");
    expect(view.state.field(marked)).toBe(6);
  });

  it("lets text and selection changes through at once", async () => {
    const view = await deferredDeletion({ composing: true });

    view.dispatch({ changes: { from: 0, insert: "> " } });
    view.dispatch({ selection: { anchor: 1 } });

    expect(view.state.doc.toString().startsWith("> abc")).toBe(true);
    expect(view.state.selection.main.head).toBe(1);
  });

  it("applies held transactions in the order they came", async () => {
    const view = await deferredDeletion({ composing: true });
    view.dispatch({ effects: mark.of(7) });
    await tasksRun();
    deferredReadRuns(view);

    // The read is done but the held transaction not yet out: a newer one
    // must not overtake it.
    view.dispatch({ effects: mark.of(2) });
    await tasksRun();
    otherFrameCallbacksRun();

    expect(view.state.field(marked)).toBe(2);
  });

  it("maps held effects through text changed from inside an update", async () => {
    let answered = false;
    const view = await deferredDeletion({
      composing: true,
      // Answers the read's text change with one of its own, dispatched
      // while the read's update is still on the stack.
      extensions: EditorView.updateListener.of((update) => {
        if (!update.docChanged || answered) return;
        answered = true;
        update.view.dispatch({ changes: { from: 0, insert: "x" } });
      }),
    });
    view.dispatch({ effects: mark.of(7) });
    await tasksRun();

    nextFrame(view);

    expect(view.state.doc.toString()).toBe("xabc wo");
    expect(view.state.field(marked)).toBe(7);
  });

  it("keeps editing once a held parse result comes out", async () => {
    const view = await deferredDeletion({
      composing: true,
      extensions: LRLanguage.define({ parser: jsonParser }),
    });
    // What the background parser dispatches: its parse of the document as
    // it stands, the text from before the deletion.
    view.dispatch({
      effects: parse.setState.of(view.state.field(parse.state)),
    });
    await tasksRun();
    nextFrame(view);

    view.dispatch({ changes: { from: 6, insert: "m" } });

    expect(view.state.doc.toString()).toBe("abc wom");
    expect(syntaxTree(view.state).length).toBe(7);
  });

  it("stops asking for frames once the editor is destroyed", async () => {
    const view = await deferredDeletion({ composing: true });
    view.dispatch({ effects: mark.of(7) });
    await tasksRun();

    // destroy() leaves delayedFlush set, as CodeMirror's own destroy does.
    view.destroy();
    otherFrameCallbacksRun();

    expect(frames).toEqual([]);
  });
});
