/**
 * What the Jobs page's case panel saves, as edits to the test list note the
 * case lives in (`../../../testList`). A case keeps its number through every
 * edit: a number is how every earlier round's scores name it.
 */

import {
  addCase,
  addRule,
  appendCase,
  caseLines,
  parseTestList,
  removeCase,
  removeLine,
  serializeTestList,
  setCaseTitle,
  setDescription,
} from "../../../testList";

export interface CaseDraft {
  name: string;
  when: string;
  /** In order; a rule with no text is dropped on save. */
  rules: { kind: string; text: string }[];
}

const isRule = (key: string) => key === "must" || key === "must not" || key === "may" || key === "judge" || key.startsWith("must ");

/** The list's text with case `number` written as `draft`; its other lines (kind, as, replies) are kept. */
export function withCaseEdited(text: string, number: number, draft: CaseDraft): string {
  let list = parseTestList(text);
  const name = draft.name.trim();
  if (name === "") throw new Error("A case needs a name");
  list = setCaseTitle(list, number, name.replace(/\s*\n\s*/g, " "));
  list = setDescription(list, number, draft.when);
  // Remove the rule lines last to first, so each index still points where it did.
  for (;;) {
    const found = list.cases.find((item) => item.number === number);
    const rule = found?.rules.filter((line) => isRule(line.key)).at(-1);
    if (!rule) break;
    list = removeLine(list, rule.index);
  }
  for (const rule of draft.rules) {
    const value = rule.text.trim().replace(/\s*\n\s*/g, " ");
    if (value === "") continue;
    list = addRule(list, number, rule.kind, value);
  }
  return serializeTestList(list);
}

/** A new case at the end of the list, and its number. */
export function withNewCase(text: string, name = "New case"): { text: string; number: number } {
  const list = addCase(parseTestList(text), name);
  const number = list.cases.reduce((max, item) => Math.max(max, item.number), 0);
  return { text: serializeTestList(list), number };
}

/** A copy of case `number` at the end of the list, named `<name> (copy)`, and its number. */
export function withCaseCopied(text: string, number: number): { text: string; number: number } {
  const list = parseTestList(text);
  const block = caseLines(list, number);
  const title = list.cases.find((item) => item.number === number)?.title ?? "Case";
  const heading = block[0]!.replace(/^(## \d+\. ).*$/, `$1${title} (copy)`);
  const next = appendCase(list, [heading, ...block.slice(1)]);
  return { text: serializeTestList(next), number: next.cases.reduce((max, item) => Math.max(max, item.number), 0) };
}

/** The list without case `number`, and the case's own lines, for Undo. */
export function withCaseRemoved(text: string, number: number): { text: string; block: string[] } {
  const list = parseTestList(text);
  const block = caseLines(list, number);
  return { text: serializeTestList(removeCase(list, number)), block };
}

/**
 * A deleted case put back into the list as it is now: under its old number
 * when nobody took it since, so earlier rounds' scores still name it, else as
 * the next case. Edits made to the list since are kept.
 */
export function withCaseRestored(text: string, block: readonly string[]): string {
  const list = parseTestList(text);
  const number = Number(/^## (\d+)\./.exec(block[0] ?? "")?.[1]);
  if (!Number.isInteger(number) || list.cases.some((item) => item.number === number)) return serializeTestList(appendCase(list, block));
  const lines = [...list.lines];
  const trailingNewline = lines[lines.length - 1] === "";
  const body = trailingNewline ? lines.slice(0, -1) : lines;
  // Back where it was in number order: before the first case numbered after it.
  const after = list.cases.find((item) => item.number > number);
  if (after) {
    body.splice(after.headingIndex, 0, ...block, "");
  } else {
    if (body.length > 0 && body[body.length - 1] !== "") body.push("");
    body.push(...block);
  }
  if (trailingNewline) body.push("");
  return serializeTestList(parseTestList(body.join("\n")));
}
