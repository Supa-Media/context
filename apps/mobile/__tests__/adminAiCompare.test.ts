/**
 * The AI tab's compare page (`features/admin/AiCompare.tsx`, board 10): the
 * verdict line, which cases a candidate fixes or breaks against live, and the
 * production note a promotion writes. Pure: the notes are fake rows shaped the
 * way `folderNotes` answers them, and the scores text is what the bench writes.
 */

import { describe, expect, test } from "@jest/globals";
import { buildCatalog, type FolderNote } from "../features/admin/aiCatalog";
import { jobPage, liveFrom, promotedText, readRun, type RunRead } from "../features/admin/aiModel";
import type { AiNoteRow } from "../features/admin/aiCatalog";
import { verdict } from "../features/admin/AiCompare";

const SCORES = [
  "# texting-assistant, 2026-10-14: scores",
  "",
  "## Scored by claude-sonnet-5, 2026-10-14",
  "",
  "| setup | score | gates | judge lines | price | speed | texts | errors | good enough |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| live-5 | 93.3% | failed (q5) | 203 of 225 (90.2%) | $0.0177 | 6.6 s | 1.2 | 0 | no |",
  "| live-6 | 100% | passed | 225 of 225 (100%) | $0.0170 | 6.6 s | 1.2 | 0 | yes |",
  "",
  "Why gates failed, live-5:",
  '- q5 must not "invent a to-do that isn\'t in the notes": 1 of 3 runs',
  "",
  "### Case by case",
  "",
  "| case | live-5 | live-6 |",
  "| --- | --- | --- |",
  "| 1. When's my dentist appointment? | 3 of 3 | 3 of 3 |",
  "| 5. what do I need to do before lisbon | 2 of 3 | 3 of 3 |",
  "",
  "## Summary",
  "",
].join("\n");

/** The same round without the case-by-case table, as rounds scored before it was written read. */
const OLD_SCORES = SCORES.slice(0, SCORES.indexOf("### Case by case")) + "## Summary\n";

const PRODUCTION = "---\njob: texting-assistant\nfrom: live-5\nlive_since: 2026-10-10\npromoted_by: Maya\n---\n\nTex's live prompt\n";

function catalogWith() {
  const notes: FolderNote[] = [
    { path: "ai/production/texting-assistant.md", size: 27661, props: JSON.stringify({ properties: { from: "live-5", live_since: "2026-10-10", promoted_by: "Maya" }, heading: "", lede: "" }) },
    {
      path: "ai/setups/texting-assistant/live-6.md",
      size: 27621,
      props: JSON.stringify({ properties: { job: "texting-assistant", based_on: "live-5", change: "one bullet rule", made_by: "improver" }, heading: "", lede: "" }),
    },
    { path: "ai/tests/core.md", props: JSON.stringify({ properties: { job: "texting-assistant" }, heading: "", lede: "" }) },
    { path: "ai/results/2026-10-14 core scores.md", updatedAt: 1, props: JSON.stringify({ properties: {}, heading: "", lede: "" }) },
  ];
  return buildCatalog(notes);
}

function pageWith(scores: string | null) {
  const catalog = catalogWith();
  const reads = new Map<string, RunRead>();
  if (scores !== null) reads.set("ai/results/2026-10-14 core scores.md", readRun(scores)!);
  const page = jobPage(catalog, "texting-assistant", reads);
  const candidate = page!.candidates.find((item) => item.name === "live-6")!;
  return { candidate, read: reads.get("ai/results/2026-10-14 core scores.md") ?? null };
}

describe("verdict", () => {
  test("a candidate that fixes case 5 and breaks nothing says so, with size, cost and speed beside live", () => {
    const { candidate, read } = pageWith(SCORES);
    const line = verdict(candidate, read, "live-5");
    expect(line.lead).toBe("live-6 fixes case 5 and breaks nothing.");
    // Runs passed are on "How sure"; the line does not repeat one group's percentage.
    expect(candidate.livePassed).not.toBeNull();
    expect(line.rest).toBe(" 10 tokens shorter · same cost and speed.");
  });

  test("a candidate that breaks a case says which", () => {
    const worse = SCORES.replace("| 1. When's my dentist appointment? | 3 of 3 | 3 of 3 |", "| 1. When's my dentist appointment? | 3 of 3 | 2 of 3 |");
    const { candidate, read } = pageWith(worse);
    expect(verdict(candidate, read, "live-5").lead).toBe("live-6 fixes case 5 and breaks case 1.");
  });

  test("a round scored before the case table is read from its failed gates", () => {
    const { candidate, read } = pageWith(OLD_SCORES);
    expect(read?.cases).toBeNull();
    expect(verdict(candidate, read, "live-5").lead).toBe("live-6 fixes case 5 and breaks nothing.");
  });

  test("a candidate with no score yet is not compared", () => {
    const { candidate, read } = pageWith(null);
    expect(verdict(candidate, read, "live-5")).toEqual({ lead: "live-6 has not been run beside live yet.", rest: "" });
  });
});

describe("promotedText", () => {
  test("the production note keeps the setup's prompt and models, drops its own bookkeeping, and records who promoted it", () => {
    const setup = "---\njob: texting-assistant\nbased_on: live-5\nchange: x\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nPrompt body\n";
    const out = promotedText(setup, { job: "texting-assistant", from: "live-6", day: "2026-10-16", by: "Maya" });
    const front = out.split("\n---")[0]!;
    expect(out.startsWith("---\n")).toBe(true);
    expect(front).toContain("job: texting-assistant");
    expect(front).toContain("models:\n  main: anthropic/claude-haiku-5-5");
    expect(front).toContain("from: live-6");
    expect(front).toContain("live_since: 2026-10-16");
    expect(front).toContain("promoted_by: Maya");
    expect(front).not.toContain("based_on");
    expect(front).not.toContain("change:");
    expect(out).toContain("Prompt body");
  });

  test("a live note's own front matter is replaced, not duplicated", () => {
    const out = promotedText(PRODUCTION.replace("job: texting-assistant\n", ""), { job: "texting-assistant", from: "live-6", day: "2026-10-16", by: "Maya" });
    expect(out.match(/^from: /gm)).toHaveLength(1);
    expect(out.match(/^job: /gm)).toHaveLength(1);
  });
});

describe("liveFrom", () => {
  const row = (properties: Record<string, unknown>) => ({ properties }) as unknown as AiNoteRow;
  test("reads from:, else the last setup came_from names", () => {
    expect(liveFrom(row({ from: "live-6", came_from: "setups/texting-assistant/live-5" }))).toBe("live-6");
    expect(
      liveFrom(row({ came_from: "setups/texting-assistant/skills-haiku (PR #1), plus setups/texting-assistant/live-5-2026-10-14's body (2026-10-14)" })),
    ).toBe("live-5-2026-10-14");
    expect(liveFrom(row({ came_from: "a person's say-so" }))).toBeNull();
    expect(liveFrom(null)).toBeNull();
  });
});
