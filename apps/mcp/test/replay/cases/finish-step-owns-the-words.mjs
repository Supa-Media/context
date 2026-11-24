import assert from "node:assert/strict";
import { TEX_CONFIG } from "../../../../../packages/tex/gateway/agent/texConfig.js";
import { finishNode } from "../../../../../packages/tex/gateway/agent/graph/nodes/finish.js";
import { LAB_SANDBOX_KEY } from "../../../src/labSandbox/policy.js";

/** A texted reply as Text them builds it, the model having written `answer`, on main or on a Lab draft. */
async function finished(answer, draft = null) {
  const env = draft === null ? {} : { [LAB_SANDBOX_KEY]: { record: () => {}, config: draft } };
  const t = { env, turn: { answer, steps: [], timing: {} }, drafts: {}, group: null, job: null, report: null, runner: false, claims: null, setAside: [], ledger: { asked: [], offered: null }, outgoing: { take: (words) => ({ answer: words, pictures: [], captions: [] }) }, tex: { step: (_name, run) => run() }, opened: null, noteLinking: null, store: null, session: null };
  const out = await finishNode({}, { ctx: { turn: t } });
  return { out, sent: t.finished?.sent };
}

export default {
  id: "finish-step-owns-the-words",
  incident: "2026-11-23: the shadow-code audit found Text them cutting \"Absolutely,\" off a reply (\"Absolutely, 3pm works\" went as \"3pm works\") and adding a saved note's link, after every check, with no step in the Lab and no way for a draft to turn either off.",
  cause: "The words were finished inside Text them's code (sendTheReply.js), so the config, the Lab and Replay never showed what changed them.",
  path: "1:1 text",
  async run() {
    const main = await finished("Absolutely, 3pm works.");
    assert.deepEqual(main.out.when, ["finished"], "Finish the text is the step that runs");
    assert.equal(main.sent, "3pm works.", "main still trims, as before");
    const draft = JSON.parse(JSON.stringify(TEX_CONFIG));
    draft.nodes.find((n) => n.id === "finish").settings = { trimFlattery: false, linkSavedNote: true, dropStaleAnswer: true };
    assert.equal((await finished("Absolutely, 3pm works.", draft)).sent, "Absolutely, 3pm works.", "a draft that turns Trim flattery off sends the model's words");
  },
};
