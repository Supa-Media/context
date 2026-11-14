/**
 * Tex's turn on the real graph runner (`packages/shared/src/texGraph.cjs`), with the real Answer checks
 * (`nodes/checks.js`), the real Reply reviewer (`nodes/reviewer.js`), the real draft bridge (`draftBridge.js`) and the
 * real send node (`nodes/send.js`). The front door (`nodes/fd.js`) is a fake that keeps its shape, a real draft bridge
 * at `ctx.turn.drafts` and a scripted model loop, because the real one calls the model.
 *
 * What is proven:
 *   - the draft bridge answers one draft at a time: start stops at the first draft, resume answers it and stops at the
 *     next, the last resume finishes the run, and a run that throws rejects the stop it is waiting on;
 *   - a draft the code checks send back is rewritten by the model loop and checked again, and only the draft they let
 *     go reaches the reviewer and then the send (case a);
 *   - a draft the Reply reviewer sends back goes back through Answer checks before the reviewer reads the rewrite, so
 *     the calls are code(d1), review(d1), code(d2), review(d2) (case b, the main behaviour being preserved);
 *   - with no review wanted the reviewer never runs and the send does (case c);
 *   - the runner logs the front door's rerun from the reviewer's loop wire as via "reviewer:loop" (case d);
 *   - the send node tags its output for the wires that fire on it: `answered` before any model, `ended` and `threads`
 *     once a door step ended the turn and the thread list was read.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-14):
 *   (i)  packages/shared/src/texGraph.cjs: the `for (const mid of between(to, id))` line in a loop wire's io.back
 *        commented out. Case b fails (4 of 7 green overall, 6 pass): the reviewer's rewrite goes straight to
 *        review(d2), so the calls lack code(d2) before it. Case d still passes, since the rerun is still logged.
 *   (ii) nodes/checks.js: `if (review)` replaced by `if (false && review)`. Cases a, b and d fail (3 fail, 4 pass):
 *        no review(d2) call and the reviewer never runs in a, only code(d1) is called in b (the draft is let go
 *        unreviewed), and d's reviewer:loop rerun never happens. Case c and the bridge and send tests still pass.
 *   Both edits were reverted and the file was re-run green (7 of 7).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/shared/src/texGraph.cjs";
import { draftBridge } from "../src/agent/graph/draftBridge.js";
import { checksNode } from "../src/agent/graph/nodes/checks.js";
import { reviewerNode } from "../src/agent/graph/nodes/reviewer.js";
import { sendNode } from "../src/agent/graph/nodes/send.js";

const { createGraph } = graphLib;

const node = (id, extra = {}) => ({ id, on: true, rounds: 1, ...extra });
const wire = (from, to, mode = "wait", when = ["*"]) => ({ from, to, mode, when });

const CONFIG = {
  nodes: [node("fd"), node("checks"), node("reviewer"), node("send")],
  edges: [
    wire("fd", "checks", "wait", ["*"]),
    wire("checks", "reviewer", "wait", ["action"]),
    wire("checks", "send", "wait", ["*"]),
    wire("reviewer", "send", "wait", ["action"]),
    { ...wire("reviewer", "fd", "loop", ["action"]), rounds: 30 },
    { ...wire("checks", "fd", "loop", ["*"]), rounds: 30 },
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
      checks: checksNode,
      reviewer: reviewerNode,
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

test("Answer checks: a draft they send back is rewritten and checked again, and only the one let go reaches the reviewer and then the send", async () => {
  const { calls, drafted, sendRuns, ran } = await runTurn({
    code: (draft) => (draft === "d1" ? { notice: "say less", review: false } : { notice: null, review: true }),
    review: () => null,
  });
  assert.deepEqual(calls, [["code", "d1"], ["code", "d2"], ["review", "d2"]]);
  assert.deepEqual(drafted, ["d1", "d2"], "d3 is never drafted");
  assert.equal(sendRuns, 1);
  assert.deepEqual(ran, ["fd", "checks", "reviewer", "send"]);
});

test("Reply reviewer: a draft it sends back goes through Answer checks again before the reviewer reads the rewrite", async () => {
  const { calls, sendRuns } = await runTurn({
    code: () => ({ notice: null, review: true }),
    review: (draft) => (draft === "d1" ? "make it shorter" : null),
  });
  assert.deepEqual(calls, [["code", "d1"], ["review", "d1"], ["code", "d2"], ["review", "d2"]]);
  assert.equal(sendRuns, 1);
});

test("the runner logs the front door's rerun from the reviewer's loop wire as via reviewer:loop", async () => {
  const { logs } = await runTurn({
    code: () => ({ notice: null, review: true }),
    review: (draft) => (draft === "d1" ? "make it shorter" : null),
  });
  assert.ok(logs.some((e) => e.node === "fd" && e.via === "reviewer:loop" && e.ok === true));
});

test("with no review wanted the reviewer never runs, and the send does", async () => {
  const { calls, drafted, sendRuns, ran } = await runTurn({
    code: () => ({ notice: null, review: false }),
    review: () => {
      throw new Error("the reviewer ran");
    },
  });
  assert.deepEqual(calls, [["code", "d1"]]);
  assert.deepEqual(drafted, ["d1"]);
  assert.equal(sendRuns, 1);
  assert.deepEqual(ran, ["fd", "checks", "send"]);
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
