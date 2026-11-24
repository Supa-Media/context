import assert from "node:assert/strict";
import { TEX_CONFIG, withDraft } from "../../../../../packages/tex/gateway/agent/texConfig.js";
import { replyFindings } from "../../../../../packages/tex/gateway/agent/replyChecks.js";
import { stepSettings } from "../../../../../packages/tex/src/texNodeSettings.cjs";

/** A chatty answer of 96 words of sentences, over main's prose limit of 70. */
const ANSWER = Array.from({ length: 12 }, () => "This sentence has exactly eight words in it.").join(" ");
const wordy = (config) => replyFindings({ question: "how was the trip?", words: stepSettings(config, "answerCheck") })(ANSWER, []).some((f) => f.kind === "wordy");
const draftWith = (settings) => {
  const draft = JSON.parse(JSON.stringify(TEX_CONFIG));
  draft.nodes.find((n) => n.id === "answerCheck").settings = settings;
  return withDraft(TEX_CONFIG, draft);
};

export default {
  id: "step-setting-runs-in-draft",
  incident: "2026-11-23: the shadow-code audit found Answer check's prose limit (70 words) a constant in wordy.js, so no Lab draft could try a longer or shorter limit and the Lab never showed it.",
  cause: "A code step's numbers lived in its code; the config had nowhere to hold them, so a draft's test chat always ran main's constant.",
  path: "1:1 text",
  async run() {
    assert.equal(wordy(TEX_CONFIG), true, "on main, a 96-word chatty answer goes back to be shorter");
    assert.equal(wordy(draftWith({ proseWords: 120, besideResultWords: 30 })), false, "a draft whose Answer check allows 120 words lets it through");
    assert.equal(wordy(draftWith({ proseWords: 40, besideResultWords: 30 })), true, "and one allowing 40 still sends it back");
    assert.equal(wordy(draftWith({ proseWords: 9999, besideResultWords: 30 })), true, "a value outside its bounds is dropped, so main's limit holds");
  },
};
