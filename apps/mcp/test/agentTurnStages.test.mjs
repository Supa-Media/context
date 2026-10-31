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
 *  - `usage`/`said`/`calls` dropped from the round's trace entry in `turn.js`:
 *    "each model call writes its own point" fails (the tokens read 0);
 *  - `timing?.trace` dropped from `stages?.ran` in `route.js`: the same test
 *    fails, since the turn log's wired trace carries no tokens.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CALL_COLUMNS, callPoints, callsLine, COLUMNS, keyShape, MAX_CALL_POINTS, STAGES, stagesOf, turnStages } from "../src/agent/turnStages.js";
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
    assert.equal(STAGES.length + 11, COLUMNS.length);
    assert.doesNotMatch(JSON.stringify(point), /hi Tex|What do you need/);
    // The bucket calls by stage: shapes and counts only, no id, workspace or name (`callsLine`).
    assert.match(point.blobs[2], /^([bta]:(get|head|put|delete|list):[^ =]+=\d+ ?)+$/);
    assert.match(point.blobs[2], /\bb:list:\.context\/approvals\/pending=\d/, "the calls before the model are counted by shape");
    assert.doesNotMatch(point.blobs[2], /ws_|grant_|[0-9a-f]{8}-[0-9a-f]{4}/);
  } finally {
    world.restore();
  }
});

test("a key's shape blanks ids and names, and the line keeps the busiest first", () => {
  assert.equal(keyShape(".context/agent/pending/0b8a7c1e-1111-2222-3333-444455556666.json"), ".context/agent/pending");
  assert.equal(keyShape("notes/n_123abc.md"), "notes/*");
  assert.equal(keyShape("tex/Seyi Smith/notes/x.md"), "tex/*/notes");
  assert.equal(keyShape(undefined), "?");
  assert.equal(callsLine({ "a:get:notes/*": 2, "b:list:.context/agent/pending": 31 }), "b:list:.context/agent/pending=31 a:get:notes/*=2");
});

test("both deployments bind TEX_TIMING, so the points are kept and can be read back", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /\[\[analytics_engine_datasets\]\]\s*binding = "TEX_TIMING"\s*dataset = "tex_timing"/);
  assert.match(toml, /\[\[env\.staging\.analytics_engine_datasets\]\]\s*binding = "TEX_TIMING"\s*dataset = "tex_timing_staging"/);
});

test("each model call writes its own point: its time, tokens and cache, and nothing it said", async () => {
  const world = await createEgressWorld();
  const calls = [];
  const turns = [];
  try {
    world.model.install([
      { text: "Looking.", toolCalls: [{ name: "search", args: { query: "dentist" } }], usage: { input_tokens: 250, output_tokens: 900, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 400 } },
      { text: "Tuesday at 3.", usage: { input_tokens: 1_200, output_tokens: 40, cache_read_input_tokens: 9_400 } },
    ]);
    const env = { ...world.env, TEX_TIMING: { writeDataPoint: (point) => turns.push(point) }, TEX_CALLS: { writeDataPoint: (point) => calls.push(point) } };
    const asked = await request(env, TOKEN_TEXTS, "/agent", { question: "when is my dentist", conversation: "texts" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(turns.length, 1, "the turn's own point still goes");
    assert.equal(calls.length, 2, "one point per model round");
    const rows = calls.map((point) => Object.fromEntries(CALL_COLUMNS.map((name, i) => [name, point.doubles[i]])));
    assert.deepEqual([rows[0].round, rows[0].input, rows[0].cacheRead, rows[0].cacheWrite, rows[0].output, rows[0].said, rows[0].calls], [1, 250, 9_000, 400, 900, "Looking.".length, 1]);
    assert.deepEqual([rows[1].round, rows[1].input, rows[1].cacheRead, rows[1].cacheWrite, rows[1].output, rows[1].calls], [2, 1_200, 9_400, 0, 40, 0]);
    assert.equal(calls[0].blobs[0], turns[0].blobs[0], "the call carries its turn's kind");
    assert.equal(calls[0].blobs[2], "ok");
    assert.doesNotMatch(JSON.stringify(calls), /dentist|Tuesday|Looking/);
  } finally {
    world.restore();
  }
});

test("call points skip tools and the router, cap their count, and read a missing count as 0", () => {
  const trace = [{ kind: "router", ms: 5 }, { kind: "model", model: "anthropic/claude-haiku-5-5", ms: 3_000, usage: { input: 10, output: -1 } }, { kind: "tool", tool: "search", ms: 40 }, { kind: "model", ok: false, ms: 9 }];
  const points = callPoints("one", trace);
  assert.equal(points.length, 2);
  assert.deepEqual(points[0].blobs, ["one", "claude-haiku-5-5", "ok"]);
  assert.deepEqual(points[0].doubles, [1, 3_000, 10, 0, 0, 0, 0, 0]);
  assert.deepEqual(points[1].blobs, ["one", "unknown", "failed"]);
  assert.equal(callPoints("job", Array.from({ length: 40 }, () => ({ kind: "model", ms: 1 }))).length, MAX_CALL_POINTS);
});

test("both deployments bind TEX_CALLS", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /\[\[analytics_engine_datasets\]\]\s*binding = "TEX_CALLS"\s*dataset = "tex_model_calls"/);
  assert.match(toml, /\[\[env\.staging\.analytics_engine_datasets\]\]\s*binding = "TEX_CALLS"\s*dataset = "tex_model_calls_staging"/);
});
