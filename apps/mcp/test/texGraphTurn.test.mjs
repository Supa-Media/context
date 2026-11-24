/**
 * Tex's turn on the real graph runner (`packages/tex/src/texGraph.cjs`), with the real Answer check
 * (`nodes/answerCheck.js`) and its two steps over `uses` wires, the Claim checks (`nodes/claimChecks.js`) and the Reply
 * reviewer (`nodes/reviewer.js`) (Dev2, 2026-11-23: the no-shadow steps), the real draft bridge (`draftBridge.js`), Finish
 * the text in front of the send, and the real send node (`nodes/send.js`). The front door (`nodes/fd.js`) is a fake
 * that keeps its shape, a real draft bridge at `ctx.turn.drafts` and a scripted model loop, because the real one calls
 * the model.
 *
 * What is proven:
 *   - the draft bridge answers one draft at a time: start stops at the first draft, resume answers it and stops at the
 *     next, the last resume finishes the run, and a run that throws rejects the stop it is waiting on;
 *   - a draft the Claim checks send back is rewritten by the model loop and checked again, and only the draft they let
 *     go reaches the reviewer and then Finish the text and the send (case a);
 *   - a draft the Reply reviewer sends back goes through the Claim checks again before the reviewer reads the rewrite,
 *     so the calls are code(d1), review(d1), code(d2), review(d2) (case b);
 *   - with no review wanted the reviewer never runs and the send does (case c);
 *   - each step is a row of its own, the two checks via "answerCheck:uses", and no row carries a notice (case d);
 *   - the send node tags its output for the wires that fire on it: `answered` before any model, `ended` and `threads`
 *     once a door step ended the turn and the thread list was read.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-24):
 *   nodes/answerCheck.js claimChecksOf calling t.answerChecks.code directly     case d fails (no claimChecks row)
 *   nodes/claimChecks.js returning review: false                                cases a, b and d fail
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/tex/src/texGraph.cjs";
import { draftBridge } from "../../../packages/tex/gateway/agent/graph/draftBridge.js";
import { answerCheckNode } from "../../../packages/tex/gateway/agent/graph/nodes/answerCheck.js";
import { claimChecksNode } from "../../../packages/tex/gateway/agent/graph/nodes/claimChecks.js";
import { reviewerNode } from "../../../packages/tex/gateway/agent/graph/nodes/reviewer.js";
import { sendNode } from "../../../packages/tex/gateway/agent/graph/nodes/send.js";

const { createGraph } = graphLib;

const node = (id, extra = {}) => ({ id, on: true, rounds: 1, ...extra });
const wire = (from, to, mode = "wait", when = ["*"]) => ({ from, to, mode, when });

const CONFIG = {
  nodes: [node("fd"), node("answerCheck"), node("claimChecks"), node("reviewer"), node("finish"), node("send")],
  edges: [
    wire("fd", "answerCheck"),
    wire("answerCheck", "claimChecks", "uses"),
    wire("answerCheck", "reviewer", "uses"),
    wire("answerCheck", "finish"),
    wire("finish", "send"),
    { ...wire("answerCheck", "fd", "loop"), rounds: 30 },
  ],
};

const DRAFTS = ["d1", "d2", "d3"];

/** The front door's stop as its node output (`fd.js` `stopOutput`, the paused and finished shapes). */
function stopOutput(stop) {
  if (stop.paused) return { when: ["drafted"], pending: true, draft: String(stop.draft ?? "") };
  return { when: ["done"], pending: false };
}

/** One turn: the fake front door, the real checks and reviewer, a recording send, all on the real runner. */
async function runTurn(script) {
  const calls = [];
  const drafted = [];
  const logs = [];
  let sendRuns = 0;
  const turn = {
    reviewedAs: "report",
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
    CONFIG,
    {
      fd,
      answerCheck: answerCheckNode,
      claimChecks: claimChecksNode,
      reviewer: reviewerNode,
      finish: async () => ({ when: ["finished"] }),
      send: async () => {
        sendRuns += 1;
        return { when: ["sent"] };
      },
    },
    { log: (e) => logs.push(e) },
  );
  const { ran } = await graph.run("fd", {}, { turn });
  return { calls, drafted, logs, ran, sendRuns };
}

