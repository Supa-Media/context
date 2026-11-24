import assert from "node:assert/strict";
import { TEX_CONFIG } from "../../../../../packages/tex/gateway/agent/texConfig.js";
import { finishNode } from "../../../../../packages/tex/gateway/agent/graph/nodes/finish.js";
import { LAB_SANDBOX_KEY } from "../../../src/labSandbox/policy.js";

const LINE = "Want me to see your calendar? Then I can tell you when you're free.";

/** A 1:1 reply as Text them builds it, the Nudge answering `said`, on main or on a Lab draft. */
async function finished(answer, said, draft = null) {
  const env = draft === null ? {} : { [LAB_SANDBOX_KEY]: { record: () => {}, config: draft } };
  const config = draft ?? TEX_CONFIG;
  const t = { env, turn: { answer, steps: [], timing: {} }, drafts: {}, group: null, job: null, report: null, runner: false, claims: null, setAside: [], ledger: { asked: [], offered: null }, outgoing: { take: (words) => ({ answer: words, pictures: [], captions: [] }) }, tex: { step: (_name, run) => run() }, opened: null, noteLinking: null, store: null, session: null };
  let asked = 0;
  const on = (id) => config.nodes.find((n) => n.id === id)?.on !== false;
  const out = await finishNode({}, { on, use: { nudgeOffer: async () => { asked += 1; return said; } }, ctx: { turn: t } });
  return { out, sent: t.finished?.sent, asked };
}

export default {
  id: "nudge-step-offers-once",
  incident: "2026-11-24: in a Lab test chat, a 1:1 planning a dinner with a time got no offer to connect the calendar, and nudges had no step, so nobody could see why Tex offered something or didn't, or whether people kept texting after an offer.",
  cause: "Offers lived only as scattered prompt lines (the shared-workspace offer), with no step, no record of what was offered and no counts.",
  path: "1:1 text",
  async run() {
    const main = await finished("Dinner Saturday at 8 is saved.", { to: "offer", sent: true, line: LINE });
    assert.equal(main.asked, 0, "off on main: the Nudge is never asked");
    assert.equal(main.sent, "Dinner Saturday at 8 is saved.", "main texts the answer as before");
    const draft = JSON.parse(JSON.stringify(TEX_CONFIG));
    draft.nodes.find((n) => n.id === "nudgeOffer").on = true;
    const on = await finished("Dinner Saturday at 8 is saved.", { to: "offer", sent: true, line: LINE }, draft);
    assert.equal(on.asked, 1);
    assert.equal(on.sent, `Dinner Saturday at 8 is saved.\n\n${LINE}`, "a draft with the Nudge on adds its one line after the answer");
    const none = await finished("Dinner Saturday at 8 is saved.", { to: "none", sent: false, why: "no moment" }, draft);
    assert.equal(none.sent, "Dinner Saturday at 8 is saved.", "no offer, no line");
  },
};
