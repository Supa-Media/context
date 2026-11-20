// The Decide-why step (`src/agent/graph/nodes/decideWhy.js`): a second look at a quiet verdict's reason, told the act.
// Its behaviour is the replay case `replay/cases/decide-why-told-the-act.mjs`; here: the switch, the gateway's wiring,
// and the bench asking Decide the same way.
//
// Sabotage record (applied, run, observed failing, reverted):
//  1. `decideWhyOn` returning true always → "main's config has the step, wired from Decide, and off" fails.
//  2. `whyContradictsAct` true for an answer → "a reaction ... an answer is never looked at again" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { decideForTexts, TEXTS_DECIDE_PATH } from "../../../packages/tex/gateway/agent/textsDecide.js";
import { decideWhyNode, decideWhyOn } from "../../../packages/tex/gateway/agent/graph/nodes/decideWhy.js";
import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";
import { judgeCase } from "../bench/respond.mjs";
import { FOR_TEX_WHY, QUIET_WHY, WHY, decideWhyRequest, readDecideWhy, whyContradictsAct } from "../../../packages/tex/src/textDecide.cjs";

const id = (n) => `${String(1_700_000_000_000 + n).padStart(13, "0")}-${String(n).padStart(6, "0")}`;
const body = { chat: "group-fern-desk", sender: "+15555550111", line: "+15555550199", style: "attentive", transcript: `<${id(1)}> You: 6 tonight.\n<${id(2)}> @ines: ha, plenty of time then`, candidates: [id(2)], running: false, waitingAsks: [], newest: id(2) };
const ask = (payload) => new Request(`https://gateway${TEXTS_DECIDE_PATH}`, { method: "POST", body: JSON.stringify(payload) });
const quietForTex = { act: { choice: "quiet", confidence: 0.8 }, also_react: { noul: 0.1 }, why: { choice: "replies_to_tex" } };

test("main's config has the step, wired from Decide, and on", () => {
  const step = TEX_CONFIG.nodes.find((node) => node.id === "decideWhy");
  assert.equal(step.model, "clef");
  // On since 2026-11-18: Training kept Decide at 24/27 and Dev's Decide went 18 to 19 of 23 (Lab runs v57pwqb6, v57npa0q).
  assert.notEqual(step.on, false, "on after Training and Dev scored it");
  assert.equal(decideWhyOn(), true);
  assert.deepEqual(TEX_CONFIG.edges.filter((edge) => edge.to === "decideWhy").map((edge) => [edge.from, edge.mode, edge.when]), [["decide", "uses", ["contradiction"]]]);
  assert.equal(decideWhyOn({ nodes: [{ id: "decideWhy", on: true }] }), true);
  assert.equal(decideWhyOn({ nodes: [] }), false, "a draft from before the step has none, and runs none");
});

test("every reason is one that means for Tex or one a quiet message can have, never both", () => {
  assert.deepEqual([...FOR_TEX_WHY, ...Object.keys(QUIET_WHY)].sort(), Object.keys(WHY).sort());
  assert.ok(FOR_TEX_WHY.every((name) => Object.hasOwn(WHY, name)));
  assert.equal(readDecideWhy({ why: { choice: "asks_tex" } }), null);
  assert.equal(readDecideWhy({ why: { choice: "news_shared" } }), "news_shared");
  assert.equal(readDecideWhy(null), null);
});

test("a reaction with a reason for Tex is looked at again, told it reacted; an answer is never looked at again", async () => {
  assert.equal(whyContradictsAct({ ok: true, act: "react", why: "tags_tex" }), true);
  assert.equal(whyContradictsAct({ ok: true, act: "silent", why: "asks_tex" }), true);
  assert.equal(whyContradictsAct({ ok: true, act: "answer", why: "asks_tex" }), false);
  assert.equal(whyContradictsAct({ ok: true, act: "wait", why: "asks_tex" }), false);
  assert.equal(whyContradictsAct({ ok: true, act: "silent" }), false, "no reason, nothing to contradict");
  assert.equal(whyContradictsAct({ ok: false, reason: "unavailable" }), false);
  assert.match(decideWhyRequest("s", { ok: true, act: "react", why: "tags_tex" }).questions.why.instructions, /only reacted to the newest message/);
  const out = await decideWhyNode({ verdict: { ok: true, act: "react", emoji: "😂", why: "replies_to_tex" }, state: "s" }, { engine: async () => ({ why: { choice: "thanks_or_ok" } }) });
  assert.deepEqual(out.verdict, { ok: true, act: "react", emoji: "😂", why: "thanks_or_ok" });
});

test("the gateway asks Clef once more for a contradicting reason, and never changes the act", async () => {
  let calls = 0;
  const engine = async () => ((calls += 1), quietForTex);
  const log = console.log;
  console.log = () => {};
  try {
    const answer = await (await decideForTexts(ask(body), {}, { engine })).json();
    assert.equal(calls, 2, "Decide, then its reason once more");
    assert.equal(answer.act, "silent", "the act is Decide's own");
  } finally {
    console.log = log;
  }
});

test("the bench asks Decide as the gateway does: the second look only when the config runs it", async () => {
  const item = { id: "x", chat: "group", lines: ["You: 6 tonight."], text: "@ines: ha, plenty of time then" };
  const engine = async (_state, questions) => (Object.keys(questions).length === 1 ? { why: { choice: "thanks_or_ok" } } : quietForTex);
  assert.equal((await judgeCase(item, engine, { whyAgain: false })).why, "replies_to_tex", "off in a draft that turns it off");
  const on = await judgeCase(item, engine, { whyAgain: true });
  assert.deepEqual([on.act, on.why], ["silent", "thanks_or_ok"], "the act as it was, the reason one a quiet message can have");
});
