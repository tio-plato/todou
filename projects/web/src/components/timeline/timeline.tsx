import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import type { TimelineComment, TimelineItem } from "@todou/shared";
import { enumValue, settlementsByComment } from "@todou/shared";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { projectsQuery } from "@/api/queries.ts";
import {
  mergeFolded,
  needsHead,
  remainingCount,
  shouldFollowBottom,
  useTimelineHead,
  useTimelineTail,
} from "@/api/timeline.ts";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import {
  CommentItem,
  type Viewer,
} from "@/components/timeline/comment-item.tsx";
import { EventGroup } from "@/components/timeline/event-group.tsx";
import { EventRow } from "@/components/timeline/event-row.tsx";
import { FoldBlock } from "@/components/timeline/fold-block.tsx";
import {
  groupTimelineSides,
  hiddenRunKey,
  type RenderUnit,
} from "@/components/timeline/group-events.ts";
import { HiddenBlock } from "@/components/timeline/hidden-block.tsx";
import { useRevealedRuns } from "@/components/timeline/revealed-runs.tsx";
import { SpecVersionCard } from "@/components/timeline/spec-version-card.tsx";
import { TimelineSettlementsProvider } from "@/components/timeline/timeline-answers.tsx";
import { useBelowViewport } from "@/components/timeline/use-below-viewport.ts";
import { useKeepReading } from "@/components/timeline/use-keep-reading.ts";
import { useQuestionLanding } from "@/components/timeline/use-question-landing.ts";
import { useReaderScroll } from "@/components/timeline/use-reader-scroll.ts";
import { useTimelineAnchor } from "@/components/timeline/use-timeline-anchor.ts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { aboveDock } from "@/lib/dock-cover.ts";
import { isQuestionLandingHash } from "@/lib/question-landing.ts";
import {
  conversationEnd,
  isHoldingTarget,
  landAtBottom,
  revealAboveEnd,
  usableViewport,
  useOwnHold,
} from "@/lib/scroll-insets.ts";
import {
  commentAnchor,
  eventAnchor,
  parseTimelineAnchor,
} from "@/lib/timeline-anchors.ts";
import { useReadFailure } from "@/lib/use-read-failure.ts";
import { cn } from "@/lib/utils";

/** Units the first render draws, counted up from the bottom (T-602). */
const FIRST_PASS_UNITS = 6;
/** The longest idle period browsers grant, for where there are none. */
const IDLE_BUDGET_MS = 50;
/**
 * The scroll-to-bottom button's clearance above the floating composer, New
 * messages included.
 */
const PILL_GAP = 12;

/** The key an item renders under, and its identity across fetches. */
function itemKey(item: TimelineItem): string {
  return `${item.type}-${item.id}`;
}

/** The key a unit renders under, and its identity across fills. */
function unitKey(unit: RenderUnit): string {
  if (unit.kind === "item") return itemKey(unit.item);
  if (unit.kind === "hidden") return hiddenRunKey(unit);
  return `group-${unit.events[0]?.id}`;
}

