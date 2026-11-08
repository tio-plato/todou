import { Language } from "@codemirror/language";
import {
  ChangeSet,
  StateEffect,
  type StateEffectType,
  type Transaction,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** A transaction held back, and the changes applied since it was made. */
type Held = { tr: Transaction; changes: ChangeSet };

/** An entry means a release is already registered for that view's frame. */
const held = new WeakMap<EditorView, Held[]>();

/**
 * Whether @codemirror/view has put off reading the DOM to the next frame.
 * Reads the private DOMObserver.delayedFlush; a CodeMirror that has moved it
 * reads as "no", which keeps today's behaviour and only costs the iOS bug.
 */
function deferredRead(view: EditorView): boolean {
  const observer = (view as unknown as { observer?: { delayedFlush?: number } })
    .observer;
  return (observer?.delayedFlush ?? -1) >= 0;
}

/**
 * The effect @codemirror/language's background parser dispatches its work
 * with, left out of its typings: a parse of the document as it stood, which
 * no position mapping can carry to another text. Without it, held parse
 * results come out like any other effect.
 */
const parseResult = (
  Language as unknown as { setState?: StateEffectType<unknown> }
).setState;

/** The window CodeMirror schedules its deferred read on (its private `win`). */
function frameWindow(view: EditorView): Window {
  return view.dom.ownerDocument.defaultView ?? window;
}

/** Neither changes the text nor moves the selection: effects, reconfigures. */
function quiet(tr: Transaction): boolean {
  return !tr.docChanged && tr.selection === undefined;
}

function release(view: EditorView): void {
  const queue = held.get(view);
  if (queue === undefined) return;
  // Destroyed: destroy() takes view.dom out of the document but leaves
  // delayedFlush set, so the check below would ask for frames forever.
  if (!view.dom.isConnected) {
    held.delete(view);
    return;
  }
  // A new frame put the read off again: wait for that one too.
  if (deferredRead(view)) {
    frameWindow(view).requestAnimationFrame(() => release(view));
    return;
  }
  held.delete(view);
  for (const { tr, changes } of queue) {
    let effects = StateEffect.mapEffects(tr.effects, changes);
    // Put over the newer text, a parse of the old one breaks every later
    // edit. The parser keeps its progress and starts again after a change.
    if (!changes.empty && parseResult !== undefined) {
      effects = effects.filter((effect) => !effect.is(parseResult));
    }
    view.dispatch({ effects });
  }
}

/**
 * Hold back transactions that change neither text nor selection while
 * @codemirror/view waits to read the DOM.
 *
 * On iOS, a DOM change that shrinks text mid-composition — Backspace in a
 * pinyin draft, or the clear iOS does before inserting the chosen word — is
 * not read at once but on the next animation frame, because handling iOS's
 * clear-then-insert eagerly breaks the insert. Until then the state still
 * holds the old text, and any view.update in between drops the unread
 * mutations and redraws the touched text from that old state: the deleted
 * letters or the spaced pinyin are written back into the DOM while the IME
 * believes them gone, and end up in the document. On the iPhone measured
 * that frame came ~100ms after each key, the delay after which autocomplete
 * dispatches its effect-only results, so this happened on most keys.
 *
 * Such transactions are queued until CodeMirror has read the DOM, then
 * dispatched again as their effects, mapped through whatever the read
 * changed. The text and selection updates that make the read itself, and
 * every write of ours, go through at once. The composition is not required
 * to be open: deleting the last pinyin letter ends it while the read is
 * still pending. Annotations and scrollIntoView are not carried over, since
 * nothing that sets them here is quiet. A held parse result is dropped once
 * the text has changed under it.
 *
 * Only browsers on which CodeMirror defers reads (iOS, IE11, Chrome on
 * Android) ever queue; elsewhere this is view.update. Like
 * composition-safe-measure.ts, this reads private fields rather than
 * carrying pnpm patches of @codemirror/view and @codemirror/language, and
 * fails open without them.
 */
export function compositionSafeDispatch(
  trs: readonly Transaction[],
  view: EditorView,
): void {
  const queue = held.get(view);
  if (trs.every(quiet) && (queue !== undefined || deferredRead(view))) {
    const next = queue ?? [];
    for (const tr of trs) {
      next.push({ tr, changes: ChangeSet.empty(tr.startState.doc.length) });
    }
    if (queue === undefined) {
      held.set(view, next);
      // Registered after CodeMirror's own deferred read, on the same
      // window, so it runs after that read within the same frame.
      frameWindow(view).requestAnimationFrame(() => release(view));
    }
    return;
  }
  // Before the update: an update listener may dispatch again from inside it.
  for (const entry of queue ?? []) {
    for (const tr of trs) entry.changes = entry.changes.compose(tr.changes);
  }
  view.update(trs);
}
