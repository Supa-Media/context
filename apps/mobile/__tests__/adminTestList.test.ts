import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "fs";
import path from "path";
import {
  type RuleTone,
  addCase,
  addRule,
  parseTestList,
  removeLine,
  ruleLabel,
  ruleTone,
  serializeTestList,
  setCaseTitle,
  setLineValue,
} from "../features/admin/testList";

const TESTS = ["core", "search", "tasks"] as const;

function readExample(name: (typeof TESTS)[number]): string {
  return readFileSync(path.resolve(__dirname, `../../mcp/bench/ai/tests/${name}.md`), "utf8");
}

function caseByNumber(list: ReturnType<typeof parseTestList>, n: number) {
  const found = list.cases.find((c) => c.number === n);
  if (!found) throw new Error(`no case ${n}`);
  return found;
}

/** Indexes of lines that differ between two line arrays of the same length. */
function changedIndexes(before: string[], after: string[]): number[] {
  expect(after).toHaveLength(before.length);
  return before.flatMap((line, i) => (line === after[i] ? [] : [i]));
}

const CORE = readExample("core");
const CORE_LINES = parseTestList(CORE).lines;

describe("round trip", () => {
  test.each(TESTS)("%s.md serializes back to exactly its own text", (name) => {
    const raw = readExample(name);
    expect(serializeTestList(parseTestList(raw))).toBe(raw);
  });

  test("CRLF input is normalized to LF on parse", () => {
    const list = parseTestList("## 1. A?\r\n\r\n- kind: task\r\n");
    expect(list.lines).toEqual(["## 1. A?", "", "- kind: task", ""]);
    expect(serializeTestList(list)).toBe("## 1. A?\n\n- kind: task\n");
  });

  test("a value with colons and quotes is kept verbatim", () => {
    const list = parseTestList(`## 1. Q?\n\n- must: say "10:30 am": not 11: ok\n`);
    expect(caseByNumber(list, 1).rules[0]).toMatchObject({ key: "must", value: `say "10:30 am": not 11: ok` });
  });

  test("a bullet with an empty value is a key with value ''", () => {
    const list = parseTestList("## 1. Q?\n\n- gate:\n");
    expect(caseByNumber(list, 1).other[0]).toMatchObject({ key: "gate", value: "" });
  });
});

