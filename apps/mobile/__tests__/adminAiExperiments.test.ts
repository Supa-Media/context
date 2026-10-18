/**
 * The setups list and New experiment (boards 17 and 18 of the AI tools plan;
 * the owner, 2026-10-16: "we should only be showing setups that are live, and
 * setups that are being presently experimented with"), and the honest score
 * the ML review asked for: runs passed with a likely range, and a gap against
 * live that is only called a win when the range clears zero.
 */

import { describe, expect, test } from "@jest/globals";
import {
  archivedSetup,
  experimentPath,
  experimentText,
  gapAgainstLive,
  passedRange,
  runsPassed,
  setupTitle,
  wilson,
} from "../features/admin/aiExperiments";
import type { AiNoteRow } from "../features/admin/aiCatalog";
import { readRun, setupInfo } from "../features/admin/aiModel";

const DAY = 24 * 60 * 60 * 1000;

const row = (path: string, properties: Record<string, unknown> = {}, updatedAt: number | null = null): AiNoteRow => ({
  path,
  name: path.split("/").pop()!.replace(/\.md$/, ""),
  title: "",
  lede: "",
  updatedAt,
  size: null,
  properties,
});

const SCORES = [
  "## Scored by Haiku 5.5, 2026-10-15",
  "",
  "| setup | score | gates | judge lines | price | speed | texts | errors | good enough |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| production | 93.3% | passed | 210 of 225 (93.3%) | $0.0180 | 7.0 s | 1.2 | 0 | yes |",
  "| short-history | 100% | passed | 214 of 225 (95.1%) | $0.0170 | 6.5 s | 1.1 | 0 | yes |",
  "",
  "### Case by case",
  "",
  "| case | production | short-history |",
  "| --- | --- | --- |",
  "| 1. when's the dentist? | 3 of 3 | 3 of 3 |",
  "| 2. what time is the show? | 2 of 3 | 3 of 3 |",
  "| 3. yo | 3 of 3 | 3 of 3 |",
  "",
  "Best setup that passes every bar: short-history.",
].join("\n");

describe("how sure a score is", () => {
  test("a Wilson range holds the published values for 15 of 15 and 14 of 15", () => {
    const [low15, high15] = wilson(15, 15);
    expect(low15).toBeCloseTo(0.796, 3);
    expect(high15).toBe(1);
    const [low14, high14] = wilson(14, 15);
    expect(low14).toBeCloseTo(0.702, 3);
    expect(high14).toBeCloseTo(0.988, 3);
  });

  test("runs passed add up every case's column for a setup, live read as production", () => {
    const run = readRun(SCORES)!;
    expect(runsPassed(run, "short-history")).toEqual({ passed: 9, runs: 9 });
    expect(runsPassed(run, "production")).toEqual({ passed: 8, runs: 9 });
    expect(runsPassed(run, "nobody")).toBeNull();
  });

  test("a range is written as people read it", () => {
    expect(passedRange({ passed: 44, runs: 45 })).toBe("likely 88–99.6%");
    expect(passedRange({ passed: 45, runs: 45 })).toBe("likely 92–100%");
  });

  test("one flipped run is too close to call", () => {
    const gap = gapAgainstLive({ passed: 45, runs: 45 }, { passed: 44, runs: 45 });
    expect(gap.verdict).toBe("too close");
    expect(gap.points).toBeCloseTo(2.2, 1);
    expect(gap.low).toBeLessThan(0);
    expect(gap.high).toBeGreaterThan(0);
  });

  test("a gap whose whole range clears zero is better, and one below it is worse", () => {
    expect(gapAgainstLive({ passed: 45, runs: 45 }, { passed: 30, runs: 45 }).verdict).toBe("better");
    expect(gapAgainstLive({ passed: 30, runs: 45 }, { passed: 45, runs: 45 }).verdict).toBe("worse");
  });
});

describe("a setup's name", () => {
  test("its own title wins, else its file name without the date", () => {
    expect(setupTitle(setupInfo(row("ai/setups/texting-assistant/short-history-2026-10-15.md", { title: "Shorter history" })))).toBe("Shorter history");
    expect(setupTitle(setupInfo(row("ai/setups/texting-assistant/short-history-2026-10-15.md")))).toBe("Short history");
    expect(setupTitle(setupInfo(row("ai/setups/texting-assistant/live-5-2026-10-14.md")))).toBe("Live 5");
  });
});

describe("what the Setups list hides", () => {
  const now = Date.UTC(2026, 9, 16);
  const fresh = setupInfo(row("ai/setups/texting-assistant/vault-skill.md", {}, now - DAY));
  const old = setupInfo(row("ai/setups/texting-assistant/guide-haiku.md", {}, now - 15 * DAY));

  test("retired and lost are archived; a setup nobody touched for 14 days is too, unless it is live", () => {
    expect(archivedSetup({ ...fresh, status: "retired" }, now)).toBe(true);
    expect(archivedSetup({ ...fresh, status: "lost" }, now)).toBe(true);
    expect(archivedSetup({ ...fresh, status: "not run" }, now)).toBe(false);
    expect(archivedSetup({ ...old, status: "not run" }, now)).toBe(true);
    expect(archivedSetup({ ...old, status: "live" }, now)).toBe(false);
  });

  test("a setup that beat live stays in view however old", () => {
    expect(archivedSetup({ ...old, status: "beat live" }, now)).toBe(false);
  });
});

describe("New experiment", () => {
  const live = [
    "---",
    "job: texting-assistant",
    "models:",
    "  main: anthropic/claude-haiku-5-5",
    "from: live-5-2026-10-14",
    "live_since: 2026-10-14",
    "promoted_by: Seyi, 2026-10-14 (event times)",
    "came_from: guide-haiku of round five #1509",
    "---",
    "",
    "You are Tex.",
    "",
  ].join("\n");

  test("copies live's prompt and models, drops how live got there, and says what changes and from what", () => {
    const text = experimentText(live, { job: "texting-assistant", basedOn: "live-5-2026-10-14", change: "Reminders rules move into a skill", by: "Seyi" });
    expect(text).toContain("You are Tex.");
    expect(text).toContain("  main: anthropic/claude-haiku-5-5");
    expect(text).toContain("based_on: live-5-2026-10-14");
    expect(text).toContain("change: Reminders rules move into a skill");
    expect(text).toContain("title: Reminders rules move into a skill");
    expect(text).toContain("made_by: Seyi");
    expect(text).not.toMatch(/^from:|^live_since:|^promoted_by:|^came_from:/m);
  });

  test("a change on two lines is kept to one, so the front matter stays readable", () => {
    const text = experimentText(live, { job: "texting-assistant", basedOn: "live-5", change: "Shorter\nhistory", by: "Seyi" });
    expect(text).toContain("change: Shorter history");
  });

  test("its file is named for the change, and never over one that exists", () => {
    expect(experimentPath("texting-assistant", "Reminders rules move into a skill!", new Set())).toBe("ai/setups/texting-assistant/reminders-rules-move-into-a.md");
    expect(experimentPath("texting-assistant", "Shorter history", new Set(["shorter-history"]))).toBe("ai/setups/texting-assistant/shorter-history-2.md");
    expect(experimentPath("texting-assistant", "…", new Set())).toBe("ai/setups/texting-assistant/experiment.md");
  });
});
