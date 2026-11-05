// Decide and the last look asked of Clef in the gateway, over the `TexTexts` entrypoint (src/agent/textsDecide.js; Dev2's
// pick 2026-11-05: decide moves into the gateway, its cap and usage rows kept in the control plane). The questions are
// the control plane's own copy, the answer reads as it did there, and only counts come back for the usage report.
//
// Sabotage record (applied, run, observed failing, reverted):
//  1. the route not mounted on TexTexts → "reached through the TexTexts entrypoint" fails.
//  2. a failed model read as "silent" instead of unavailable → "a model that fails is unavailable" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { decideForTexts, TEXTS_DECIDE_PATH, TEXTS_RECHECK_PATH } from "../src/agent/textsDecide.js";
import { decideRequest } from "../../../packages/shared/src/textDecide.cjs";
import { TexTexts } from "../src/index.js";

const id = (n) => `${String(1_700_000_000_000 + n).padStart(13, "0")}-${String(n).padStart(6, "0")}`;
const SECRET = "the launch codes are pineapple";
const body = (extra = {}) => ({
  chat: "+15555550100",
  sender: "+15555550100",
  style: "direct",
  transcript: `<${id(1)}> @ada: save the playbook\n<${id(2)}> @ada: actually ${SECRET}`,
  candidates: [id(1), id(2)],
  running: false,
  waitingAsks: [],
  newest: id(2),
  ...extra,
});
const ask = (path, payload) => new Request(`https://gateway${path}`, { method: "POST", body: JSON.stringify(payload) });

test("asks the control plane's questions and reads the answer as it did", async () => {
  let seen = null;
  const engine = async (state, questions) => ((seen = { state, questions }), { act: { choice: "answer", confidence: 0.9 }, start: { choice: id(1) }, also_react: { noul: 0.1 } });
  const logs = [];
  const log = console.log;
  console.log = (line) => logs.push(String(line));
  let response;
  try {
    response = await decideForTexts(ask(TEXTS_DECIDE_PATH, body()), {}, { engine });
  } finally {
    console.log = log;
  }
  const answer = await response.json();
  assert.deepEqual(seen, decideRequest(body()));
  assert.equal(answer.ok, true);
  assert.equal(answer.act, "answer");
  assert.deepEqual(answer.covers, [id(1), id(2)]);
  assert.equal(answer.meter.questions, Object.keys(seen.questions).length);
  assert.equal(answer.meter.chars, seen.state.length + JSON.stringify(seen.questions).length);
  assert.equal(answer.meter.answered, true);
  assert.ok(!JSON.stringify(answer).includes("pineapple"));
  assert.ok(!logs.join("\n").includes("pineapple"));
});

test("the last look: one question, the draft in the state", async () => {
  let seen = null;
  const engine = async (state, questions) => ((seen = { state, questions }), { draft_fits: { noul: 0.2 } });
  const response = await decideForTexts(ask(TEXTS_RECHECK_PATH, { ...body(), draft: "Here's the playbook.", draftFor: id(1) }), {}, { engine });
  assert.deepEqual(await response.json().then(({ meter, ...rest }) => rest), { ok: true, fits: false, confidence: 0.2 });
  assert.deepEqual(Object.keys(seen.questions), ["draft_fits"]);
  assert.ok(seen.state.includes("Here's the playbook."));
});

test("a model that fails is unavailable, never a guess; no engine is unconfigured", async () => {
  const failed = await (await decideForTexts(ask(TEXTS_DECIDE_PATH, body()), {}, { engine: async () => null })).json();
  assert.deepEqual([failed.ok, failed.reason, failed.cause, failed.meter.answered], [false, "unavailable", "model_failed", false]);
  const offSet = await (await decideForTexts(ask(TEXTS_DECIDE_PATH, body()), {}, { engine: async () => ({ act: { choice: "shout" } }) })).json();
  assert.deepEqual([offSet.ok, offSet.cause], [false, "bad_answer"]);
  const none = await (await decideForTexts(ask(TEXTS_DECIDE_PATH, body()), {}, { engine: null })).json();
  assert.deepEqual([none.ok, none.cause], [false, "unconfigured"]);
});

test("a malformed body is refused before any model call", async () => {
  let called = false;
  const engine = async () => ((called = true), {});
  for (const bad of [{ style: "loud" }, { newest: id(9) }, { sender: undefined }, { transcript: "" }]) {
    const response = await decideForTexts(ask(TEXTS_DECIDE_PATH, body(bad)), {}, { engine });
    assert.equal(response.status, 400, JSON.stringify(bad));
  }
  assert.equal((await decideForTexts(new Request(`https://gateway${TEXTS_DECIDE_PATH}`, { method: "POST", body: "{" }), {}, { engine })).status, 400);
  assert.equal(called, false);
});

test("reached through the TexTexts entrypoint", async () => {
  const env = { AI: { run: async () => ({ answers: { act: { choice: "silent", confidence: 0.8 } } }) } };
  const response = await TexTexts.fetch(ask(TEXTS_DECIDE_PATH, body()), env, {});
  const answer = await response.json();
  assert.equal(answer.ok, true);
  assert.equal(answer.act, "silent");
});
