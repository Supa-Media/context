/**
 * Case groups (board 19; the owner, 2026-10-16: "allow me to edit the case
 * group names case items etc"). A case group is one test list in
 * `ai/tests/`; these pin that renaming it, deleting, duplicating or moving a
 * case, and editing what the person's notes say each change only the lines
 * they name, and that no case is renumbered: a case's number is how every
 * earlier round's scores name it.
 */

import { describe, expect, test } from "@jest/globals";
import {
  appendCase,
  caseLines,
  groupTitle,
  parseTestList,
  removeCase,
  serializeTestList,
  setDescription,
  setGroupTitle,
} from "../features/admin/testList";

const LIST = [
  "---",
  "job: texting-assistant",
  "---",
  "",
  "# Core",
  "",
  "The basics.",
  "",
  "## 1. when's the dentist?",
  "",
  "Maya's dentist note says Tuesday at 3.",
  "",
  "- kind: task",
  "- must: say Tuesday at 3",
  "",
  "## 2. yo",
  "",
  "- kind: chat",
  "### a note for whoever edits this",
  "- must not: send two texts",
  "",
  "## 3. are you a bot",
  "",
  "- kind: chat",
  "",
].join("\n");

describe("a case group's name", () => {
  test("is its first heading, and renaming changes that line alone", () => {
    const list = parseTestList(LIST);
    expect(groupTitle(list)).toBe("Core");
    const renamed = setGroupTitle(list, "Everyday");
    expect(groupTitle(renamed)).toBe("Everyday");
    expect(serializeTestList(renamed)).toBe(LIST.replace("# Core", "# Everyday"));
  });

  test("a list with no heading gets one above its first case", () => {
    const list = parseTestList("---\njob: x\n---\n\n## 1. hi\n\n- kind: chat\n");
    expect(serializeTestList(setGroupTitle(list, "Hellos"))).toBe("---\njob: x\n---\n\n# Hellos\n\n## 1. hi\n\n- kind: chat\n");
  });

  test("a name is one line and not empty", () => {
    const list = parseTestList(LIST);
    expect(() => setGroupTitle(list, "  ")).toThrow();
    expect(() => setGroupTitle(list, "a\nb")).toThrow();
  });
});

describe("cases", () => {
  test("deleting one keeps every other case's number and lines", () => {
    const next = removeCase(parseTestList(LIST), 2);
    expect(next.cases.map((item) => item.number)).toEqual([1, 3]);
    expect(serializeTestList(next)).not.toContain("## 2. yo");
    expect(serializeTestList(next)).toContain("## 3. are you a bot");
  });

  test("a copied case lands as the next number with its rules", () => {
    const list = parseTestList(LIST);
    const next = appendCase(list, caseLines(list, 1));
    expect(next.cases.map((item) => item.number)).toEqual([1, 2, 3, 4]);
    const copy = next.cases.find((item) => item.number === 4)!;
    expect(copy.title).toBe("when's the dentist?");
    expect(copy.rules.map((rule) => rule.value)).toEqual(["say Tuesday at 3"]);
    expect(serializeTestList(next).endsWith("\n")).toBe(true);
  });

  test("moving a case to another group is a copy there and a delete here", () => {
    const here = parseTestList(LIST);
    const there = parseTestList("# Other\n\n## 7. hi\n\n- kind: chat\n");
    const moved = appendCase(there, caseLines(here, 3));
    expect(moved.cases.map((item) => `${item.number}. ${item.title}`)).toEqual(["7. hi", "8. are you a bot"]);
    expect(removeCase(here, 3).cases.map((item) => item.number)).toEqual([1, 2]);
  });
});

describe("what their notes say", () => {
  test("replaces the description lines and keeps every bullet and ### line", () => {
    const next = setDescription(parseTestList(LIST), 1, "Maya's dentist note says Wednesday at 4.\nShe moved it last week.");
    const one = next.cases[0]!;
    expect(one.description).toBe("Maya's dentist note says Wednesday at 4.\nShe moved it last week.");
    expect(one.rules.map((rule) => rule.value)).toEqual(["say Tuesday at 3"]);
    expect(serializeTestList(next)).toContain("## 2. yo");
    const two = setDescription(next, 2, "He texts like this.");
    expect(serializeTestList(two)).toContain("### a note for whoever edits this");
    expect(two.cases[1]!.rules.map((rule) => rule.key)).toEqual(["must not"]);
  });

  test("a bullet or heading typed into the notes is not taken as one", () => {
    const next = setDescription(parseTestList(LIST), 1, "- must: be sneaky\n# Title");
    expect(next.cases[0]!.rules.map((rule) => rule.value)).toEqual(["say Tuesday at 3"]);
    expect(groupTitle(next)).toBe("Core");
  });

  test("on the last case, the file keeps its one trailing newline", () => {
    const next = setDescription(parseTestList(LIST), 3, "Asked once a week.");
    expect(serializeTestList(next).endsWith("- kind: chat\n")).toBe(true);
  });
});
