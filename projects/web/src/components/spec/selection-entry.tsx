import { formatAnchorRange } from "@todou/shared";
import { MessageSquarePlusIcon } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  elementNear,
  type SelectionEndpoints,
  selectionEndpoints,
} from "@/lib/selection-endpoints.ts";
import { POINTER_FINE, useMediaQuery } from "@/lib/use-media-query.ts";

export type AnchorRange = {
  lineStart: number;
  lineEnd: number;
  colStart: number | null;
  colEnd: number | null;
};

/** An anchor the entry offers, and where it sits in the container. */
export type PendingSelection<A extends AnchorRange> = A & { top: number };

/**
 * How long a press on the entry keeps its anchor alive without a `click` to
 * close the window. Long enough for a touch's own click to arrive, short
 * enough that a press which slid off the entry does not strand a dead
 * anchor on screen.
 */
const PRESS_WINDOW_MS = 300;

/**
 * Where the floating entry sits, in container coordinates.
 *
 * The legacy range is what has a rect — but when the browser clamped it
 * onto a shadow host it is an empty box there, and the endpoint's own
 * element is then what says where to sit (T-164).
 */
function entryTop(
  container: Element,
  selection: Selection,
  ends: SelectionEndpoints,
): number {
  const legacy = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const rect =
    (legacy === null || legacy.collapsed
      ? elementNear(ends.end.node)?.getBoundingClientRect()
      : null) ?? legacy?.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const below = (rect?.bottom ?? 0) - containerRect.top + 6;
  // A selection that reaches past the file — ⌘/Ctrl-A, or a drag on into
  // the page below it — has a rect as tall as the page, and that bottom
  // would put the button hundreds of pixels under the prose it points at,
  // off screen. Clamping to the file's own box is what keeps "the entry
  // appeared" and "the reader can reach it" the same statement.
  return Math.min(Math.max(below, 0), containerRect.bottom - containerRect.top);
}

/**
 * The selection → floating "Comment" entry layer, shared by the rendered and
 * the source views. `resolve` turns the live selection's endpoints into an
 * anchor, or null when they point at nothing it can anchor; it has to be
 * stable, since every document listener hangs on it.
 */
export function useSelectionEntry<A extends AnchorRange>(
  containerRef: RefObject<HTMLElement | null>,
  resolve: (container: Element, ends: SelectionEndpoints) => A | null,
): { pending: PendingSelection<A> | null; clear: () => void } {
  const [pending, setPending] = useState<PendingSelection<A> | null>(null);
  /** A drag is in flight: its selection is not final until the pointer lifts. */
  const draggingRef = useRef(false);
  /** The entry is being pressed: the selection may vanish, the anchor stays. */
  const pressingUiRef = useRef(false);
  const pressTimerRef = useRef<number | null>(null);
  const pendingRef = useRef<PendingSelection<A> | null>(null);

  /**
   * Read the live selection and place the entry.
   *
   * `keepOnEmpty` is the window-resize path: a resize is not a reason to
   * drop an entry, and the selection may well have survived it untouched.
   */
  const decide = useCallback(
    (keepOnEmpty = false) => {
      const container = containerRef.current;
      if (!container) return;
      const selection = window.getSelection();
      // The cheap branch. `selectionchange` arrives every frame of a drag,
      // while a full recompute walks every open shadow root under the
      // container, so emptiness is settled before anything is measured —
      // by `toString()` rather than `isCollapsed`, which lies about shadow
      // selections (T-164) and would take a live selection's entry with it.
      if (selection === null || selection.toString() === "") {
        // A press on the entry itself collapses the selection before the
        // click lands. The anchor is already stored in `pending`, and the
        // click reads it from there, so the press window keeps it (T-60).
        if (!keepOnEmpty && !pressingUiRef.current) setPending(null);
        return;
      }
      // Mid-drag the entry would sit under the words still being selected,
      // and every frame would pay for a recompute. `pointerup` schedules
      // the one that counts.
      if (draggingRef.current) return;
      const ends = selectionEndpoints(selection, container);
      if (ends === null || ends.collapsed) {
        setPending(null);
        return;
      }
      const anchor = resolve(container, ends);
      if (anchor === null) {
        setPending(null);
        return;
      }
      setPending({ ...anchor, top: entryTop(container, selection, ends) });
    },
    [containerRef, resolve],
  );

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  // A resize moves the entry, and its `top` was measured against a selection
  // rect that has since moved. Recompute it from the live selection, or leave
  // it where it is when there is no selection left to measure.
  useLayoutEffect(() => {
    const onResize = () => {
      if (pendingRef.current !== null) decide(true);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [decide]);

  /**
   * Every path that changes a selection, which is the point of T-384: the
   * old container `mouseup` heard mouse drags that ended inside the prose
   * and nothing else — not the keyboard, not a drag released outside, and
   * on a touchscreen not the long-press gesture, for which no compatibility
   * mouse event is ever synthesised.
   */
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let frame: number | null = null;
    const schedule = () => {
      if (typeof requestAnimationFrame !== "function") {
        decide();
        return;
      }
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        decide();
      });
    };
    const clearPressWindow = () => {
      pressingUiRef.current = false;
      if (pressTimerRef.current !== null) {
        window.clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
    };
    // Closing the press window re-reads the selection, because what the
    // window held back is exactly the "the selection is gone" verdict: a
    // press that ended on something other than the entry — a chip, or the
    // prose beside it — has to leave the entry pointing at nothing.
    const releaseUi = () => {
      clearPressWindow();
      schedule();
    };
    document.addEventListener("selectionchange", schedule, { signal });
    document.addEventListener(
      "pointerdown",
      (event) => {
        const onUi =
          event.target instanceof Element &&
          event.target.closest("[data-annotation-ui]") !== null;
        if (!onUi) {
          draggingRef.current = true;
          return;
        }
        pressingUiRef.current = true;
        // The window has to close by itself too: a press that slides off
        // the entry fires neither `click` nor `pointercancel`, and leaving
        // it open would keep a dead anchor on screen indefinitely.
        pressTimerRef.current = window.setTimeout(releaseUi, PRESS_WINDOW_MS);
      },
      { capture: true, signal },
    );
    document.addEventListener(
      "pointerup",
      () => {
        draggingRef.current = false;
        schedule();
      },
      { signal },
    );
    document.addEventListener(
      "pointercancel",
      () => {
        draggingRef.current = false;
        releaseUi();
      },
      { signal },
    );
    document.addEventListener("click", releaseUi, { signal });
    return () => {
      controller.abort();
      if (frame !== null) cancelAnimationFrame(frame);
      clearPressWindow();
    };
  }, [decide]);

  const clear = useCallback(() => setPending(null), []);
  return { pending, clear };
}

