import assert from "node:assert/strict";
import { ledgerObserver } from "../../../src/agent/ledger.js";
import { replyJudge, REVIEW_MODEL } from "../../../src/agent/replyJudge.js";

/** A reviewer that lets every draft go, as the gateway answers it. */
const passing = async () => ({ text: JSON.stringify({ verdict: "pass", kind: "chat", problems: [], feedback: "" }) });

export default {
  id: "checks-step-logged",
  incident: "2026-11-14: replaying a 1:1 turn in the Lab, Answer checks showed a bar but nothing it got or gave, and a turn whose review was skipped showed nothing for the reviewer either.",
  cause: "With the reviewer on, the code checks run inside it and wrote to the chat's record only when they sent a draft back, and a skipped review went only to the console, so a check that passed or a review that was skipped left no trace.",
  path: "1:1 text",
  async run() {
    const written = [];
    const tell = ledgerObserver({ write: (entry) => written.push(entry) }, null, { turn: "turn-replay-0001" });
    const judge = replyJudge({ setting: { model: REVIEW_MODEL }, question: "what's 17 times 23?", history: [], request: passing, log: () => {}, inner: { check: () => null }, plain: { check: () => null } });
    // A turn with no action: the plain checks run, and the review is skipped.
    assert.equal(await judge.check("391.", { messages: [], tell }), null);
    const checks = written.filter((entry) => entry.kind === "step" && entry.step === "checks");
    assert.equal(checks.length, 1, "the code checks are a step in the chat's record even when they pass");
    assert.equal(checks[0].turn, "turn-replay-0001", "under the turn they checked");
    assert.deepEqual(checks[0].output, { verdict: "let it go" }, "with whether the draft passed");
    assert.equal(checks[0].input.set, "plain", "and which checks ran");
    const skipped = written.find((entry) => entry.kind === "step" && entry.step === "reviewer");
    assert.ok(skipped, "a review skipped for a turn with no action is a step too");
    assert.equal(skipped.output.verdict, "skipped");
    assert.ok(!JSON.stringify(written).includes("391"), "never the draft's words, which are the reply entry");
  },
};
