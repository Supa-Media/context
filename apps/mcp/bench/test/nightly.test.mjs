/**
 * The nightly scoreboard (`bench/nightly.mjs`), the live drift (`bench/drift.mjs`) and the live prompt's watch
 * (`bench/productionWatch.mjs`): Dev2, 2026-11-13. Fake runs and invented numbers: nothing spent, nobody's words.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  1. `driftOf` alerting on a day of two conversations -> "a quiet day is too few to tell" fails;
 *  2. `changesSince` calling every change AI Promote's -> "a hand edit is outside the gate" fails;
 *  3. `scoreboardNote` printing a held-out case's id -> "held-out cases are named by their cause alone" fails;
 *  4. `runArea` passing a scorer area that passed one run of three -> "a scorer area passes in most of its runs" fails.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { driftLines, driftOf, parseDayScores } from "../drift.mjs";
import { NIGHTLY_AREAS, runArea, scoreboardNote } from "../nightly.mjs";
import { changesSince, fingerprint, productionLines, readFingerprint } from "../productionWatch.mjs";

const TREE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const dayNote = (day, conversations, goal, calm = 8) =>
  [
    "---",
    "source: tex-self-review",
    `day: ${day}`,
    `conversations: ${conversations}`,
    "---",
    "",
    `# Tex conversation scores, ${day}`,
    "",
    "| Measure | Average |",
    "| --- | --- |",
    `| Got them what they wanted | ${goal} |`,
    `| They stayed calm (10 = no frustration) | ${calm} |`,
    "",
    "| What went wrong | Conversations |",
    "| --- | --- |",
    "| wrong | 1 |",
    "",
  ].join("\n");

const week = (goal) => ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"].map((d) => parseDayScores(dayNote(d, 4, goal)));

test("a day's scores note reads as its conversations and measures, and stops at the measures table", () => {
  const day = parseDayScores(dayNote("2026-11-12", 6, 6.5));
  assert.deepEqual(day, { day: "2026-11-12", conversations: 6, measures: { "Got them what they wanted": 6.5, "They stayed calm (10 = no frustration)": 8 } });
  assert.equal(parseDayScores("# not a scores note"), null);
});

test("a drop in one measure past the bar alerts; a steady day does not", () => {
  const dropped = driftOf([...week(7.5), parseDayScores(dayNote("2026-11-12", 6, 5.5))], "2026-11-12");
  assert.equal(dropped.status, "alert");
  assert.deepEqual(dropped.drops.map((d) => d.measure), ["Got them what they wanted"]);
  assert.match(driftLines(dropped).join("\n"), /down from 7\.5/);
  assert.equal(driftOf([...week(7.5), parseDayScores(dayNote("2026-11-12", 6, 7))], "2026-11-12").status, "steady");
});

test("a quiet day is too few to tell", () => {
  assert.equal(driftOf([...week(7.5), parseDayScores(dayNote("2026-11-12", 2, 3))], "2026-11-12").status, "too few");
  assert.equal(driftOf([parseDayScores(dayNote("2026-11-12", 9, 3))], "2026-11-12").status, "too few", "no week before it to hold it against");
});

test("a hand edit is outside the gate; AI Promote's write is not", () => {
  const promoted = "---\njob: texting-assistant\npromoted_by: the benchmark promotion gate (apps/mcp/bench/promote.mjs), 2026-11-13, under a standing approval.\n---\n\nNew prompt.\n";
  const before = fingerprint([
    { path: "ai/production/texting-assistant.md", content: "---\njob: texting-assistant\n---\n\nOld prompt.\n" },
    { path: "ai/production/prompt/how-you-talk.md", content: "Old words.\n" },
    { path: "ai/production/prompt/gone.md", content: "Retired.\n" },
  ]);
  const table = productionLines({ now: before, changes: [], since: "2026-11-12" }).join("\n");
  const was = readFingerprint(table);
  assert.equal(was.size, 3, "the fingerprint table reads back");
  const now = fingerprint([
    { path: "ai/production/texting-assistant.md", content: promoted },
    { path: "ai/production/prompt/how-you-talk.md", content: "New words, typed in by hand.\n" },
    { path: "ai/production/prompt/new.md", content: "Added.\n" },
  ]);
  const changes = changesSince(now, was, "2026-11-12");
  assert.deepEqual(
    changes.map((c) => [c.path, c.change, c.how]),
    [
      ["ai/production/prompt/how-you-talk.md", "changed", "outside the gate"],
      ["ai/production/prompt/new.md", "added", "outside the gate"],
      ["ai/production/texting-assistant.md", "changed", "AI Promote"],
      ["ai/production/prompt/gone.md", "removed", "outside the gate"],
    ],
  );
  assert.match(productionLines({ now, changes, since: "2026-11-12" }).join("\n"), /⚠️ 3 production note\(s\) changed since 2026-11-12 outside the gate/);
  assert.deepEqual(changesSince(now, new Map(), null), [], "the first night has nothing to hold it against");
});

test("held-out cases are named by their cause alone; targets are listed apart and never fail an area", () => {
  const areas = [
    {
      area: "respond",
      status: "fail",
      runsPassed: 1,
      usd: 0.01,
      rows: [
        { id: "g-carpool", right: false, results: [false, false, true], expected: "reach the model", heldOut: false },
        { id: "held-out/tacos-at-noon", right: false, results: [false, false, false], heldOut: true, cause: "a plan between people" },
        { id: "t-known", right: false, results: [false, false, false], target: "answers a day-old text", heldOut: false },
      ],
    },
    { area: "tasks", status: "refused", rows: [], usd: 0, reason: "over the spend cap" },
    { area: "web-facts", status: "missing", rows: [], usd: 0 },
  ];
  const note = scoreboardNote({ date: "2026-11-14", areas, spend: { total: 48, cap: 50 }, drift: null, production: null });
  assert.match(note, /\| respond \| ❌ fail \| 0\/2 \| 0\/2 \| \$0\.01 \|/);
  assert.match(note, /\| tasks \| ⏸ not run: over the spend cap/);
  assert.match(note, /\| web-facts \| — not on main yet/);
  assert.match(note, /`g-carpool` right in 1 of 3 runs; expected to reach the model/);
  assert.match(note, /held-out: 1 about a plan between people/);
  assert.match(note, /\| respond \| `t-known` \(answers a day-old text\) \| 0 of 3 \|/);
  assert.doesNotMatch(note, /tacos/);
});

test("a scorer area passes in most of its runs, and its cases read as one row each", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "nightly-"));
  const respond = NIGHTLY_AREAS.find((spec) => spec.area === "respond");
  let call = 0;
  const flaky = { ...respond, scorer: { ...respond.scorer, passes: () => (call += 1) === 1 } };
  const result = await runArea(flaky, { tree: TREE, dir: null, scratch, fake: true });
  assert.equal(result.status, "fail", "passed one run of three");
  assert.equal(result.runsPassed, 1);
  assert.ok(result.rows.length > 10 && result.rows.every((row) => row.results.length === 3));
  const steady = await runArea(respond, { tree: TREE, dir: null, scratch, fake: true });
  assert.equal(steady.status, "pass");
});

test("a test area that main does not have yet says so instead of failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nightly-folder-"));
  await mkdir(join(dir, "tests"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# Bench\n");
  const result = await runArea(NIGHTLY_AREAS.find((spec) => spec.area === "web-facts"), { tree: TREE, dir, scratch: dir, fake: true });
  assert.equal(result.status, "missing");
});
