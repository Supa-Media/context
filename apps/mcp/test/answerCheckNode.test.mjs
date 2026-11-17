/**
 * The Answer check (`nodes/answerCheck.js`: the code checks and the reviewer as one step, built ahead of live Tex's
 * config for the simpler graph's Lab draft, Dev2 2026-11-16) on the real graph runner, with the real draft bridge
 * (`draftBridge.js`) and the real send node (`nodes/send.js`). The front door (`nodes/fd.js`) is a fake that keeps its
 * shape, a real draft bridge at `ctx.turn.drafts` and a scripted model loop, because the real one calls the model.
 *
 * What is proven:
 *   - a draft the code checks send back is rewritten by the model loop and checked again, and only the draft they let
 *     go is reviewed, then sent (case a);
 *   - a draft the review sends back goes through the code checks again before the review reads the rewrite, so the
 *     calls are code(d1), review(d1), code(d2), review(d2) (case b);
 *   - with no review wanted, or a turn that is no job's report or routine (`reviewedAs` null), no review runs and the
 *     send does (case c);
 *   - the runner logs the front door's rerun from the Answer check's loop wire as via "answerCheck:loop" (case d);
 *   - a spent send-back budget lets the last draft go, marked `spent`, and the send runs: never a crash that throws the
 *     answer away (case e; Dev2, 2026-11-17, the timecards job lost its answer ten times this way), and letting a draft
 *     go spends nothing, so a budget of two takes two notices (case f, the live config before the wire had rounds).
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-16):
 *   (i)  answerCheck.js: `continue` after a code notice removed. Case a fails: d1 is reviewed though the code sent it back.
 *   (ii) answerCheck.js: `&& t.reviewedAs` removed. "a chat turn's draft is never reviewed" fails.
 *   (iii) answerCheck.js: the `back.left() === 0` let-go removed (2026-11-17). Case e fails with "sent work back
 *        to fd more than 2 times", the incident's error.
 *   (iv) texGraph.cjs: a release counted as a send. Case f fails the same way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/shared/src/texGraph.cjs";
import { draftBridge } from "../src/agent/graph/draftBridge.js";
import { answerCheckNode } from "../src/agent/graph/nodes/answerCheck.js";

const { createGraph } = graphLib;

const node = (id, extra = {}) => ({ id, on: true, rounds: 1, ...extra });
const wire = (from, to, mode = "wait", when = ["*"]) => ({ from, to, mode, when });

const CONFIG = {
  nodes: [node("fd"), node("answerCheck"), node("send")],
  edges: [wire("fd", "answerCheck", "wait", ["*"]), wire("answerCheck", "send", "wait", ["*"]), { ...wire("answerCheck", "fd", "loop", ["*"]), rounds: 30 }],
};

const DRAFTS = ["d1", "d2", "d3"];

/** The front door's stop as its node output (`fd.js` `stopOutput`, the paused and finished shapes). */
function stopOutput(stop) {
  if (stop.paused) return { when: ["drafted"], pending: true, draft: String(stop.draft ?? "") };
  return { when: ["done"], pending: false };
}

/** One turn: the fake front door, the real checks and reviewer, a recording send, all on the real runner. */
async function runTurn(script, reviewedAs = "report", config = CONFIG) {
  const calls = [];
  const drafted = [];
  const logs = [];
  let sendRuns = 0;
  const turn = {
    reviewedAs,
    answerChecks: {
      code: async (draft, info) => (calls.push(["code", draft]), script.code(draft, info)),
      review: async (draft, info) => (calls.push(["review", draft]), script.review(draft, info)),
    },
  };
  const fd = async (input, io) => {
    const t = io.ctx.turn;
    if (t.drafts?.waiting) return stopOutput(await t.drafts.resume(input?.notice ?? null));
    const drafts = (t.drafts = draftBridge());
    const modelLoop = async () => {
      for (const draft of DRAFTS) {
        drafted.push(draft);
        const notice = await drafts.answerCheck(draft, {});
        if (notice === null) return;
      }
    };
    return stopOutput(await drafts.start(modelLoop()));
  };
  const graph = createGraph(
    config,
    {
      fd,
      answerCheck: answerCheckNode,
      send: async () => {
        sendRuns += 1;
        return { when: ["sent"] };
      },
    },
    { log: (e) => logs.push(e) },
  );
  const { ran, outputs } = await graph.run("fd", {}, { turn });
  return { calls, drafted, logs, ran, sendRuns, outputs };
}

