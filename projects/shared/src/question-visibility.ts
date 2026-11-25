import type { Question, QuestionCondition } from "./schemas/component.ts";

/**
 * The questions a reader is asked, in component order, given the options
 * picked so far. The one answer in the repo to "is this question
 * asked?": the server validates and counts with it, the web renders with it.
 *
 * A question without `when` is always asked. A follow-up is asked when the
 * question it names is asked and picked any of its `when.selected` options;
 * a decline or other text alone picks nothing. The named question being
 * asked matters on its own: the web keeps the drafts of hidden questions,
 * and a hidden question's draft may still hold the very option its
 * follow-up waits for. Components put a question before its follow-ups, so
 * one pass in order settles every question.
 */
export function shownQuestions(
  questions: readonly Question[],
  picked: ReadonlyMap<string, readonly number[]>,
): Question[] {
  const asked = new Set<string>();
  const shown: Question[] = [];
  for (const question of questions) {
    const when = question.when;
    if (when !== undefined) {
      if (!asked.has(when.key)) continue;
      const chosen = picked.get(when.key) ?? [];
      if (!when.selected.some((index) => chosen.includes(index))) continue;
    }
    asked.add(question.key);
    shown.push(question);
  }
  return shown;
}

/**
 * A follow-up's condition in words, options numbered from 1 as lists show
 * them: `q1 is 2) new table`, or `q1 is 1) a or 3) c`. The server's 422 and
 * the CLI's question list both spell it this way.
 */
export function describeCondition(
  questions: readonly Question[],
  when: QuestionCondition,
): string {
  const options = questions.find((q) => q.key === when.key)?.options ?? [];
  const picks = [...new Set(when.selected)]
    .sort((a, b) => a - b)
    .map((index) => {
      const label = options[index]?.label;
      return label === undefined ? `${index + 1})` : `${index + 1}) ${label}`;
    });
  return `${when.key} is ${picks.join(" or ")}`;
}