describe("case counts", () => {
  test("core has 19 cases", () => {
    expect(parseTestList(CORE).cases).toHaveLength(19);
  });

  test.each(TESTS)("%s.md has one case per ## n. heading", (name) => {
    const raw = readExample(name);
    const headings = raw.split("\n").filter((line) => /^## \d+\. /.test(line)).length;
    const list = parseTestList(raw);
    expect(list.cases).toHaveLength(headings);
    expect(list.cases.map((c) => c.number)).toEqual(list.cases.map((_, i) => i + 1));
  });

  test("front matter closes before the first case", () => {
    const list = parseTestList(CORE);
    expect(list.lines[list.frontEnd - 1]).toBe("---");
    expect(list.cases[0].headingIndex).toBeGreaterThanOrEqual(list.frontEnd);
  });
});

describe("case classification", () => {
  test("core case 1: kind, description and rules, no person or replies", () => {
    const list = parseTestList(CORE);
    const c = caseByNumber(list, 1);
    expect(c.title).toBe("When's my dentist appointment?");
    expect(c.description).toBe("A lookup from one note.");
    expect(c.person).toBeNull();
    expect(c.kind).toMatchObject({ key: "kind", value: "task" });
    expect(c.replies).toEqual([]);
    expect(c.other).toEqual([]);
    expect(c.rules.map((r) => r.key)).toEqual(["must", "must not"]);
    expect(list.lines[c.rules[0].index]).toBe("- must: say Tuesday, October 13 at 3 pm");
    expect(c.endIndex).toBe(list.lines.findIndex((l, i) => i > c.headingIndex && l.startsWith("## ")));
  });

  test("tasks case 1: person starts and if-asked lines are replies, keys kept in full", () => {
    const c = caseByNumber(parseTestList(readExample("tasks")), 1);
    expect(c.replies.map((r) => r.key)).toEqual([
      "person starts",
      "if asked whether she signs in with Gmail or another email, or sent a link to save her login",
      "if asked to sign in, open a link, or take over the browser",
      "if asked whether to go ahead",
      "if asked which plan she has",
    ]);
    expect(c.replies[0].value).toBe(`"can you make sure my chatgpt is properly set up to use context"`);
    expect(c.replies[3]).toMatchObject({ value: `"Yes, go ahead"` });
    expect(c.rules.find((r) => r.key === "must call")?.value).toBe("read_skill");
  });

  test("a case with an as: line keeps it out of the rules", () => {
    const list = parseTestList(CORE);
    const c = caseByNumber(list, 7);
    expect(c.person).toMatchObject({ key: "as", value: "John" });
    expect(c.rules.some((r) => r.key === "as")).toBe(false);
  });

  test("search cases put expect lines in other", () => {
    const c = caseByNumber(parseTestList(readExample("search")), 1);
    expect(c.other).toEqual([expect.objectContaining({ key: "expect", value: "@maya/health/dentist.md" })]);
    expect(c.rules).toEqual([]);
  });

  test("a ### heading does not end a case", () => {
    const list = parseTestList("## 1. Q?\n\n### sub\n\n- kind: task\n");
    expect(caseByNumber(list, 1).kind).not.toBeNull();
  });

  test("a # heading ends a case", () => {
    const list = parseTestList("## 1. Q?\n\n- kind: task\n\n# Notes\n\n- must: ignored\n");
    const c = caseByNumber(list, 1);
    expect(c.rules).toEqual([]);
    expect(c.endIndex).toBe(list.lines.indexOf("# Notes"));
  });
});

describe("ruleTone", () => {
  test.each([
    ["must", "must"],
    ["must not", "mustNot"],
    ["may", "may"],
    ["judge", "judge"],
    ["must call", "checked"],
    ["must not write", "checked"],
    ["must reach", "checked"],
    ["must not call", "checked"],
  ] as Array<[string, RuleTone]>)("%s is %s", (key, tone) => {
    expect(ruleTone(key)).toBe(tone);
  });

  test("ruleLabel shows the key as written", () => {
    expect(ruleLabel("must not")).toBe("must not");
    expect(ruleLabel("must reach")).toBe("must reach");
  });
});

describe("setLineValue", () => {
  test("changes only the one line and keeps its key", () => {
    const list = parseTestList(CORE);
    const target = caseByNumber(list, 1).rules[0].index;
    const next = setLineValue(list, target, "say Wednesday, October 14 at 3 pm");
    expect(changedIndexes(list.lines, next.lines)).toEqual([target]);
    expect(next.lines[target]).toBe("- must: say Wednesday, October 14 at 3 pm");
    expect(caseByNumber(next, 1).rules[0].value).toBe("say Wednesday, October 14 at 3 pm");
  });

  test("keeps the original indentation", () => {
    const list = parseTestList("## 1. Q?\n\n  - must: a\n");
    const next = setLineValue(list, 2, "b");
    expect(next.lines[2]).toBe("  - must: b");
  });

  test("does not mutate the input list", () => {
    const list = parseTestList(CORE);
    const before = [...list.lines];
    setLineValue(list, caseByNumber(list, 1).rules[0].index, "changed");
    expect(list.lines).toEqual(before);
  });

  test("rejects a line that is not a bullet", () => {
    const list = parseTestList(CORE);
    expect(() => setLineValue(list, caseByNumber(list, 1).headingIndex, "x")).toThrow();
  });
});

describe("setCaseTitle", () => {
  test("rewrites only the heading", () => {
    const list = parseTestList(CORE);
    const next = setCaseTitle(list, 4, "What is the Lisbon flat address?");
    const h = caseByNumber(list, 4).headingIndex;
    expect(changedIndexes(list.lines, next.lines)).toEqual([h]);
    expect(next.lines[h]).toBe("## 4. What is the Lisbon flat address?");
    expect(caseByNumber(next, 4).title).toBe("What is the Lisbon flat address?");
    expect(caseByNumber(next, 4).description).toBe("The notes don't have it.");
  });

  test("throws for an unknown case", () => {
    expect(() => setCaseTitle(parseTestList(CORE), 99, "x")).toThrow();
  });
});

describe("addRule", () => {
  test("lands after the case's last bullet and before the next heading", () => {
    const list = parseTestList(CORE);
    const c = caseByNumber(list, 1);
    const next = addRule(list, 1, "must", "say the reminder is set");
    const at = c.rules[c.rules.length - 1].index + 1;
    expect(next.lines[at]).toBe("- must: say the reminder is set");
    expect(next.lines.slice(0, at)).toEqual(list.lines.slice(0, at));
    expect(next.lines.slice(at + 1)).toEqual(list.lines.slice(at));
    const after = caseByNumber(next, 1);
    expect(after.rules.map((r) => r.key)).toEqual(["must", "must not", "must"]);
    expect(next.lines[after.endIndex]).toBe("## 2. How much of the Lisbon travel fund is still to pay?");
    expect(next.lines[after.endIndex - 1]).toBe("");
  });

  test("with no bullets, goes under the heading and its blank line", () => {
    const list = parseTestList("## 1. Q?\n\nA description.\n\n## 2. Next?\n\n- kind: task\n");
    const next = addRule(list, 1, "must", "say hi");
    expect(next.lines).toEqual([
      "## 1. Q?",
      "",
      "- must: say hi",
      "",
      "A description.",
      "",
      "## 2. Next?",
      "",
      "- kind: task",
      "",
    ]);
    expect(caseByNumber(next, 1).rules[0]).toMatchObject({ key: "must", value: "say hi" });
  });

  test("the first case with no bullets and a blank before the next heading", () => {
    const list = parseTestList("## 1. Q?\n\n## 2. Next?\n\n- kind: task\n");
    const next = addRule(list, 1, "may", "be brief");
    expect(next.lines.slice(0, 5)).toEqual(["## 1. Q?", "", "- may: be brief", "", "## 2. Next?"]);
  });

  test("rejects an empty key", () => {
    expect(() => addRule(parseTestList(CORE), 1, " ", "x")).toThrow();
  });
});

describe("removeLine", () => {
  test("removes exactly one line", () => {
    const list = parseTestList(CORE);
    const target = caseByNumber(list, 1).rules[1].index;
    const next = removeLine(list, target);
    expect(next.lines).toHaveLength(list.lines.length - 1);
    expect(next.lines).toEqual(list.lines.filter((_, i) => i !== target));
    expect(caseByNumber(next, 1).rules.map((r) => r.key)).toEqual(["must"]);
  });

  test("rejects an index outside the file", () => {
    expect(() => removeLine(parseTestList(CORE), 10_000)).toThrow();
  });
});

describe("addCase", () => {
  test("numbers the new case one above the highest", () => {
    const list = addCase(parseTestList(CORE), "Remind me to pay the deposit");
    const added = caseByNumber(list, 20);
    expect(added.title).toBe("Remind me to pay the deposit");
    expect(added.kind).toMatchObject({ value: "task" });
    // The existing lines are untouched; the new case is appended after them.
    expect(list.lines.slice(0, CORE_LINES.length)).toEqual(CORE_LINES);
  });

  test("appends with a blank line, the heading, a blank line and kind, keeping the final newline", () => {
    const base = parseTestList("## 1. Q?\n\n- kind: task\n- must: a\n");
    const next = addCase(base, "Second?");
    expect(serializeTestList(next)).toBe("## 1. Q?\n\n- kind: task\n- must: a\n\n## 2. Second?\n\n- kind: task\n");
  });

  test("a file with no cases starts at 1", () => {
    const list = addCase(parseTestList("# Empty list\n"), "First?");
    expect(list.cases.map((c) => c.number)).toEqual([1]);
    expect(serializeTestList(list)).toBe("# Empty list\n\n## 1. First?\n\n- kind: task\n");
  });

  test("an empty file starts at 1", () => {
    expect(serializeTestList(addCase(parseTestList(""), "First?"))).toBe("## 1. First?\n\n- kind: task\n");
  });
});

describe("a file with no front matter and no cases", () => {
  test("parses to frontEnd 0 and no cases, and round-trips", () => {
    const raw = "# Just a note\n\nNothing to test here.\n";
    const list = parseTestList(raw);
    expect(list.frontEnd).toBe(0);
    expect(list.cases).toEqual([]);
    expect(serializeTestList(list)).toBe(raw);
  });

  test("front matter without a closing fence is not front matter", () => {
    const list = parseTestList("---\ntitle: x\n## 1. Q?\n- kind: task\n");
    expect(list.frontEnd).toBe(0);
  });
});

describe("edits are immutable", () => {
  test("every edit leaves the input list unchanged", () => {
    const list = parseTestList(CORE);
    const snapshot = serializeTestList(list);
    setCaseTitle(list, 1, "New?");
    addRule(list, 1, "may", "x");
    removeLine(list, 0);
    addCase(list, "Y?");
    expect(serializeTestList(list)).toBe(snapshot);
  });
});
