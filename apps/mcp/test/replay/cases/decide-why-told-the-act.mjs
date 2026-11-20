import assert from "node:assert/strict";
import { decideWhyNode } from "../../../src/agent/graph/nodes/decideWhy.js";
import { FOR_TEX_WHY, QUIET_WHY, WHY, decideRequest, readDecideAnswers, readDecideBody } from "../../../../../packages/tex/src/textDecide.cjs";

const id = (n) => `${String(1_700_000_000_000 + n).padStart(13, "0")}-${String(n).padStart(6, "0")}`;
/** An invented group chat: Tex answered, and a member replies under Tex's text with a laugh that asks nothing. */
const body = readDecideBody({
  chat: "group-fern-desk",
  sender: "+15555550111",
  line: "+15555550199",
  style: "attentive",
  transcript: `<${id(1)}> @ines: Tex what time does the print shop close\n<${id(2)}> You: 6 tonight.\n<${id(3)}> @ines: (replying to You) ha, plenty of time then`,
  candidates: [id(3)],
  running: false,
  waitingAsks: [],
  newest: id(3),
});

export default {
  id: "decide-why-told-the-act",
  incident: "2026-11-17: on Dev and Training runs Decide stayed quiet, rightly, on a message and logged the reason \"it replies to one of Tex's texts\", a reason that by its own words means the message is answered. Two Dev tests and one Training test failed on that pair with the act right.",
  cause: "Clef answers each typed question on its own, so `why` was never told what `act` chose. The Decide-why step asks for the reason once more, told the act, with only the reasons a quiet message can have, and never changes the act.",
  path: "group text",
  async run() {
    assert.ok(body, "the invented chat is a body Decide takes");
    const asked = decideRequest(body);
    // Decide's own answers: quiet, and a reason that says the message is for Tex.
    const first = readDecideAnswers(body, { act: { choice: "quiet", confidence: 0.8 }, also_react: { noul: 0.1 }, why: { choice: "replies_to_tex" } });
    assert.deepEqual([first.act, first.why], ["silent", "replies_to_tex"], "the pair that cannot be");
    const seen = [];
    const engine = async (state, questions) => (seen.push({ state, questions }), { why: { choice: "thanks_or_ok" } });
    const again = await decideWhyNode({ verdict: first, state: asked.state }, { engine });
    assert.equal(seen.length, 1, "one more question, once");
    assert.equal(seen[0].state, asked.state, "over the same chat and examples");
    assert.deepEqual(Object.keys(seen[0].questions), ["why"], "the reason and nothing else: it cannot choose an act");
    assert.match(seen[0].questions.why.instructions, /stayed quiet on the newest message/, "told the act");
    assert.deepEqual(Object.keys(seen[0].questions.why.criteria).sort(), Object.keys(WHY).filter((name) => !FOR_TEX_WHY.includes(name)).sort(), "only the reasons a quiet message can have");
    assert.equal(again.to, "changed");
    assert.equal(again.was, "replies_to_tex");
    assert.deepEqual({ ...again.verdict, why: undefined }, { ...first, why: undefined }, "the act and every other field as Decide gave them");
    assert.ok(Object.hasOwn(QUIET_WHY, again.verdict.why));

    // A second look that names a reason for Tex anyway, or fails, keeps the verdict whole.
    for (const bad of [async () => ({ why: { choice: "tags_tex" } }), async () => null, async () => { throw new Error("busy"); }]) {
      const kept = await decideWhyNode({ verdict: first, state: asked.state }, { engine: bad });
      assert.deepEqual([kept.to, kept.verdict], ["kept", first]);
    }
    // A verdict that is coherent is never asked about again: an answer for a reason that is Tex's, a quiet for one that is not.
    let calls = 0;
    const count = async () => ((calls += 1), { why: { choice: "people_talking" } });
    const answer = readDecideAnswers(body, { act: { choice: "respond", confidence: 0.9 }, also_react: { noul: 0 }, why: { choice: "replies_to_tex" } });
    const quiet = readDecideAnswers(body, { act: { choice: "quiet", confidence: 0.9 }, also_react: { noul: 0 }, why: { choice: "people_talking" } });
    assert.equal((await decideWhyNode({ verdict: answer, state: asked.state }, { engine: count })).verdict, answer);
    assert.equal((await decideWhyNode({ verdict: quiet, state: asked.state }, { engine: count })).verdict, quiet);
    assert.equal(calls, 0);
  },
};
