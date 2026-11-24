import assert from "node:assert/strict";
import { askGateNode } from "../../../../../packages/tex/gateway/agent/graph/nodes/askGate.js";

export default {
  id: "poll-is-not-a-lookup",
  incident:
    "2026-11-24, a Lab group chat on main: someone asked Tex to make a poll for which night to do the launch dinner. Tex tapped a reaction, handed the ask to a background job, and no poll was sent.",
  cause:
    "The Before-asking step read the poll's title (\"(poll) Which night…?\") as a question Tex could look up, climbed the ladder, and, still asking, sent the turn to a job.",
  path: "group text on iMessage",
  async run() {
    const asked = [];
    const engine = async (state, questions) => (asked.push({ state, questions }), { kind: { choice: "fact", confidence: 0.2 } });
    const draft = "(poll) Which night for the launch dinner?\n- Thursday\n- Friday\n- Saturday";
    const turn = { env: {}, question: "Tex can you make us a poll for which night to do the launch dinner? Thursday, Friday or Saturday", drafts: { waiting: { draft } } };
    const out = await askGateNode({ askChars: 96, draftChars: draft.length }, { ctx: { turn }, use: {}, engine });
    assert.equal(out.to, "pass", "a poll goes out as the reply");
    assert.equal(asked.length, 0, "with no model reading its title as an ask");
    const beside = await askGateNode({ ask: "make us a poll", draft: `${draft}\n\nWhere should we book?` }, { ctx: { turn: { env: {} } }, use: {}, engine });
    assert.notEqual(beside.to, "pass", "a real question beside the poll is still read");
    assert.equal(asked.length, 1);
    assert.equal(beside.asks, 1, "and only it: the poll's title is not counted");
  },
};
