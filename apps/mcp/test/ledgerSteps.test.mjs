// Every step of a turn leaves its input, output, time and outcome in the chat's
// ledger (Dev2, 2026-11-13: "every step should log its input output time and
// stuff, we need to be able to replay everything and track bugs and regressions").
import { test } from "node:test";
import assert from "node:assert/strict";

import { texLedger } from "../src/texStore/ledger.js";
import { ledgerObserver, stepEntry, stepLog, STEP_NAMES, MAX_RESULT_CHARS } from "../src/agent/ledger.js";
import { durableSql } from "./texStoreFixture.mjs";
import { loggedCardCheck } from "../src/agent/pictureMaker.js";

test("a step entry keeps its name, outcome, milliseconds, input and output, and the ledger takes the kind", () => {
  const entry = stepEntry({ step: "router", ms: 41.6, input: "what's on today", output: { tier: "main", pick: "main" }, model: "claude-haiku" }, { turn: "turn-1", at: 5 });
  assert.equal(entry.kind, "step");
  assert.equal(entry.step, "router");
  assert.equal(entry.turn, "turn-1");
  assert.equal(entry.ok, true);
  assert.equal(entry.ms, 42);
  assert.equal(entry.input, "what's on today");
  assert.deepEqual(entry.output, { tier: "main", pick: "main" });
  const ledger = texLedger(durableSql());
  ledger.append("texts", [entry]);
  assert.equal(ledger.read("texts").entries[0].step, "router", "the ledger refuses no step entry");
});

test("a step's input is kept like a tool's arguments: a value named like a secret is hidden, a huge one is cut", () => {
  const kept = stepEntry({ step: "card", input: { password: "hunter2", fields: { title: "x" } }, output: "y".repeat(MAX_RESULT_CHARS * 2) });
  assert.equal(kept.input.password, "[hidden]");
  assert.equal(kept.input.fields.title, "x");
  assert.ok(kept.output.length < MAX_RESULT_CHARS);
});

test("an unknown step name writes nothing, so a typo is never a new step", () => {
  assert.equal(stepEntry({ step: "made_up" }), null);
  assert.ok(STEP_NAMES.has("router") && STEP_NAMES.has("fallback") && STEP_NAMES.has("lane"));
});

test("the turn's router pick, fallback and steer reach the ledger as steps", () => {
  const written = [];
  const observe = ledgerObserver({ write: (entry) => written.push(entry) }, null, { turn: "t1" });
  observe({ kind: "model", step: "router", model: "opus", ms: 12, input: "plan my week", output: { tier: "think", pick: "think" }, reason: "the router judged it needs thinking" });
  observe({ kind: "model", step: "fallback", model: "sonnet", ms: 900, input: { from: "opus", status: 529 }, output: { model: "sonnet" } });
  observe({ kind: "model", model: "haiku", reason: "to carry out the plan" });
  observe({ kind: "steered", text: "actually make it Friday" });
  assert.deepEqual(written.map((e) => [e.kind, e.step, e.turn]), [["step", "router", "t1"], ["step", "fallback", "t1"], ["step", "model", "t1"], ["step", "steer", "t1"]]);
  assert.equal(written[0].input, "plan my week");
  assert.deepEqual(written[0].output, { tier: "think", pick: "think" });
  assert.equal(written[1].input.status, 529);
  assert.equal(written[3].input, "actually make it Friday");
});

test("stepLog times a step, keeps what it gave, and keeps a throw as a failed step without swallowing it", async () => {
  const written = [];
  const steps = stepLog({ write: (entry) => written.push(entry) }, { turn: "t2" });
  const value = await steps.timed("classifier", { lines: 2 }, async () => ({ thread: "trip" }));
  assert.deepEqual(value, { thread: "trip" });
  await assert.rejects(steps.timed("selfreview", "q", async () => { throw new Error("model down"); }), /model down/);
  assert.deepEqual(written.map((e) => [e.step, e.ok, e.turn]), [["classifier", true, "t2"], ["selfreview", false, "t2"]]);
  assert.deepEqual(written[0].output, { thread: "trip" });
  assert.equal(written[1].reason, "model down");
  assert.ok(Number.isFinite(written[0].ms));
});

test("stepLog with no writer only runs the step, and a writer that throws never stops it", async () => {
  assert.equal(await stepLog(null).timed("lane", null, async () => 3), 3);
  const broken = stepLog({ write: () => { throw new Error("full"); } });
  assert.equal(await broken.timed("lane", null, async () => 4), 4);
});

test("the card check is a step: the tool and template it looked at, never the picture, and its verdict", async () => {
  const written = [];
  const check = loggedCardCheck(stepLog({ write: (entry) => written.push(entry) }, { turn: "t3" }), async () => ({ send: false, critique: "The date is missing." }));
  const verdict = await check({ tool: "draw_picture", template: "event", picture: { data: "AAAA", mediaType: "image/png" } });
  assert.deepEqual(verdict, { send: false, critique: "The date is missing." });
  assert.equal(written[0].step, "card");
  assert.deepEqual(written[0].input, { tool: "draw_picture", template: "event", unpinned: [] });
  assert.deepEqual(written[0].output, { send: false, critique: "The date is missing." });
  assert.ok(!JSON.stringify(written[0]).includes("AAAA"), "the picture's bytes are never kept");
  assert.equal(loggedCardCheck(null, null), null);
});
