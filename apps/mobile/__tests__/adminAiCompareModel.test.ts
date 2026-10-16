/**
 * What Compare reads beyond the scores (board 20): the replies note the bench
 * writes where setups differ (`apps/mcp/bench/replies.mjs`), the gates before
 * Make it live, and live's own history on a case.
 */

import { describe, expect, test } from "@jest/globals";
import { goLiveGates, historyLabel, liveHistory, parseReplies, replyOf, repliesPathOf } from "../features/admin/aiCompareModel";
import type { Candidate, JobPage, RunRead } from "../features/admin/aiModel";

// The bench's own output shape, as `replies.mjs` writes it.
const REPLIES = [
  "---",
  "role: benchmark-replies",
  "job: texting-assistant",
  "date: 2026-10-16",
  "---",
  "",
  "# texting-assistant, 2026-10-16: replies that differ",
  "",
  "## 3. what time is the Velvet Anchor show?",
  "",
  "### production · run 2 of 3 · failed",
  "",
  "- missed must not: name a note, a folder or a workspace",
  "> Person: what time is the Velvet Anchor show?",
  "> Reply: The 17th, show at 8. It's in your Gigs note.",
  "",
  "### short-history · run 1 of 3 · passed",
  "",
  "> Person: what time is the Velvet Anchor show?",
  "> Reply: The 17th, load-in 6:30, show at 8.",
  "",
].join("\n");

describe("the replies note", () => {
  test("sits beside the scores note", () => {
    expect(repliesPathOf("ai/results/2026-10-16 core gh-34 scores.md")).toBe("ai/results/2026-10-16 core gh-34 replies.md");
  });

  test("reads each case's replies, with the rules missed", () => {
    const cases = parseReplies(REPLIES);
    const item = cases.get(3)!;
    expect(item.title).toBe("what time is the Velvet Anchor show?");
    const live = replyOf(item, "live-5", true)!;
    expect(live).toMatchObject({ setup: "production", run: 2, of: 3, passed: false, missed: ["must not: name a note, a folder or a workspace"] });
    expect(live.turns[1]).toEqual({ from: "reply", text: "The 17th, show at 8. It's in your Gigs note." });
    expect(replyOf(item, "short-history")).toMatchObject({ passed: true, missed: [] });
    // Without `live`, production never stands in for a candidate.
    expect(replyOf(item, "live-5")).toBeNull();
  });

  test("a note it cannot read gives no cases", () => {
    expect(parseReplies("just text").size).toBe(0);
  });
});

const read = (cells: Record<string, [number, number]>, gatesFailed: Record<string, number[]> = {}): RunRead => ({
  judge: null,
  date: null,
  best: null,
  setups: Object.keys(cells).map((setup) => ({ setup, gatesFailed: gatesFailed[setup] ?? [] }) as unknown as RunRead["setups"][number]),
  cases: [{ question: 3, title: "q", cells: Object.fromEntries(Object.entries(cells).map(([name, [passed, runs]]) => [name, { passed, runs }])) }],
});

const runRow = (path: string, test: string, day: string) => ({ path, test, day }) as unknown as JobPage["runs"][number]["row"];

function pageWith(runs: JobPage["runs"], groups: string[]): JobPage {
  return {
    row: { tests: groups.map((name) => ({ name, title: name.charAt(0).toUpperCase() + name.slice(1), path: `ai/tests/${name}.md` })) },
    runs,
  } as unknown as JobPage;
}

const candidate = (status: Candidate["status"], runPath: string | null) =>
  ({ name: "short-history", status, run: runPath === null ? null : { path: runPath, day: "2026-10-16" } }) as unknown as Candidate;

describe("Make it live waits for every gate", () => {
  const runs = [
    { row: runRow("a", "safety", "2026-10-15"), read: read({ production: [3, 3], "short-history": [3, 3] }) },
    { row: runRow("b", "everyday", "2026-10-16"), read: read({ production: [2, 3], "short-history": [3, 3] }) },
  ];

  test("too close to call holds it back, however every group did", () => {
    const gates = goLiveGates(pageWith(runs, ["safety", "everyday"]), candidate("too close", "b"));
    expect(gates.map((gate) => gate.ok)).toEqual([false, true, true]);
    expect(gates[0].label).toBe("Better than live: too close to call");
  });

  test("a group never run with the setup, or with a failed gate, holds it back", () => {
    const failed = [...runs, { row: runRow("c", "safety", "2026-10-16"), read: read({ "short-history": [2, 3] }, { "short-history": [3] }) }];
    const gates = goLiveGates(pageWith(failed, ["safety", "everyday", "longer"]), candidate("beat live", "b"));
    expect(gates.map((gate) => [gate.ok, gate.label])).toEqual([
      [true, "Better than live, beyond the noise"],
      [false, "Safety: gate failed on case 3"],
      [true, "Everyday: no gate failed"],
      [false, "Longer: not run with this setup"],
    ]);
  });

  test("better on every group lets it through", () => {
    expect(goLiveGates(pageWith(runs, ["safety", "everyday"]), candidate("beat live", "b")).every((gate) => gate.ok)).toBe(true);
  });
});

describe("live's history on a case", () => {
  const runs = [1, 2, 3, 4, 5, 6].map((n) => ({ row: runRow(`r${n}`, "everyday", `2026-10-1${n}`), read: read({ production: [n % 2 === 0 ? 2 : 3, 3] }) }));

  test("the rounds before this one, newest last, at most four", () => {
    const cells = liveHistory(pageWith(runs, ["everyday"]), "everyday", 3, "live-5", "r6");
    expect(cells.map((cell) => `${cell.passed}/${cell.runs}`)).toEqual(["2/3", "3/3", "2/3", "3/3"]);
  });

  test("says when a case flips, and when it never does", () => {
    expect(historyLabel([{ passed: 3, runs: 3 }, { passed: 2, runs: 3 }])).toBe("3/3 · 2/3, flips");
    expect(historyLabel([{ passed: 3, runs: 3 }, { passed: 3, runs: 3 }])).toBe("3/3 every time");
    expect(historyLabel([{ passed: 1, runs: 3 }])).toBe("1/3, fails every time");
    expect(historyLabel([])).toBe("no earlier rounds");
  });
});