/**
 * The entry for a pending anchor: a button floating at the container's right
 * edge under a fine pointer, an action bar pinned to the viewport's bottom
 * under touch. The container has to be `relative` for the button to sit in it.
 */
export function SelectionEntry<A extends AnchorRange>({
  pending,
  clear,
  onStage,
}: {
  pending: PendingSelection<A> | null;
  clear: () => void;
  onStage: (anchor: A) => void;
}) {
  const pointerFine = useMediaQuery(POINTER_FINE);
  if (pending === null) return null;
  const stage = () => {
    const { top: _top, ...anchor } = pending;
    onStage(anchor as unknown as A);
    clear();
    window.getSelection()?.removeAllRanges();
  };
  return pointerFine ? (
    <StageButton
      size="sm"
      className="absolute right-0 z-10 shadow-md"
      style={{ top: pending.top }}
      anchor={pending}
      onStage={stage}
    />
  ) : (
    // Touch selection comes with the platform's own bubble, floating
    // against the selection, which we can neither move nor dismiss.
    // Pinned to the bottom of the viewport is the one place the two
    // cannot claim at once — and the one place a thumb always reaches.
    // No `env(safe-area-inset-bottom)`: without `viewport-fit=cover`
    // iOS has already inset the page, and a second one would show.
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-2 backdrop-blur"
      data-annotation-ui=""
      data-testid="annotation-action-bar"
    >
      <StageButton
        size="lg"
        className="w-full"
        anchor={pending}
        onStage={stage}
      />
    </div>
  );
}

/** The entry itself, in both of the shapes it takes. */
function StageButton({
  anchor,
  size,
  className,
  style,
  onStage,
}: {
  anchor: AnchorRange;
  size: "sm" | "lg";
  className: string;
  style?: CSSProperties;
  onStage: () => void;
}) {
  return (
    <Button
      size={size}
      className={className}
      style={style}
      data-annotation-ui=""
      // A mouse press would collapse the selection under the button (and
      // move focus) before click fires, and the selection has to outlive
      // the press (T-60). A touch press is left alone: cancelling it has no
      // agreed effect on whether `click` follows, and the press window
      // holds the anchor either way.
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") e.preventDefault();
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onStage}
    >
      <MessageSquarePlusIcon className="size-4" />
      Comment{" "}
      {formatAnchorRange({
        line_start: anchor.lineStart,
        line_end: anchor.lineEnd,
        col_start: anchor.colStart,
        col_end: anchor.colEnd,
      })}
    </Button>
  );
}
