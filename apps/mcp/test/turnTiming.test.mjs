// Where one Tex turn's time went, kept with its reply (Dev, 2026-11-03: "I
// need to be able to look at an interaction with Tex and tell exactly why
// things might be slow"): the reply entry's `timing` block, each thinking
// entry's round cost, and the turn's id on every Analytics Engine point so
// one turn can be found there too.
//
// Sabotage checks: drop `timing: turnTiming(...)` from the reply in
// `route.js` and the first test fails; drop `tex.turn = ledgerTurn` and the
// last one does.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../src/agent/ledger.js";
import { turnTiming } from "../src/agent/turnTiming.js";

const CHAT = "sendblue:line:+15555550100";
const ledgerOf = (world) => ledgerFor(world.env, { person: "ws_egress" });
const dataset = () => {
  const points = [];
  return { points, writeDataPoint: (point) => points.push(point) };
};

test("a texted turn's reply keeps where its time went: the wait, each step, each model round with its tokens, each tool", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const text = { id: `${now - 3_000}-000001`, at: now - 3_000, chat: CHAT, from: { kind: "person" }, kind: "text", text: "when is my dentist" };
    world.model.install([
      { thinking: "Their calendar or notes would say.", toolCalls: [{ name: "search", args: { query: "dentist" } }], usage: { input_tokens: 250, output_tokens: 900, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 400 } },
      { text: "Tuesday at 3.", usage: { input_tokens: 1_200, output_tokens: 40, cache_read_input_tokens: 9_400 } },
    ]);
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: text.text, conversation: "texts", covers: [text.id], chat: CHAT, recent: [text], turn: "turn-timing-0001", arrivedAt: now - 1_500, worker: { sessionMs: 412.4, beforeAskMs: 37, phone: "+15555550100" } });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const { entries } = await ledgerOf(world).read(ONE_TO_ONE_CHAT);
    const reply = entries.find((entry) => entry.kind === "reply");
    const { timing } = reply;
    assert.equal(timing.v, 2);
    assert.ok(timing.rounds.every((r) => r.prompt?.modules?.[0]?.id?.startsWith("stable/") && r.prompt.inputs.at > 0), "each round names the prompt it was sent (`promptManifest.js`)");
    assert.ok(timing.waitMs >= 1_400 && timing.waitMs < 60_000, `the wait before the gateway: ${timing.waitMs}`);
    assert.ok(timing.replyMs >= 0);
    assert.deepEqual(timing.worker, { sessionMs: 412, beforeAskMs: 37 }, "the Worker's own wait inside it, numbers only (Dev, 2026-11-04)");
    const names = timing.steps.map((step) => step.name);
    for (const step of ["read_request", "wait:history", "model"]) assert.ok(names.includes(step), `${step} in ${names.join()}`);
    assert.ok(!names.some((step) => step.startsWith("after:") || step === "to_response"), "only what the person waited for");
    assert.equal(timing.rounds.length, 2, "one per model call");
    assert.deepEqual([timing.rounds[0].input, timing.rounds[0].output, timing.rounds[0].cacheRead, timing.rounds[0].cacheWrite, timing.rounds[0].calls], [250, 900, 9_000, 400, 1]);
    assert.deepEqual([timing.rounds[1].output, timing.rounds[1].said, timing.rounds[1].calls], [40, "Tuesday at 3.".length, 0]);
    assert.equal(timing.tools.length, 1);
    assert.match(timing.tools[0].name, /^search/);
    const model = timing.steps.find((step) => step.name === "model");
    assert.ok(timing.rounds[0].at >= model.at && timing.rounds[0].at <= timing.tools[0].at && timing.tools[0].at <= timing.rounds[1].at, "on the turn's own clock, in the order they ran");
    assert.ok(timing.rounds[1].at + timing.rounds[1].ms <= timing.replyMs, "all before the reply was ready");
    assert.doesNotMatch(JSON.stringify(timing), /dentist|Tuesday|calendar|5555550100/, "names and numbers, never a word");
    const thinking = entries.find((entry) => entry.kind === "thinking");
    assert.equal(thinking.output, 900, "a thinking entry says what its round cost");
    assert.equal(typeof thinking.ms, "number");
    const slim = await ledgerOf(world).read(ONE_TO_ONE_CHAT, { slim: true, kinds: ["reply"] });
    assert.equal(slim.entries[0].timing, undefined, "a turn's own reads never carry it");
  } finally {
    world.restore();
  }
});

