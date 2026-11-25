import type { Question } from "@todou/shared";
import { shownQuestions } from "@todou/shared";
import { describe, expect, it } from "vitest";

const question = (
  key: string,
  when?: Question["when"],
  multiple = false,
): Question => ({
  key,
  multiple,
  question: `Question ${key}?`,
  options: [{ label: "a" }, { label: "b" }, { label: "c" }],
  ...(when === undefined ? {} : { when }),
});

const keys = (shown: Question[]) => shown.map((q) => q.key);

describe("shownQuestions", () => {
  it("asks the unconditional questions and no follow-up before anything is picked", () => {
    const questions = [
      question("q1"),
      question("q2", { key: "q1", selected: [0] }),
      question("q3", { key: "q1", selected: [1] }),
      question("q4"),
    ];
    expect(keys(shownQuestions(questions, new Map()))).toEqual(["q1", "q4"]);
  });

  it("asks a follow-up when its question picked any of its options, and only then", () => {
    const questions = [
      question("q1", undefined, true),
      question("q2", { key: "q1", selected: [0, 2] }),
    ];
    expect(keys(shownQuestions(questions, new Map([["q1", [2]]])))).toEqual([
      "q1",
      "q2",
    ]);
    expect(keys(shownQuestions(questions, new Map([["q1", [1]]])))).toEqual([
      "q1",
    ]);
  });

  it("does not ask a follow-up of a question that is not asked, whatever it still holds", () => {
    const questions = [
      question("q1"),
      question("q2", { key: "q1", selected: [0] }),
      question("q3", { key: "q2", selected: [1] }),
    ];
    const picked = new Map([
      ["q1", [1]],
      ["q2", [1]],
    ]);
    expect(keys(shownQuestions(questions, picked))).toEqual(["q1"]);
  });
});