test("Answer check: a draft its code sends back is rewritten and checked again, and only the one let go is reviewed and then sent", async () => {
  const { calls, drafted, sendRuns, ran } = await runTurn({
    code: (draft) => (draft === "d1" ? { notice: "say less", review: false } : { notice: null, review: true }),
    review: () => null,
  });
  assert.deepEqual(calls, [["code", "d1"], ["code", "d2"], ["review", "d2"]]);
  assert.deepEqual(drafted, ["d1", "d2"], "d3 is never drafted");
  assert.equal(sendRuns, 1);
  assert.deepEqual(ran, ["fd", "answerCheck", "send"]);
});

test("Answer check: a draft its review sends back goes through the code checks again before the reviewer reads the rewrite", async () => {
  const { calls, sendRuns } = await runTurn({
    code: () => ({ notice: null, review: true }),
    review: (draft) => (draft === "d1" ? "make it shorter" : null),
  });
  assert.deepEqual(calls, [["code", "d1"], ["review", "d1"], ["code", "d2"], ["review", "d2"]]);
  assert.equal(sendRuns, 1);
});

test("the runner logs the front door's rerun from the Answer check's loop wire as via answerCheck:loop", async () => {
  const { logs } = await runTurn({
    code: () => ({ notice: null, review: true }),
    review: (draft) => (draft === "d1" ? "make it shorter" : null),
  });
  assert.ok(logs.some((e) => e.node === "fd" && e.via === "answerCheck:loop" && e.ok === true));
});

test("with no review wanted no review runs, and the send does", async () => {
  const { calls, drafted, sendRuns, ran } = await runTurn({
    code: () => ({ notice: null, review: false }),
    review: () => {
      throw new Error("the reviewer ran");
    },
  });
  assert.deepEqual(calls, [["code", "d1"]]);
  assert.deepEqual(drafted, ["d1"]);
  assert.equal(sendRuns, 1);
  assert.deepEqual(ran, ["fd", "answerCheck", "send"]);
});

test("a chat turn's draft is never reviewed: only a job's report or a routine's text is (reviewedAs)", async () => {
  const { calls, sendRuns } = await runTurn(
    {
      code: () => ({ notice: null, review: true }),
      review: () => {
        throw new Error("the review ran");
      },
    },
    null,
  );
  assert.deepEqual(calls, [["code", "d1"]]);
  assert.equal(sendRuns, 1);
});


const BUDGET = (rounds, onWire = true) => ({
  nodes: [node("fd", onWire ? {} : { rounds }), node("answerCheck"), node("send")],
  edges: [wire("fd", "answerCheck", "wait", ["*"]), wire("answerCheck", "send", "wait", ["*"]), { ...wire("answerCheck", "fd", "loop", ["*"]), ...(onWire ? { rounds } : {}) }],
});

test("a spent send-back budget lets the last draft go, marked spent, and it is sent", async () => {
  const { calls, drafted, sendRuns, outputs } = await runTurn({ code: () => ({ notice: "again", review: false }), review: () => null }, "report", BUDGET(2));
  assert.deepEqual(drafted, ["d1", "d2", "d3"]);
  assert.deepEqual(calls, [["code", "d1"], ["code", "d2"], ["code", "d3"]]);
  assert.equal(sendRuns, 1, "the draft is sent, not thrown away");
  assert.equal(outputs.answerCheck.sentBack, 2);
  assert.equal(outputs.answerCheck.spent, true);
});

test("letting a draft go spends no round: two notices then a clean draft fit a budget of two (fd rounds 2, no rounds on the wire)", async () => {
  const { sendRuns, outputs } = await runTurn(
    { code: (draft) => (draft === "d3" ? { notice: null, review: false } : { notice: "again", review: false }), review: () => null },
    "report",
    BUDGET(2, false),
  );
  assert.equal(sendRuns, 1);
  assert.equal(outputs.answerCheck.sentBack, 2);
  assert.equal(outputs.answerCheck.spent, undefined);
});

test("a review notice past the budget lets the draft go too", async () => {
  const { sendRuns, outputs } = await runTurn({ code: () => ({ notice: null, review: true }), review: () => "shorter" }, "report", BUDGET(1));
  assert.equal(sendRuns, 1);
  assert.equal(outputs.answerCheck.sentBack, 1);
  assert.equal(outputs.answerCheck.spent, true);
});
