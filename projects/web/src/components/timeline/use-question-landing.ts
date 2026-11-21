import { useQueryClient } from "@tanstack/react-query";
import {
  type RegisteredRouter,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { questionsQuery } from "@/api/questions.ts";
import {
  isQuestionLandingHash,
  questionLandingAfter,
  readQuestionStep,
  selectNextQuestionLanding,
  UNANSWERED_QUESTIONS_HASH,
  withoutQuestionStep,
  withQuestionStep,
} from "@/lib/question-landing.ts";

export const QUESTION_LANDING_ROUTE_ID =
  "/authed/projects/$slug/issues/$number" satisfies keyof RegisteredRouter["routesById"];

type Landing = {
  id: number;
  pathname: string;
  phase: "reading" | "anchor" | "latest" | "failed" | "done";
  hash: string;
  error?: "read" | "unavailable" | "stalled";
  detail?: string;
};

/**
 * A request for a question: the address's `#unanswered-questions…`, which a
 * link from elsewhere follows, or the card's own badge's `todouQuestion` in
 * the entry's state, which leaves the address alone.
 */
function asksForQuestion(hash: string, state: unknown): boolean {
  return isQuestionLandingHash(hash) || readQuestionStep(state) !== null;
}

/**
 * Each card's landing, for its badge to reach while the entry still holds a
 * request: asking for it again through the router would write the same
 * address and the same state, which the router takes for no move at all (it
 * only reloads), so the landing would never hear of the press. Keyed by card,
 * as the Timeline is, so a press never reaches another card's landing.
 */
const presses = new Map<string, () => void>();

/** A press of the card's badge while its entry still holds a request. */
export function pressQuestionLanding(slug: string, issueNumber: number): void {
  presses.get(`${slug}/${issueNumber}`)?.();
}

/** One entry consumes one fresh snapshot, then hands scrolling to the timeline. */
export function useQuestionLanding(slug: string, issueNumber: number) {
  const client = useQueryClient();
  const router = useRouter();
  const location = useRouterState({ select: (s) => s.location });
  const destination = router
    .matchRoutes(location)
    .find((match) => match.routeId === QUESTION_LANDING_ROUTE_ID);
  const isCurrentCard =
    destination?.params.slug === slug &&
    Number(destination.params.number) === issueNumber;
  const sequence = useRef(0);
  const active = useRef<Landing | null>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  const [retry, setRetry] = useState(0);
  const semantic = asksForQuestion(location.hash, location.state);

  // History identity and Retry are explicit new intents, even at the same URL.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reentry must reread and reveal once
  useEffect(() => {
    // A suspended route transition can keep the outgoing Timeline mounted
    // while location already names the next card. It cannot start that intent.
    if (!isCurrentCard) {
      active.current = null;
      setLanding(null);
      return;
    }
    if (!semantic) {
      const current = active.current;
      // Our own replace transfers the same intent to its concrete destination:
      // it writes the destination's hash and takes the badge's key out.
      if (
        current &&
        current.pathname === location.pathname &&
        current.hash === location.hash &&
        current.phase !== "reading"
      ) {
        return;
      }
      active.current = null;
      setLanding(null);
      return;
    }
    const intent: Landing = {
      id: ++sequence.current,
      pathname: location.pathname,
      phase: "reading",
      hash: UNANSWERED_QUESTIONS_HASH,
      // Keep the failure visible and its button disabled during the retry.
      ...(active.current?.pathname === location.pathname &&
      active.current.phase === "failed"
        ? { error: active.current.error, detail: active.current.detail }
        : {}),
    };
    active.current = intent;
    setLanding(intent);
    // Read from the request, never from the last landing: the plain entry
    // always means the earliest, however often it is reentered.
    const after = isQuestionLandingHash(location.hash)
      ? questionLandingAfter(location.hash)
      : (readQuestionStep(location.state)?.after ?? null);
    const isCurrent = () =>
      active.current === intent &&
      router.state.location.pathname === intent.pathname &&
      asksForQuestion(router.state.location.hash, router.state.location.state);
    void client
      .fetchQuery({ ...questionsQuery(slug, issueNumber), staleTime: 0 })
      .then(async (data) => {
        if (!isCurrent()) return;
        const id = selectNextQuestionLanding(data, after);
        const next: Landing = {
          ...intent,
          phase: id === null ? "latest" : "anchor",
          hash: id === null ? "" : `comment-${id}`,
          error: undefined,
          detail: undefined,
        };
        active.current = next;
        setLanding(next);
        try {
          await router.navigate({
            hash: next.hash,
            replace: true,
            resetScroll: false,
            hashScrollIntoView: false,
            // This annotates the current page; it never discards an edit.
            ignoreBlocker: true,
            state: withoutQuestionStep,
          });
        } catch (error) {
          if (
            active.current !== next ||
            router.state.location.pathname !== next.pathname
          )
            return;
          const failed: Landing = {
            ...intent,
            phase: "failed",
            error: "read",
            detail: error instanceof Error ? error.message : String(error),
          };
          active.current = failed;
          setLanding(failed);
        }
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        const failed: Landing = {
          ...intent,
          phase: "failed",
          error: "read",
          detail: error instanceof Error ? error.message : String(error),
        };
        active.current = failed;
        setLanding(failed);
      });
  }, [
    client,
    router,
    slug,
    issueNumber,
    isCurrentCard,
    location.pathname,
    location.hash,
    location.state.__TSR_key,
    semantic,
    retry,
  ]);

  useEffect(
    () => () => {
      active.current = null;
    },
    [],
  );

  // A failed read is read again, as its Retry does; a read under way already
  // answers the press. Called long after this render, so it reads the ref.
  useEffect(() => {
    const key = `${slug}/${issueNumber}`;
    const press = () => {
      if (active.current?.phase === "failed") setRetry((value) => value + 1);
    };
    presses.set(key, press);
    return () => {
      // Only its own: were two landings of one card ever to overlap, the
      // newer one keeps the press.
      if (presses.get(key) === press) presses.delete(key);
    };
  }, [slug, issueNumber]);

  const finish = (error?: "unavailable" | "stalled") => {
    const current = active.current;
    if (
      !current ||
      current.id !== landing?.id ||
      current.pathname !== router.state.location.pathname ||
      current.hash !== router.state.location.hash ||
      (current.phase !== "anchor" && current.phase !== "latest")
    )
      return;
    const next: Landing = {
      ...current,
      phase: error ? "failed" : "done",
      error,
    };
    active.current = next;
    setLanding(next);
  };

  return {
    /** A request is still being worked out; no anchor is the destination yet. */
    intent: semantic,
    // Include the first render, before the reading effect has run.
    ownsScroll:
      (semantic && landing?.phase !== "failed") ||
      landing?.phase === "anchor" ||
      landing?.phase === "latest",
    anchorRequest:
      landing &&
      landing.hash === location.hash &&
      landing.hash.startsWith("comment-")
        ? landing.id
        : undefined,
    latest: landing?.phase === "latest" && location.hash === "",
    error: landing?.error,
    detail: landing?.detail,
    retrying: landing?.phase === "reading",
    finish,
    retry: () => {
      if (semantic) {
        setRetry((value) => value + 1);
      } else {
        // From the earliest again, as the plain entry does, but asked for in
        // the entry's state: the address stays the comment that went missing.
        void router
          .navigate({
            hash: true,
            search: true,
            replace: true,
            resetScroll: false,
            hashScrollIntoView: false,
            ignoreBlocker: true,
            state: withQuestionStep(null),
          })
          .catch(() => {
            // Keep the failure and its Retry if the annotation cannot be made.
            setLanding(landing);
          });
      }
    },
  };
}
