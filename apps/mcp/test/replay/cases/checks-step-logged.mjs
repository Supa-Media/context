import assert from "node:assert/strict";
import graphLib from "../../../../../packages/shared/src/texGraph.cjs";
import { eventEntry, ledgerObserver, nodeLog } from "../../../src/agent/ledger.js";
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
    // Ids and times are random digits that can hold "391" (a flake seen in CI on 2026-11-14), so they are left out.
    const kept = JSON.stringify(written.map(({ id: _id, at: _at, ...entry }) => entry));
    assert.ok(!kept.includes("391"), "never the draft's words, which are the reply entry");

    // 2026-11-15: Text them, Answer checks, Memory nudge and Reflect showed 0 s. Answer checks' run held the front
    // door's rewrite, and Text them's delivery, done by the texting Worker, was never kept, so Replay drew Text them as
    // the reply less the other steps, which fell to 0. Each run keeps its own time, and the delivery is a step.
    let clock = 0;
    const runs = [];
    const node = (id) => ({ id, on: true, rounds: 1 });
    const wire = (from, to, mode = "wait") => ({ from, to, mode, when: ["*"] });
    let backs = 0;
    const g = graphLib.createGraph(
      { nodes: [node("fd"), node("checks"), node("send")], edges: [wire("fd", "checks"), wire("checks", "send"), { ...wire("checks", "fd", "loop"), rounds: 2 }] },
      { fd: async () => ((clock += 4_500), {}), checks: async (_x, io) => ((clock += 2), backs++ === 0 && (await io.back.fd({})), {}), send: async () => ((clock += 1), {}) },
      { log: nodeLog({ write: (e) => runs.push(e) }, { turn: "turn-replay-0001" }), now: () => clock },
    );
    await g.run("fd", {});
    const ran = runs.find((e) => e.name === "checks");
    assert.equal(ran.ms, 4_502, "Answer checks' whole run holds the rewrite it sent back for");
    assert.equal(ran.own, 2, "but its own time is its code alone, never the front door's");
    const delivery = eventEntry({ id: "1794772822042-001207", at: 1794772822042, kind: "step", chat: "texts", turn: "turn-replay-0001", step: { name: "send", of: "delivery", ok: true, ms: 470, input: { parts: 1 }, output: { sent: 1 } } });
    assert.deepEqual([delivery.step, delivery.name, delivery.turn, delivery.ms], ["send", "delivery", "turn-replay-0001", 470], "Text them's delivery is kept under its turn, with its time");
  },
};