test("every timing point of a turn carries its id, so one turn can be pulled out of each dataset", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "Hey." }]);
    const [TEX_ENTRY, TEX_TIMING, TEX_CALLS] = [dataset(), dataset(), dataset()];
    const env = { ...world.env, TEX_ENTRY, TEX_TIMING, TEX_CALLS };
    const asked = await request(env, TOKEN_TEXTS, "/agent", { question: "hi", conversation: "texts", chat: CHAT, turn: "turn-timing-0002" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.ok(TEX_ENTRY.points.length > 3);
    assert.ok(TEX_ENTRY.points.every((point) => point.blobs[4] === "turn-timing-0002"), "every step, including the ones before the id was read");
    assert.equal(TEX_TIMING.points[0].blobs.at(-1), "turn-timing-0002");
    assert.equal(TEX_CALLS.points[0].blobs[3], "turn-timing-0002");
  } finally {
    world.restore();
  }
});

test("the block keeps names and numbers, moves the loop's offsets onto the turn's clock, and is capped", () => {
  const timing = turnTiming({
    steps: [
      { name: "read_request", at: 2, ms: 3, state: "ok" },
      { name: "kept_files_again", at: 5, ms: 0, state: "off" },
      { name: "model", at: 1_000, ms: 4_000, state: "ok" },
      { name: "to_response", at: 0, ms: 5_100, state: "ok" },
      { name: "after:usage", at: 5_200, ms: 30, state: "ok" },
    ],
    trace: [
      { kind: "router", at: 0, ms: 300, model: "anthropic/claude-haiku-5-5", pick: "words a router wrote" },
      { kind: "fallback", at: 300, ms: 50, ok: true, model: "b", from: "a", status: 529 },
      { kind: "model", at: 350, ms: 2_000, model: "b", ok: true, retried: true, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, said: 0, calls: 1 },
      { kind: "tool", at: 2_350, ms: 700, tool: "search_notes", ok: false },
    ],
    waitMs: 1_200,
    replyMs: 5_050.4,
  });
  assert.deepEqual(timing.steps, [{ name: "read_request", at: 2, ms: 3 }, { name: "kept_files_again", at: 5, ms: 0, state: "off" }, { name: "model", at: 1_000, ms: 4_000 }]);
  assert.deepEqual(timing.router, { at: 1_000, ms: 300, model: "anthropic/claude-haiku-5-5" });
  assert.deepEqual(timing.rounds, [
    { at: 1_300, ms: 50, model: "b", fallback: true },
    { at: 1_350, ms: 2_000, model: "b", retried: true, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, said: 0, calls: 1 },
  ]);
  assert.deepEqual(timing.tools, [{ at: 3_350, ms: 700, name: "search_notes", ok: false }]);
  assert.equal(timing.waitMs, 1_200);
  assert.equal(timing.replyMs, 5_050);
  assert.doesNotMatch(JSON.stringify(timing), /words a router wrote/);
  const long = turnTiming({ steps: Array.from({ length: 500 }, (_, i) => ({ name: `s${i}`, at: i, ms: 1 })), trace: Array.from({ length: 500 }, () => ({ kind: "tool", tool: "x", at: 0, ms: 1 })), replyMs: 1 });
  assert.ok(long.steps.length <= 60 && long.tools.length <= 80, "a long job's turn cannot grow its reply");
  assert.equal(turnTiming({ replyMs: 10 }).waitMs, undefined, "an unknown wait is left out, never 0");
});

test("the Worker's wait keeps only sane milliseconds, and is left out when there are none", () => {
  assert.equal(turnTiming({ replyMs: 1, worker: "slow" }).worker, undefined);
  assert.equal(turnTiming({ replyMs: 1, worker: { sessionMs: -4, beforeAskMs: Infinity } }).worker, undefined);
  assert.deepEqual(turnTiming({ replyMs: 1, worker: { sessionMs: 900.6, beforeAskMs: 99 * 60 * 60 * 1000 } }).worker, { sessionMs: 901 });
});
