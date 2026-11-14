/**
 * The Jobs case panel's edits to a test list (`features/admin/console/pages/jobs/caseEdits.ts`):
 * a case keeps its number and its other lines, rules are replaced in the order given, a deleted
 * case comes back under its old number when that is free, and edits made since are kept.
 * Fixtures are fake.
 */
import { describe, expect, test } from "@jest/globals";
import { parseTestList } from "../features/admin/testList";
import { withCaseCopied, withCaseEdited, withCaseRemoved, withCaseRestored, withNewCase } from "../features/admin/console/pages/jobs/caseEdits";

const LIST = [
  "---",
  "job: heartbeat",
  "---",
  "",
  "# Staying quiet",
  "",
  "## 1. Quiet morning",
  "",
  "Morning look, no new mail",
  "",
  "- as: someone",
  "- kind: task",
  "- must not: text them",
  "- may: write a note",
  "",
  "## 2. Evening check",
  "",
  "- kind: task",
  "- must: ask first",
  "",
].join("\n");

const TWO_OF_THREE = [
  "# Staying quiet",
  "",
  "## 1. First",
  "",
  "- kind: task",
  "- must: one",
  "",
  "## 2. Second",
  "",
  "- kind: task",
  "- must: two",
  "",
  "## 3. Third",
  "",
  "- kind: task",
  "- must: three",
  "",
].join("\n");

const cases = (text: string) => parseTestList(text).cases;
const rulesOf = (text: string, number: number) =>
  cases(text)
    .find((item) => item.number === number)!
    .rules.map((line) => [line.key, line.value]);
/** From a case's heading to the end of the file, byte for byte. */
const tailFrom = (text: string, heading: string) => text.slice(text.indexOf(heading));

describe("withCaseEdited", () => {
  test("keeps the case number, its other bullets and the other cases", () => {
    const edited = withCaseEdited(LIST, 1, {
      name: "Quiet morning",
      when: "Morning look, no new mail",
      rules: [{ kind: "must not", text: "text them" }],
    });
    expect(cases(edited).map((item) => item.number)).toEqual([1, 2]);
    const first = edited.slice(edited.indexOf("## 1."), edited.indexOf("## 2."));
    expect(first).toContain("- as: someone");
    expect(first).toContain("- kind: task");
    // The other case is untouched, byte for byte.
    expect(tailFrom(edited, "## 2. Evening check")).toBe(tailFrom(LIST, "## 2. Evening check"));
  });

  test("replaces the rules in the order given, drops empty ones and changes the description", () => {
    const edited = withCaseEdited(LIST, 1, {
      name: "Quiet morning",
      when: "A new description",
      rules: [
        { kind: "must", text: "ask first" },
        { kind: "may", text: "   " },
        { kind: "must not", text: "text them" },
      ],
    });
    expect(rulesOf(edited, 1)).toEqual([
      ["must", "ask first"],
      ["must not", "text them"],
    ]);
    expect(edited).not.toContain("- may:");
    expect(cases(edited)[0]!.description).toBe("A new description");
    expect(cases(edited)[0]!.person?.value).toBe("someone");
    expect(cases(edited)[0]!.kind?.value).toBe("task");
  });

  test("saving an empty name throws and changes nothing", () => {
    expect(() => withCaseEdited(LIST, 1, { name: "   ", when: "", rules: [] })).toThrow("A case needs a name");
  });
});

describe("withNewCase", () => {
  test("a new case gets the next number after the highest", () => {
    const made = withNewCase(LIST, "Brand new");
    expect(made.number).toBe(3);
    expect(cases(made.text).map((item) => [item.number, item.title])).toEqual([
      [1, "Quiet morning"],
      [2, "Evening check"],
      [3, "Brand new"],
    ]);
  });

  test("after a gap, the next number is still one past the highest", () => {
    const gappy = LIST.replace("## 2. Evening check", "## 7. Evening check");
    expect(withNewCase(gappy).number).toBe(8);
  });
});

describe("withCaseCopied", () => {
  test("names the copy '<title> (copy)' with the next number and the same rules", () => {
    const copied = withCaseCopied(LIST, 1);
    expect(copied.number).toBe(3);
    expect(cases(copied.text).find((item) => item.number === 3)!.title).toBe("Quiet morning (copy)");
    expect(rulesOf(copied.text, 3)).toEqual(rulesOf(LIST, 1));
    expect(cases(copied.text).find((item) => item.number === 3)!.description).toBe("Morning look, no new mail");
    // The original keeps its own heading.
    expect(cases(copied.text).find((item) => item.number === 1)!.title).toBe("Quiet morning");
  });
});

test("a copy keeps a name with '$' patterns in it as typed (BUG: the heading is a String.replace replacement)", () => {
  const dollars = withCaseEdited(LIST, 2, { name: "Pay $& later, ask about $1", when: "", rules: [] });
  const copied = withCaseCopied(dollars, 2);
  expect(cases(copied.text).find((item) => item.number === 3)!.title).toBe("Pay $& later, ask about $1 (copy)");
});

describe("withCaseRemoved", () => {
  test("returns the case's own lines, and the list without it", () => {
    const removed = withCaseRemoved(LIST, 1);
    expect(removed.block).toEqual([
      "## 1. Quiet morning",
      "",
      "Morning look, no new mail",
      "",
      "- as: someone",
      "- kind: task",
      "- must not: text them",
      "- may: write a note",
    ]);
    expect(removed.text).not.toContain("Quiet morning");
    expect(cases(removed.text).map((item) => item.number)).toEqual([2]);
  });
});

describe("withCaseRestored", () => {
  test("puts the case back under its old number, between its neighbours, when the number is free", () => {
    const { text, block } = withCaseRemoved(TWO_OF_THREE, 2);
    const restored = withCaseRestored(text, block);
    expect(restored).toBe(TWO_OF_THREE);
    expect(cases(restored).map((item) => [item.number, item.title])).toEqual([
      [1, "First"],
      [2, "Second"],
      [3, "Third"],
    ]);
  });

  test("restoring the first case reproduces the whole list", () => {
    const { text, block } = withCaseRemoved(LIST, 1);
    expect(withCaseRestored(text, block)).toBe(LIST);
  });

  test("when another case took the number, it is appended with the next number", () => {
    const { block } = withCaseRemoved(LIST, 1);
    // Case 1 still exists, so the deleted one's number is taken.
    const restored = withCaseRestored(LIST, block);
    expect(cases(restored).map((item) => [item.number, item.title])).toEqual([
      [1, "Quiet morning"],
      [2, "Evening check"],
      [3, "Quiet morning"],
    ]);
  });

  test("edits made to other cases after the delete are kept", () => {
    const { text, block } = withCaseRemoved(TWO_OF_THREE, 1);
    const edited = withCaseEdited(text, 2, { name: "Second, renamed", when: "", rules: [{ kind: "must", text: "two again" }] });
    const restored = withCaseRestored(edited, block);
    expect(cases(restored).map((item) => [item.number, item.title])).toEqual([
      [1, "First"],
      [2, "Second, renamed"],
      [3, "Third"],
    ]);
    expect(rulesOf(restored, 2)).toEqual([["must", "two again"]]);
    expect(rulesOf(restored, 1)).toEqual([["must", "one"]]);
  });
});
