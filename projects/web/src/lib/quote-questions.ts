import type { Question, QuestionAnswer } from "@todou/shared";
import type { Nodes } from "mdast";
import { parseMarkdown } from "./markdown-processor.ts";

/**
 * A question comment as a quote lays it out. Its questions are not in the
 * stored body: the card renders them from the comment's component, so a
 * quote writes them out as markdown of its own — the body, then per
 * question its header, prompt, options and answer, one block each.
 */

/** A comment as a whole quote reads it: its body, then its questions. */
export type QuotedEntry = {
  body: string;
  questions: readonly Question[] | null;
  answers: readonly QuestionAnswer[] | null;
};

/** One option's text, either half absent. */
type OptionText = { label: string; description: string };

/** The top-level blocks `markdown` parses into. */
function blocksOf(markdown: string): Nodes[] {
  const tree = parseMarkdown(markdown);
  return "children" in tree ? tree.children : [];
}

/**
 * One list item: label and description on one line where both are prose,
 * the description a paragraph of its own otherwise. Every line after the
 * first is indented under the marker, so a fence or a second line stays in
 * the item rather than ending the list.
 */
function optionItem({ label, description }: OptionText): string {
  const inline =
    label !== "" &&
    description !== "" &&
    blocksOf(label).at(-1)?.type === "paragraph" &&
    blocksOf(description).at(0)?.type === "paragraph";
  const text = inline
    ? `${label} — ${description}`
    : [label, description].filter((part) => part !== "").join("\n\n");
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? `- ${line}` : line === "" ? "" : `  ${line}`))
    .join("\n");
}

/**
 * What a reader wrote under "other": on the answer line where it is one
 * paragraph, a block of its own after the line where it is anything else.
 * Nothing written is neither.
 */
function otherParts(other: string): { inline: string; after: string } {
  if (other === "") return { inline: "", after: "" };
  const blocks = blocksOf(other);
  return blocks.length === 1 && blocks[0]?.type === "paragraph"
    ? { inline: `other: ${other}`, after: "" }
    : { inline: "other:", after: other };
}

/** A question's blocks, in the order the card shows them; empty ones go. */
function questionBlocks(question: {
  header: string;
  prompt: string;
  options: readonly OptionText[];
  answer: readonly string[];
}): string[] {
  // The header is one line on the card; a newline in it would split the
  // bold in two.
  const header = question.header.trim().replace(/\s*\n\s*/g, " ");
  const options = question.options.filter(
    (o) => o.label !== "" || o.description !== "",
  );
  return [
    header === "" ? "" : `**${header}**`,
    question.prompt,
    options.map(optionItem).join("\n"),
    ...question.answer,
  ];
}

/** The answer as one line — picks in card order, decline, other — or none. */
function answerBlocks(
  question: Question,
  record: QuestionAnswer | undefined,
): string[] {
  if (record === undefined) return [];
  const picks = [...record.selected]
    .map((s) => s.index)
    .sort((a, b) => a - b)
    .flatMap((index) => question.options[index]?.label.trim() ?? []);
  const { inline, after } = otherParts(record.other?.trim() ?? "");
  const parts = [
    ...picks,
    ...(record.declined ? ["declined to answer"] : []),
    ...(inline === "" ? [] : [inline]),
  ];
  if (parts.length === 0) return [];
  return [`**Answer:** ${parts.join(" · ")}`, after];
}

/** Blocks a blank line apart, the empty ones left out. */
function joinBlocks(blocks: readonly string[]): string {
  return blocks.filter((block) => block.trim() !== "").join("\n\n");
}

/**
 * The whole entry: its body, then every question with its options, their
 * descriptions — shown or not on the card — and the answer where there is
 * one. An entry with no questions quotes its body as it is.
 */
export function entryQuote(entry: QuotedEntry): string {
  if (entry.questions === null) return entry.body;
  const answers = entry.answers;
  return joinBlocks([
    entry.body.trimEnd(),
    ...entry.questions.flatMap((q) =>
      questionBlocks({
        header: q.header ?? "",
        prompt: q.question.trim(),
        options: q.options.map((o) => ({
          label: o.label.trim(),
          description: o.description?.trim() ?? "",
        })),
        answer:
          answers === null
            ? []
            : answerBlocks(
                q,
                answers.find((a) => a.key === q.key),
              ),
      }),
    ),
  ]);
}

/**
 * Which piece of an entry a quotable element renders: the body, or one text
 * of a question, named by the question's key and an option's index.
 */
export type QuotePart =
  | { kind: "body" }
  | { kind: "header" | "prompt" | "other"; question: string }
  | { kind: "label" | "description"; question: string; option: number };

/** The cuts of one question, gathered from across a selection. */
type QuestionCuts = {
  header: string;
  prompt: string;
  options: Map<number, OptionText>;
  other: string;
};

/**
 * What a selection across several parts of one entry quotes: each part's
 * cut, laid out as the whole entry would be, with only the parts the
 * selection reached. The picked options are a mark on the card rather than
 * text, so no selection holds them, and there is no answer line; other's
 * text stands alone. A cut inside a single part is quoted as it is, the way
 * a cut inside a body is.
 */
export function cutsQuote(
  cuts: ReadonlyArray<{ part: QuotePart; text: string }>,
): string {
  const [only, ...rest] = cuts;
  if (only !== undefined && rest.length === 0) return only.text;
  const blocks: Array<string | QuestionCuts> = [];
  const questions = new Map<string, QuestionCuts>();
  for (const { part, text } of cuts) {
    if (part.kind === "body") {
      blocks.push(text);
      continue;
    }
    let question = questions.get(part.question);
    if (question === undefined) {
      question = { header: "", prompt: "", options: new Map(), other: "" };
      questions.set(part.question, question);
      blocks.push(question);
    }
    if (part.kind === "label" || part.kind === "description") {
      const option = question.options.get(part.option) ?? {
        label: "",
        description: "",
      };
      question.options.set(part.option, { ...option, [part.kind]: text });
    } else {
      question[part.kind] = text;
    }
  }
  return joinBlocks(
    blocks.flatMap((block) => {
      if (typeof block === "string") return [block];
      const { inline, after } = otherParts(block.other);
      return questionBlocks({
        header: block.header,
        prompt: block.prompt,
        options: [...block.options.values()],
        answer: [inline, after],
      });
    }),
  );
}
