/**
 * WHERE A TURN'S TIME WENT, READABLE BY SQL (`src/agent/turnStages.js`;
 * Dev2, 2026-10-31: "hi Tex" took over three minutes one to one, and Haiku
 * answered in two seconds of it).
 *
 * Sabotage (temporary local edits, reverted):
 *  - `.finally(() => stages.flush())` dropped from `handleAgent`: "a texted
 *    turn writes one point" fails;
 *  - `stages?.ran(report)` dropped from `logTurn`: the same test fails (no
 *    outcome, no rounds).
 *  - the `[[analytics_engine_datasets]]` block dropped from `wrangler.toml`:
 *    "both deployments bind TEX_TIMING" fails. It was missing from #2496 to
 *    2026-10-31, so every point went nowhere and a 78-second "hi" could not be
 *    taken apart.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { COLUMNS, STAGES, stagesOf, turnStages } from "../src/agent/turnStages.js";
import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

test("the steps before the model, the model, the tools and the time after it add up, in columns", () => {
  const point = stagesOf({
    start: 1_000,
    marks: { provider: 1_100, tools: 1_200, history: 1_500, web: 1_600, setup: 1_700, skills: 1_800, pictures: 1_900, ready: 91_000 },
    end: 146_000,
    report: { kind: "texts", outcome: "answered", ms: 95_000, waitMs: 3_000, modelMs: 2_200, toolMs: 0, rounds: 1, trace: [{ kind: "round", ms: 2_200, retried: true }] },
  });
  assert.deepEqual(point.blobs, ["texts", "answered"]);
  const row = Object.fromEntries(COLUMNS.map((name, i) => [name, point.doubles[i]]));
  assert.equal(point.doubles.length, COLUMNS.length);
  assert.equal(row.waitMs, 3_000);
  assert.equal(row.providerMs, 100);
  assert.equal(row.historyMs, 300);
  assert.equal(row.readyMs, 89_100, "the slow step before the model shows as its own column");
  assert.equal(row.modelMs, 2_200);
  assert.equal(row.otherTurnMs, 95_000 - 90_000 - 2_200, "the turn's own time beside the model");
  assert.equal(row.afterMs, 50_000, "from the answer to the response");
  assert.equal(row.totalMs, 148_000);
  assert.equal(row.retriedRounds, 1);
  assert.equal(row.slowestRoundMs, 2_200);
});

test("a step the turn never reached is zero, and the next one counts from the last it did", () => {
  const point = stagesOf({ start: 0, marks: { provider: 10, setup: 50, ready: 60 }, end: 100, report: null });
  const row = Object.fromEntries(COLUMNS.map((name, i) => [name, point.doubles[i]]));
  assert.equal(row.toolsMs, 0);
  assert.equal(row.setupMs, 40);
  assert.equal(row.readyMs, 10);
  assert.deepEqual(point.blobs, ["unknown", "unfinished"]);
});

test("no binding writes nothing, a binding that throws never fails the turn, and a point is written once", () => {
  assert.equal(turnStages({}).flush(), null);
  const throwing = turnStages({ TEX_TIMING: { writeDataPoint() { throw new Error("down"); } } });
  assert.doesNotThrow(() => throwing.flush());
  const points = [];
  const stages = turnStages({ TEX_TIMING: { writeDataPoint: (p) => points.push(p) } });
  stages.flush();
  stages.flush();
  assert.equal(points.length, 1);
});

test("a texted turn writes one point, with a kind and numbers only, never their words", async () => {
  const world = await createEgressWorld();
  const points = [];
  try {
    world.model.install([{ text: "Hey. What do you need?" }]);
    const env = { ...world.env, TEX_TIMING: { writeDataPoint: (point) => points.push(point) } };
    const asked = await request(env, TOKEN_TEXTS, "/agent", { question: "hi Tex", conversation: "texts" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(points.length, 1);
    const [point] = points;
    assert.equal(point.blobs[1], "answered");
    const row = Object.fromEntries(COLUMNS.map((name, i) => [name, point.doubles[i]]));
    assert.equal(row.rounds, 1);
    assert.ok(point.doubles.every((value) => typeof value === "number" && value >= 0));
    assert.equal(STAGES.length + 9, COLUMNS.length);
    assert.doesNotMatch(JSON.stringify(point), /hi Tex|What do you need/);
  } finally {
    world.restore();
  }
});

test("both deployments bind TEX_TIMING, so the points are kept and can be read back", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /\[\[analytics_engine_datasets\]\]\s*binding = "TEX_TIMING"\s*dataset = "tex_timing"/);
  assert.match(toml, /\[\[env\.staging\.analytics_engine_datasets\]\]\s*binding = "TEX_TIMING"\s*dataset = "tex_timing_staging"/);
});