export function Timeline({
  slug,
  issueNumber,
  pendingComments,
  viewer = null,
}: {
  slug: string;
  issueNumber: number;
  pendingComments: Array<{ key: number; comment: TimelineComment }>;
  viewer?: Viewer | null;
}) {
  // The page hands over a fresh object every render; held by value here so
  // the memoized comments see the same viewer from one fill to the next.
  const viewerId = viewer?.id;
  const viewerIsAdmin = viewer?.isAdmin;
  const viewerRole = viewer?.role;
  const stableViewer = useMemo(
    () =>
      viewerId === undefined || viewerIsAdmin === undefined
        ? null
        : { id: viewerId, isAdmin: viewerIsAdmin, role: viewerRole },
    [viewerId, viewerIsAdmin, viewerRole],
  );
  const tail = useTimelineTail(slug, issueNumber);
  const headEnabled = needsHead(tail.data?.pages[0]);
  const head = useTimelineHead(slug, issueNumber, headEnabled);
  const hasContent = tail.data?.pages !== undefined;
  const { replace, notice } = useReadFailure(
    [tail.error, head.error],
    hasContent,
    ["timeline", slug, issueNumber],
  );
  const retryFailed = () => {
    // Only retry failing reads: a healthy half keeps its pages and position.
    if (tail.isError) void tail.refetch();
    if (head.isFetchNextPageError) {
      void head.fetchNextPage({ cancelRefetch: false });
    } else if (head.isError) {
      void head.refetch();
    }
  };
  const anchorHash = useRouterState({ select: (s) => s.location.hash });
  const atBottomRef = useRef(true);
  // While New messages is up, the last item the reader had seen when new ones
  // arrived below it.
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const newBelow = lastSeen !== null;
  const didInitialScroll = useRef(false);
  const blockRef = useRef<HTMLDivElement>(null);
  // Chunk-insert compensation, captured at click time (T-30): the document
  // height baseline plus the adaptive verdict — block in the upper half of
  // the viewport means the reader came up from the tail, so the tail side
  // stays glued; lower half means the head side is being read, and content
  // above the seam is naturally stable without adjustment.
  const chunkAdjust = useRef<{ base: number; compensate: boolean } | null>(
    null,
  );
  const lastScrollHeight = useRef(0);
  const prevAboveCount = useRef(0);

  const { above, below } = mergeFolded(
    headEnabled ? (head.data?.pages ?? []) : [],
    tail.data?.pages ?? [],
  );
  const totalCount = tail.data?.pages.at(-1)?.total_count ?? 0;
  const remaining =
    headEnabled && head.data ? remainingCount(totalCount, above, below) : 0;
  const items: TimelineItem[] = [...above, ...below];
  const renderedCount = items.length + pendingComments.length;
  // One source for "is there a fold block in the seam": grouping and
  // rendering answering that differently would merge a run across a gap the
  // reader can still see, or leave one split under nothing at all.
  const gap = remaining > 0;

  const { isRevealed, reveal, reportHidden } = useRevealedRuns();
  // Block folds the reader has opened (T-598), by host event id. Local
  // state is enough: the component is keyed per card, so it starts empty on
  // each one, and an id that stops being a host is simply never asked about.
  const [openFolds, setOpenFolds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const toggleFolds = useCallback((hostIds: number[], open: boolean) => {
    setOpenFolds((prev) => {
      const next = new Set(prev);
      for (const id of hostIds) {
        if (open) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const projects = useQuery(projectsQuery);
  const projectId = projects.data?.find((p) => p.slug === slug)?.id;
  const {
    above: unitsAbove,
    below: unitsBelow,
    hostOf,
  } = groupTimelineSides(above, below, {
    gap,
    isRevealed,
    projectId,
    isFoldExpanded: (id) => openFolds.has(id),
  });
  // Reported upward rather than recomputed there: the section line and the
  // floating bar sit above this component, and the merged item list they
  // would have to count is this component's to own.
  const stillHidden = [...unitsAbove, ...unitsBelow].reduce(
    (n, unit) => (unit.kind === "hidden" ? n + unit.comments.length : n),
    0,
  );
  useEffect(() => {
    reportHidden(stillHidden);
  }, [stillHidden, reportHidden]);

  // The map is the settlements the loaded items carry — `above` and `below`
  // merged, not the rendered units, so a comment inside a folded run finds
  // its event once expanded. Keyed on the pages (stable between renders),
  // never on the arrays `mergeFolded` rebuilds every render.
  const settlements = useMemo(
    () =>
      settlementsByComment([
        ...(headEnabled ? (head.data?.pages ?? []) : []).flatMap(
          (p) => p.items,
        ),
        ...(tail.data?.pages ?? []).flatMap((p) => p.items),
      ]),
    [headEnabled, head.data, tail.data],
  );
  // The scroll-to-bottom button. New messages is a notice and shows whichever
  // way the reader scrolls; the plain arrow is a way back, offered once the
  // reader scrolls down with the end of the conversation still below. The
  // end is this list's own, mounted with its content, so a card opens with
  // nothing to flash.
  const [listEnd, setListEnd] = useState<HTMLDivElement | null>(null);
  const endBelow = useBelowViewport(listEnd);
  const [revealed, setRevealed] = useState(false);
  const forgetScroll = useReaderScroll((direction) => {
    if (direction < 0) setRevealed(false);
    else if (endBelow === true) setRevealed(true);
  });
  // The end of the conversation the page declared, not of the list: the
  // composer is sticky, and its in-flow position lies below the list — so
  // this lands with the last item fully visible above the composer. Held,
  // because the images above it are still arriving and push the end away
  // (T-527). It is the page scrolling itself, however soon after the reader's
  // last input it comes, so that input is not taken for its direction.
  const keepHold = useOwnHold();
  const scrollToBottom = useCallback(() => {
    forgetScroll();
    keepHold(landAtBottom());
  }, [keepHold, forgetScroll]);
  const questionLanding = useQuestionLanding(slug, issueNumber);
  const timelineReady = tail.isSuccess && (!headEnabled || head.isSuccess);

  // The first load renders the units nearest the bottom, where the page
  // lands, and fills in the ones above a few at a time while the page is idle
  // (T-602): 33 markdown comments rendered in one go held the main thread for
  // 1.4 s at 4× CPU throttling. `fillFrom` is the key of the topmost rendered unit; null
  // once everything is. A landing anywhere but the bottom renders it all at
  // once, since its target may sit in the part not yet filled.
  const unitKeys = [...unitsAbove, ...unitsBelow].map(unitKey);
  const landsElsewhere =
    parseTimelineAnchor(anchorHash ?? "") !== null ||
    isQuestionLandingHash(anchorHash ?? "") ||
    questionLanding.ownsScroll;
  const [fillFrom, setFillFrom] = useState<string | null | undefined>(
    undefined,
  );
  if (fillFrom === undefined && hasContent) {
    setFillFrom(
      landsElsewhere || unitKeys.length <= FIRST_PASS_UNITS
        ? null
        : unitKeys[unitKeys.length - FIRST_PASS_UNITS],
    );
  } else if (fillFrom && landsElsewhere) {
    setFillFrom(null);
  }
  const fillIndex =
    fillFrom && !landsElsewhere ? Math.max(0, unitKeys.indexOf(fillFrom)) : 0;
  const unfilled = new Set(unitKeys.slice(0, fillIndex));
  // Read back after each synchronous fill, which re-renders before returning.
  const fill = useRef({ keys: unitKeys, index: fillIndex });
  fill.current = { keys: unitKeys, index: fillIndex };
  const listRef = useRef<HTMLDivElement>(null);
  // Whether the reader is past the end of the list, in what follows it: a
  // phone's sidebar, or the comment box with the list's end gone under the
  // header. Only New messages asks, so only measured while it is up.
  const [pastEnd, setPastEnd] = useState(false);
  // Milliseconds per unit, as the last fill measured them.
  const fillRate = useRef<number | null>(null);
  useEffect(() => {
    if (fillIndex === 0) return;
    // As many units per idle period as last time's rate says will fit, in
    // one commit: every commit lays the page out again on top of its units.
    // A slow machine gets a single unit, which at 4× CPU throttling is a
    // long task on its own already.
    const run = (timeRemaining: () => number) => {
      do {
        const count =
          fillRate.current === null
            ? 1
            : Math.max(1, Math.floor(timeRemaining() / fillRate.current));
        const next = Math.max(0, fill.current.index - count);
        const start = performance.now();
        flushSync(() =>
          setFillFrom(next === 0 ? null : fill.current.keys[next]),
        );
        fillRate.current = (performance.now() - start) / count;
      } while (fill.current.index > 0 && timeRemaining() > 0);
    };
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(
        (deadline) => run(() => deadline.timeRemaining()),
        { timeout: 500 },
      );
      return () => cancelIdleCallback(id);
    }
    // Safari has no idle callbacks: a task of its own, budgeted like one.
    const id = setTimeout(() => {
      const start = performance.now();
      run(() => IDLE_BUDGET_MS - (performance.now() - start));
    }, 0);
    return () => clearTimeout(id);
  }, [fillIndex]);
  useKeepReading(listRef, fillIndex > 0);
  const finishQuestionLanding = (error?: "unavailable" | "stalled") => {
    // revealBlock has already moved the viewport. Do not wait for a native
    // scroll event before restoring the ordinary follow-bottom policy.
    atBottomRef.current = shouldFollowBottom(
      window.scrollY,
      conversationEnd(),
      window.innerHeight,
    );
    questionLanding.finish(error);
  };

  // A #comment-/#event- anchor takes over positioning (scroll + flash,
  // expanding the folded middle as needed) — see use-timeline-anchor.ts.
  const anchorActive = useTimelineAnchor(
    {
      remaining,
      isExpanding:
        tail.isPending ||
        (headEnabled && head.isPending) ||
        head.isFetchingNextPage,
      ready: timelineReady && !tail.isFetching && !head.isFetching,
      failed: tail.isError || head.isError,
      // Anchor-driven expansion skips the compensation: the document stays
      // anchored above the seam while chunks stream in, and the final
      // scrollIntoView owns the viewport once the target renders.
      expand: () => head.fetchNextPage({ cancelRefetch: false }),
      hiddenRunHolding: (commentId) => {
        for (const unit of [...unitsAbove, ...unitsBelow]) {
          if (unit.kind !== "hidden") continue;
          if (unit.comments.some((comment) => comment.id === commentId)) {
            return hiddenRunKey(unit);
          }
        }
        return null;
      },
      revealRun: reveal,
      foldHolding: (eventId) => {
        const host = hostOf.get(eventId);
        return host === undefined || openFolds.has(host) ? null : host;
      },
      // The whole group the host sits in, so its one toggle never shows a
      // group half open.
      openFold: (hostId) => {
        for (const unit of [...unitsAbove, ...unitsBelow]) {
          if (unit.kind === "group" && unit.folded?.hosts.has(hostId)) {
            toggleFolds([...unit.folded.hosts.keys()], true);
            return;
          }
        }
        toggleFolds([hostId], true);
      },
    },
    questionLanding.anchorRequest === undefined
      ? undefined
      : {
          id: questionLanding.anchorRequest,
          onComplete: () => finishQuestionLanding(),
          onUnavailable: () => finishQuestionLanding("unavailable"),
          onStalled: () => finishQuestionLanding("stalled"),
        },
  );

  useEffect(() => {
    if (
      questionLanding.latest &&
      timelineReady &&
      !tail.isFetching &&
      !head.isFetching
    ) {
      scrollToBottom();
      didInitialScroll.current = true;
      setLastSeen(null);
      finishQuestionLanding();
    }
  });

  // Initial position: bottom of the newest page (chat-style), unless an
  // anchor target owns the viewport.
  useLayoutEffect(() => {
    if (!didInitialScroll.current && renderedCount > 0) {
      didInitialScroll.current = true;
      // Failed question reads release live following, but are not a successful
      // latest-position fallback when the first timeline page arrives later.
      if (
        !anchorActive &&
        !questionLanding.ownsScroll &&
        !isQuestionLandingHash(anchorHash ?? "")
      )
        scrollToBottom();
    }
  }, [
    renderedCount,
    scrollToBottom,
    anchorActive,
    anchorHash,
    questionLanding.ownsScroll,
  ]);

  // Insertions above the viewport must not shift what the reader sees.
  useLayoutEffect(() => {
    const doc = document.documentElement;
    // The head mounting under an already-positioned viewport (bottom or
    // anchor) is a prepend — keep the tail side glued, unconditionally.
    if (above.length > 0 && prevAboveCount.current === 0) {
      const delta = doc.scrollHeight - lastScrollHeight.current;
      if (delta > 0) window.scrollBy(0, delta);
    }
    // Chunk insert settled — apply the verdict captured at click time.
    // Consume only once the fetch settles: the fetching-state flip commits
    // first with an unchanged document, and consuming it there would leave
    // the actual insert uncompensated.
    if (chunkAdjust.current !== null && !head.isFetchingNextPage) {
      const { base, compensate } = chunkAdjust.current;
      chunkAdjust.current = null;
      const delta = doc.scrollHeight - base;
      if (compensate && delta > 0) window.scrollBy(0, delta);
    }
    prevAboveCount.current = above.length;
    lastScrollHeight.current = doc.scrollHeight;
  });

  // New items at the END while following the bottom → keep following.
  // Keyed off the last item's identity, not the count: expanding the fold
  // also grows the count, and that must not announce "new below".
  const lastPending = pendingComments[pendingComments.length - 1];
  const lastItem = items[items.length - 1];
  const lastKey = lastPending
    ? `pending-${lastPending.key}`
    : lastItem
      ? itemKey(lastItem)
      : null;
  const prevLastKey = useRef(lastKey);
  useEffect(() => {
    if (
      !questionLanding.ownsScroll &&
      lastKey !== prevLastKey.current &&
      prevLastKey.current !== null
    ) {
      // An anchor, a question or New messages' own landing still held is
      // where the untouched reader was sent, and following would yank them
      // off it (T-520): like a reader away from the end, they are told.
      if (atBottomRef.current && !isHoldingTarget()) {
        scrollToBottom();
      } else {
        // The end the reader left, kept through later arrivals.
        const seen = prevLastKey.current;
        setLastSeen((kept) => kept ?? seen);
      }
    }
    prevLastKey.current = lastKey;
  }, [lastKey, scrollToBottom, questionLanding.ownsScroll]);

  // The page itself scrolls, so follow-bottom hangs off the window scroll
  // position. (Scroll-to-top no longer loads anything: the head is present
  // from the start, and the fold block is the only gap-filling affordance.)
  useEffect(() => {
    const onScroll = () => {
      atBottomRef.current = shouldFollowBottom(
        window.scrollY,
        conversationEnd(),
        window.innerHeight,
      );
      if (atBottomRef.current) setLastSeen(null);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The list's end moves with a scroll, a resize or a rotation, and with
  // content loading or arriving on either side of it.
  useEffect(() => {
    if (!newBelow) return;
    const measure = () => {
      const list = listRef.current;
      if (list !== null)
        setPastEnd(list.getBoundingClientRect().bottom < usableViewport().top);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(document.body);
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [newBelow]);

  // Back at the end, or past it, the next showing waits for a scroll down.
  if (endBelow === false && revealed) setRevealed(false);
  const shown = newBelow || (revealed && endBelow === true);
  // Past the end, the new items are above the reader, and the column the
  // layer is stuck in has gone out of sight above them too.
  const current = !newBelow ? "plain" : pastEnd ? "up" : "new";
  // Kept while hidden, so what fades out is the button the reader just saw.
  const [look, setLook] = useState<"new" | "up" | "plain">("plain");
  if (shown && look !== current) setLook(current);
  const motion = cn(
    "transition-[opacity,translate] duration-200 ease-out",
    shown ? "translate-y-0 opacity-100" : "opacity-0 motion-safe:translate-y-2",
  );
  const toBottom = () => {
    scrollToBottom();
    setLastSeen(null);
    setRevealed(false);
  };
  // Where an item lands: its own anchor, or, folded into a group or a hidden
  // run with no box of its own, the unit holding it.
  const landingFor = (key: string): HTMLElement | null => {
    const list = listRef.current;
    if (list === null) return null;
    const item = items.find((i) => itemKey(i) === key);
    const anchor =
      item?.type === "comment"
        ? commentAnchor(item.id)
        : item?.type === "event"
          ? eventAnchor(item.id)
          : null;
    const own =
      anchor === null ? null : list.querySelector<HTMLElement>(`#${anchor}`);
    if (own !== null) return own;
    const holder = [...unitsAbove, ...unitsBelow].find((unit) =>
      unit.kind === "item"
        ? itemKey(unit.item) === key
        : unit.kind === "group"
          ? unit.events.some((event) => itemKey(event) === key)
          : unit.comments.some((comment) => itemKey(comment) === key),
    );
    const unit = holder === undefined ? key : unitKey(holder);
    return list.querySelector<HTMLElement>(`[data-unit="${unit}"]`);
  };
  // New messages goes to the first item the reader has not seen, under the
  // header rather than at the end, which would skip the ones above it. Found
  // now rather than on arrival: the reader's own comment arrives as a pending
  // row and is replaced by the comment it became.
  const toFirstNew = () => {
    const order = [
      ...items.map(itemKey),
      ...pendingComments.map((pending) => `pending-${pending.key}`),
    ];
    const at = lastSeen === null ? -1 : order.indexOf(lastSeen);
    const first = at === -1 ? undefined : order[at + 1];
    const el = first === undefined ? null : landingFor(first);
    if (el === null) {
      toBottom();
      return;
    }
    forgetScroll();
    keepHold(revealAboveEnd(el));
    setLastSeen(null);
    setRevealed(false);
  };

  const onLoadMore = useCallback(() => {
    const blockTop =
      blockRef.current?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    chunkAdjust.current = {
      base: document.documentElement.scrollHeight,
      compensate: blockTop < window.innerHeight / 2,
    };
    // Successive clicks can outrun the isFetchingNextPage flip; without
    // this the second call cancels and re-issues the in-flight request
    // instead of piggybacking on it.
    head.fetchNextPage({ cancelRefetch: false });
  }, [head.fetchNextPage]);

  const renderItem = (item: TimelineItem) => {
    const type = enumValue(item.type, "timeline item type");
    return (
      <div
        key={`${type}-${item.id}`}
        data-unit={`${type}-${item.id}`}
        className="pb-2"
      >
        {item.type === "comment" ? (
          <CommentItem
            slug={slug}
            issueNumber={issueNumber}
            comment={item}
            viewer={stableViewer}
          />
        ) : item.type === "event" ? (
          <>
            <EventRow event={item} slug={slug} issueNumber={issueNumber} />
            {item.event_type === "spec_pushed" && (
              <SpecVersionCard
                slug={slug}
                issueNumber={issueNumber}
                payload={item.payload}
              />
            )}
          </>
        ) : (
          <div className="py-1.5 pl-1 text-sm text-muted-foreground">
            {`Unknown timeline item: ${type}`}
          </div>
        )}
      </div>
    );
  };

  // Merged runs (T-92) render as one collapsed row. A `#event-N` permalink
  // whose target sits inside a group must force it open — the sub-row is
  // the anchor element, and it only exists once expanded.
  const anchorTarget = parseTimelineAnchor(anchorHash ?? "");
  const anchorEventId =
    anchorTarget?.kind === "event" ? anchorTarget.id : undefined;
  const renderUnit = (unit: RenderUnit) => {
    const key = unitKey(unit);
    if (unfilled.has(key)) {
      return (
        <div key={key} data-unit={key} className="pb-2" data-unfilled>
          <Skeleton className="h-16 w-full" />
        </div>
      );
    }
    if (unit.kind === "item") return renderItem(unit.item);
    if (unit.kind === "hidden") {
      return (
        <div key={key} data-unit={key} className="pb-2">
          <HiddenBlock
            count={unit.comments.length}
            onReveal={() => reveal(key)}
          />
        </div>
      );
    }
    return (
      <div key={key} data-unit={key} className="pb-2">
        <EventGroup
          family={unit.family}
          events={unit.events}
          slug={slug}
          issueNumber={issueNumber}
          anchorEventId={anchorEventId}
          folded={unit.folded}
          undoneBy={unit.undoneBy}
          onToggleFold={() => {
            const { folded } = unit;
            if (folded) toggleFolds([...folded.hosts.keys()], !folded.expanded);
          }}
        />
      </div>
    );
  };

  if (replace) {
    return (
      <div className="rounded-lg border border-destructive/40 p-4 text-sm">
        <LoadFailure
          message={`Failed to load timeline: ${replace}`}
          detail={replace}
          onRetry={retryFailed}
          retrying={tail.isFetching || head.isFetching}
        />
      </div>
    );
  }
  if (!hasContent) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  return (
    // Native scroll anchoring would fight the manual insert compensation
    // above, adjusting the viewport a second time for the same insertion.
    <TimelineSettlementsProvider settlements={settlements}>
      <div
        ref={listRef}
        className="[overflow-anchor:none]"
        data-testid="timeline-scroll"
      >
        {questionLanding.error && (
          <LoadFailure
            message={
              questionLanding.error === "unavailable"
                ? "This question is no longer available."
                : "Couldn't locate questions."
            }
            onRetry={questionLanding.retry}
            detail={questionLanding.detail}
            retrying={questionLanding.retrying}
            className="mb-3"
          />
        )}
        {notice && (
          <RefreshFailure
            what="the timeline"
            detail={notice}
            onRetry={retryFailed}
            retrying={tail.isFetching || head.isFetching}
            className="mb-3"
          />
        )}
        {headEnabled && head.isPending && (
          <div className="space-y-3 pb-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {unitsAbove.map(renderUnit)}
        {gap && (
          <div ref={blockRef} className="pb-2">
            <FoldBlock
              remaining={remaining}
              loading={head.isFetchingNextPage}
              onLoadMore={onLoadMore}
            />
          </div>
        )}
        {unitsBelow.map(renderUnit)}
        {pendingComments.map((pending) => (
          <div
            key={`pending-${pending.key}`}
            data-unit={`pending-${pending.key}`}
            className="pb-2"
          >
            <CommentItem
              slug={slug}
              issueNumber={issueNumber}
              comment={pending.comment}
              pending
            />
          </div>
        ))}
        {/* The list's end, after the comments still being sent. */}
        <div ref={setListEnd} />
      </div>
      {/* A sibling of the list, not its last child: a sticky box moves only
          within its parent, and the page's column is what lets this one
          float over the whole card, title and body included. It holds no
          height, the button rising out of it, and `mb-0` takes back the gap
          the column's `space-y-4` would otherwise leave below it. Pointing
          up it is fixed instead, since the column is above the viewport. */}
      <div
        data-scroll-to-bottom=""
        data-state={shown ? "shown" : "hidden"}
        inert={!shown}
        className={cn(
          "z-10 mb-0 flex h-0 items-end justify-center",
          look === "up" ? "fixed inset-x-0" : "sticky",
        )}
        style={{ bottom: aboveDock(PILL_GAP) }}
      >
        {look !== "plain" ? (
          <Button
            size="sm"
            className={cn("shadow-lg", motion)}
            onClick={toFirstNew}
          >
            {look === "up" ? (
              <ArrowUpIcon className="size-4" />
            ) : (
              <ArrowDownIcon className="size-4" />
            )}{" "}
            New messages
          </Button>
        ) : (
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
            // Opaque in the dark theme too, where the outline's own fill is
            // see-through and the comment under it would show.
            className={cn(
              "rounded-full shadow-lg dark:bg-background dark:hover:bg-muted",
              motion,
            )}
            onClick={toBottom}
          >
            <ArrowDownIcon />
          </Button>
        )}
      </div>
    </TimelineSettlementsProvider>
  );
}
