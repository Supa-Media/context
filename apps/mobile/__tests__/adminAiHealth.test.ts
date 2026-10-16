/**
 * A job's prompt health and its case groups on today's live (board 21).
 */

import { describe, expect, test } from "@jest/globals";
import { caseGroupTitle, casesInPrompt, draftedCases, groupsOnLive, repeatedRules } from "../features/admin/aiHealth";
import type { JobPage, RunRead } from "../features/admin/aiModel";

const PROMPT = [
  "---",
  "job: texting-assistant",
  "---",
  "",
  "# Tex",
  "",
  "- Never name a note, a folder or a workspace in a reply.",
  "- Keep replies short enough to read on a lock screen.",
  "Ask before you send anything on the person's behalf. Never name a note, a folder or a workspace in a reply.",
  "When asked about the Velvet Anchor show, say the 17th at 8.",
].join("\n");

const GROUP = [
  "# Everyday",
  "",
  "## 1. what time is the Velvet Anchor show?",
  "- as: Maya",
  "- must: say the 17th at 8",
  "",
  "## 2. tell Sam I'm late",
  "- as: Maya",
  "- must: ask before texting Sam",
  "- drafted: by the improver",
].join("\n");

describe("prompt health", () => {
  test("a sentence written twice is found once, with its count", () => {
    expect(repeatedRules(PROMPT)).toEqual([{ text: "Never name a note, a folder or a workspace in a reply.", times: 2 }]);
  });

  test("a case whose answer the prompt carries word for word is flagged", () => {
    const found = casesInPrompt(PROMPT, [{ title: "Everyday", text: GROUP }]);
    expect(found).toEqual([{ group: "Everyday", number: 1, title: "what time is the Velvet Anchor show?", found: "say the 17th at 8" }]);
  });

  test("a short must line never counts, however common", () => {
    expect(casesInPrompt("Say yes.", [{ title: "G", text: "## 1. hi\n- must: say yes\n" }])).toEqual([]);
  });

  test("drafted cases are counted by group, and a group's title comes from its note", () => {
    expect(draftedCases([{ title: "Everyday", text: GROUP }])).toEqual([{ group: "Everyday", count: 1 }]);
    expect(caseGroupTitle(GROUP, "core")).toBe("Everyday");
    expect(caseGroupTitle(undefined, "core")).toBe("core");
  });
});

describe("case groups on today's live", () => {
  const read = (passed: number, runs: number): RunRead => ({
    judge: null,
    date: null,
    best: null,
    setups: [{ setup: "production" } as RunRead["setups"][number]],
    cases: [{ question: 1, title: "q", cells: { production: { passed, runs } } }],
  });
  const page = {
    live: "live-5",
    row: { tests: ["safety", "everyday", "longer"].map((name) => ({ name, path: `ai/tests/${name}.md` })) },
    runs: [
      { row: { test: "longer", day: "2026-10-10" }, read: read(50, 53) },
      { row: { test: "safety", day: "2026-10-16" }, read: read(90, 90) },
    ],
  } as unknown as JobPage;

  test("a round from before live_since did not measure today's live", () => {
    expect(groupsOnLive(page, "2026-10-14")).toEqual([
      { path: "ai/tests/safety.md", name: "safety", day: "2026-10-16", onLive: true, passed: { passed: 90, runs: 90 } },
      { path: "ai/tests/everyday.md", name: "everyday", day: null, onLive: false, passed: null },
      { path: "ai/tests/longer.md", name: "longer", day: "2026-10-10", onLive: false, passed: { passed: 50, runs: 53 } },
    ]);
  });
});
