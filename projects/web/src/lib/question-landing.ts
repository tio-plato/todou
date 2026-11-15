import type { IssueQuestions } from "@todou/shared";

export const UNANSWERED_QUESTIONS_HASH = "unanswered-questions";

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
    items.find((item) => item.answer === null && item.withdrawal === null)
      ?.comment_id ??
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