test("draftBridge: start stops at the first draft, resume answers it and stops at the next, and the last resume finishes the run", async () => {
  assert.throws(() => draftBridge().resume(), /no draft is waiting/);
  const bridge = draftBridge();
  const saw = [];
  const run = async () => {
    const notice = await bridge.answerCheck("draft 1", {});
    saw.push(notice);
    if (notice === null) return undefined;
    await bridge.answerCheck("draft 2", {});
    return undefined;
  };
  assert.deepEqual(await bridge.start(run()), { paused: true, draft: "draft 1", info: {} });
  assert.deepEqual(await bridge.resume("fix it"), { paused: true, draft: "draft 2", info: {} });
  assert.deepEqual(saw, ["fix it"]);
  assert.deepEqual(await bridge.resume(null), { paused: false, value: undefined });
  assert.throws(() => bridge.resume(), /no draft is waiting/);
});

test("draftBridge: a run that throws rejects the stop it is waiting on", async () => {
  const bridge = draftBridge();
  const run = async () => {
    await bridge.answerCheck("draft 1", {});
    throw new Error("the model step broke");
  };
  assert.equal((await bridge.start(run())).draft, "draft 1");
  await assert.rejects(bridge.resume("fix it"), /the model step broke/);
});

test("Claim checks: a draft they send back is rewritten and checked again, and only the one let go reaches the reviewer and then the send", async () => {
  const { calls, drafted, sendRuns, ran } = await runTurn({
    code: (draft) => (draft === "d1" ? { notice: "say less", review: false } : { notice: null, review: true }),
    review: () => null,
  });
  assert.deepEqual(calls, [["code", "d1"], ["code", "d2"], ["review", "d2"]]);
  assert.deepEqual(drafted, ["d1", "d2"], "d3 is never drafted");
  assert.equal(sendRuns, 1);
  assert.deepEqual(ran, ["fd", "answerCheck", "finish", "send"], "the wait wires: the checks run inside the Answer check, over its uses wires");
});

test("Reply reviewer: a draft it sends back goes through the Claim checks again before the reviewer reads the rewrite", async () => {
  const { calls, sendRuns } = await runTurn({
    code: () => ({ notice: null, review: true }),
    review: (draft) => (draft === "d1" ? "make it shorter" : null),
  });
  assert.deepEqual(calls, [["code", "d1"], ["review", "d1"], ["code", "d2"], ["review", "d2"]]);
  assert.equal(sendRuns, 1);
});

test("each check is a row of its own over the Answer check's uses wire, and no row carries a notice", async () => {
  const { logs } = await runTurn({
    code: (draft) => (draft === "d1" ? { notice: "NOTICE-ONE", review: true } : { notice: null, review: true }),
    review: (draft) => (draft === "d2" ? "NOTICE-TWO" : null),
  });
  const rows = (id) => logs.filter((e) => e.node === id);
  assert.ok(rows("claimChecks").length >= 3 && rows("claimChecks").every((e) => e.via === "answerCheck:uses"));
  assert.ok(rows("reviewer").length >= 2 && rows("reviewer").every((e) => e.via === "answerCheck:uses"));
  assert.ok(rows("claimChecks").some((e) => e.output?.back === true), "the row says it sent the draft back");
  assert.ok(!JSON.stringify([...rows("claimChecks"), ...rows("reviewer")]).includes("NOTICE-"), "never the notice's words");
});

test("with no review wanted the reviewer never runs, and the send does", async () => {
  const { calls, drafted, sendRuns, ran, logs } = await runTurn({
    code: () => ({ notice: null, review: false }),
    review: () => {
      throw new Error("the reviewer ran");
    },
  });
  assert.deepEqual(calls, [["code", "d1"]]);
  assert.deepEqual(drafted, ["d1"]);
  assert.equal(sendRuns, 1);
  assert.deepEqual(ran, ["fd", "answerCheck", "finish", "send"]);
  assert.ok(!logs.some((e) => e.node === "reviewer"), "no reviewer row");
});

test("send: answered before any model, and tagged ended and threads once a door step ended the turn and the threads were read", async () => {
  const answered = await sendNode({}, { ctx: { turn: { drafts: undefined, response: new Response(JSON.stringify({ answer: "hi" }), { status: 200 }) } } });
  assert.deepEqual(answered.when, ["answered"]);
  assert.equal(answered.texts, 2);

  const ended = await sendNode({}, {
    ctx: { turn: { drafts: draftBridge(), response: new Response(JSON.stringify({ answer: "hi" }), { status: 200 }), threadsSort: () => {} } },
  });
  assert.ok(ended.when.includes("ended"));
  assert.ok(ended.when.includes("threads"));
  assert.equal(ended.texts, 2);
});
