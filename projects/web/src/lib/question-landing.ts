import type { HistoryState } from "@tanstack/react-router";
import type { IssueQuestions } from "@todou/shared";

export const UNANSWERED_QUESTIONS_HASH = "unanswered-questions";

/**
 * The card's own badge asks for the next question in the history entry's
 * state, not in its address: every address a page writes becomes a row in the
 * browser's history, and the request is only a step on the way to the
 * `#comment-` it lands on. The landing takes the key out again.
 */
const QUESTION_STEP = "todouQuestion";

export type QuestionStep = { after: number | null };

export function readQuestionStep(state: unknown): QuestionStep | null {
  if (typeof state !== "object" || state === null) return null;
  const step = (state as Record<string, unknown>)[QUESTION_STEP];
  if (typeof step !== "object" || step === null) return null;
  const { after } = step as Record<string, unknown>;
  return after === null || Number.isInteger(after)
    ? { after: after as number | null }
    : null;
}

/*
 * The router's `state` updaters. Everything else in the entry is somebody
 * else's (the card's way back, T-407), so both keep it. `HistoryState` is an
 * interface with no members until an application augments it, so the result
 * intersects it back in rather than declaring a second copy of it, as
 * `ReturnLinkState` does.
 */
export function withQuestionStep(
  after: number | null,
): (previous: HistoryState) => HistoryState & { todouQuestion: QuestionStep } {
  return (previous) => ({ ...previous, [QUESTION_STEP]: { after } });
}

export function withoutQuestionStep(
  previous: HistoryState & { todouQuestion?: unknown },
): HistoryState {
  const { [QUESTION_STEP]: _step, ...rest } = previous;
  return rest;
}

/** `-after-<comment id>` names where the reader is, for the card's own badge. */
const LANDING_HASH = /^unanswered-questions(?:-after-(\d{1,9}))?$/;

export function isQuestionLandingHash(hash: string): boolean {
  return LANDING_HASH.test(hash.replace(/^#/, ""));
}

export function questionLandingAfter(hash: string): number | null {
  const after = LANDING_HASH.exec(hash.replace(/^#/, ""))?.[1];
  return after === undefined ? null : Number(after);
}

export function questionLandingHash(after: number | null): string {
  return after === null
    ? UNANSWERED_QUESTIONS_HASH
    : `${UNANSWERED_QUESTIONS_HASH}-after-${after}`;
}

/** Questions arrive in created_at, comment_id order; answers do not reorder them. */
export function selectQuestionLanding({
  items,
}: IssueQuestions): number | null {
  return (
    items.find((item) => item.answer === null)?.comment_id ??
    items.at(-1)?.comment_id ??
    null
  );
}

/**
 * The first question still open after comment `after`, wrapping round to the
 * earliest. Rotating the list keeps what counts as open in one place, and
 * leaves `after` itself last: with nothing open the reader stays where they
 * are. Without `after`, or when it is no question, the earliest.
 */
export function selectNextQuestionLanding(
  questions: IssueQuestions,
  after: number | null,
): number | null {
  const at = questions.items.findIndex((item) => item.comment_id === after);
  if (at === -1) return selectQuestionLanding(questions);
  return selectQuestionLanding({
    ...questions,
    items: [
      ...questions.items.slice(at + 1),
      ...questions.items.slice(0, at + 1),
    ],
  });
}
