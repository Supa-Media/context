/**
 * The Hand-off node (`graph/nodes/handoff.js`, the turn's hook `handoff.js`; Dev2, 2026-11-18: the front door stays fast,
 * and a long or multi-step job is acknowledged at once and handed to a background worker with more rounds). It is
 * asked only at a draft the Answer check would send back with no send-back left: before it, such a draft went as it was.
 *
 * What is proven:
 *   - the node keeps a draft nobody held back, or with no ask, and otherwise writes a job whose brief carries their ask,
 *     the check's notice, the unsent draft and what the turn found, newest kept within its bound;
 *   - the hook starts that job through the turn's own background jobs, ends on the start line (the tapback when the job
 *     has none), runs once a turn, and lets the draft go when no job started or the node kept it;
 *   - on the real graph runner, a spent budget with the hook set hands off (logged `handedOff`, the model loop told),
 *     and with no hook (the node not wired) the draft goes as it is, as today;
 *   - `runTurn` ends on the hand-off's line, settled as a started job, with no round after.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-18):
 *   (i)   answerCheck.js: `spentOn` calling `letGo()` without asking `t.handoff`. "a spent budget hands the job off" fails.
 *   (ii)  handoff.js: the `started.length === before` check removed. "no job started" fails: the turn would end on a tapback for a job that never ran.
 *   (iii) turn.js: the `recheck?.handedOff` return removed. "runTurn ends on the hand-off's line" fails (the object is pushed as a notice).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/shared/src/texGraph.cjs";
import { draftBridge } from "../src/agent/graph/draftBridge.js";
import { answerCheckNode } from "../src/agent/graph/nodes/answerCheck.js";
import { MAX_FOUND, foundSoFar, handoffNode, handoffTitle } from "../src/agent/graph/nodes/handoff.js";
import { handoffHook, toolResultsOf } from "../src/agent/handoff.js";
import { QUIET_ACK } from "../src/agent/background.js";
import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";

const { createGraph } = graphLib;

test("the node keeps a draft nobody held back, or one with no ask", async () => {
  assert.equal((await handoffNode({ ask: "find me a flight", notice: "" })).to, "keep");
  assert.equal((await handoffNode({ ask: "", notice: "do it, don't offer it" })).to, "keep");
});

test("the node's job carries their ask, the notice, the unsent draft and what the turn found", async () => {
  const out = await handoffNode({
    ask: "Compare the three quotes in my inbox. Then book the cheapest.",
    draft: "Want me to compare them?",
    notice: "you offered what your tools can do",
    found: [{ name: "search_email", text: "3 quotes: A $10, B $12, C $9" }, { name: "fetch", text: "page failed", isError: true }],
  });
  assert.equal(out.to, "hand");
  assert.equal(out.title, "Compare the three quotes in my inbox.");
  assert.match(out.brief, /Compare the three quotes in my inbox\. Then book the cheapest\./);
  assert.match(out.brief, /you offered what your tools can do/);
  assert.match(out.brief, /Want me to compare them\?/);
  assert.match(out.brief, /search_email: 3 quotes/);
  assert.match(out.brief, /fetch \(failed\): page failed/);
  assert.ok(out.doneWhen.length > 0);
});

test("what the turn found is kept newest first within its bound", () => {
  const found = Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, text: "x".repeat(700) }));
  const lines = foundSoFar(found);
  assert.ok(lines.join("").length <= MAX_FOUND);
  assert.match(lines.at(-1), /^- t19:/, "the newest result is kept");
  assert.ok(!lines.some((l) => l.startsWith("- t0:")), "the oldest goes first");
  assert.equal(handoffTitle("a".repeat(200)).length, 80);
});

test("toolResultsOf reads only the turn's tool results", () => {
  assert.deepEqual(toolResultsOf([{ role: "user", text: "hi" }, { role: "tool", name: "read", text: "ok" }, { role: "tool", name: "w", text: "no", isError: true }]), [{ name: "read", text: "ok" }, { name: "w", text: "no", isError: true }]);
});

/** A turn's background jobs (`background.js`), as far as the hook reaches them. */
function fakeBackground({ starts = true, line = null } = {}) {
  const calls = [];
  const bg = {
    started: [],
    calls,
    async call(args) {
      calls.push(args);
      if (starts) bg.started.push({ title: args.title });
    },
    endsTurn: (name) => (name === "start_background_job" && starts ? (line ?? QUIET_ACK) : null),
  };
  return bg;
}

const HAND = async () => ({ to: "hand", title: "T", brief: "B", doneWhen: "D" });

test("the hook starts the node's job and ends on its start line, once a turn", async () => {
  const background = fakeBackground({ line: "On it, I'll text you the result." });
  let gated = null;
  const hook = handoffHook({ background, gate: async (input) => ((gated = input), HAND()), ask: "do the thing" });
  const ack = await hook("Want me to?", { messages: [{ role: "tool", name: "read", text: "r" }] }, "do it");
  assert.equal(ack, "On it, I'll text you the result.");
  assert.deepEqual(background.calls, [{ title: "T", brief: "B", done_when: "D" }]);
  assert.deepEqual(gated, { ask: "do the thing", draft: "Want me to?", notice: "do it", found: [{ name: "read", text: "r" }] });
  assert.equal(await hook("again", {}, "do it"), null, "once a turn");
  assert.equal(background.calls.length, 1);
});

test("the hook lets the draft go when no job started or the node kept it", async () => {
  const full = fakeBackground({ starts: false });
  assert.equal(await handoffHook({ background: full, gate: HAND, ask: "x" })("d", {}, "n"), null, "no job started");
  const kept = fakeBackground();
  assert.equal(await handoffHook({ background: kept, gate: async () => ({ to: "keep", why: "w" }), ask: "x" })("d", {}, "n"), null);
  assert.equal(kept.calls.length, 0);
  assert.equal(handoffHook({ background: null, gate: HAND, ask: "x" }), null);
});

// The graph: the fake front door keeps fd.js's shape and its answerCheck wrapper, on the real runner and bridge.
const node = (id, extra = {}) => ({ id, on: true, rounds: 1, ...extra });
const wire = (from, to, mode = "wait", when = ["*"]) => ({ from, to, mode, when });
const CONFIG = {
  nodes: [node("fd"), node("answerCheck"), node("send")],
  edges: [wire("fd", "answerCheck"), wire("answerCheck", "send"), { ...wire("answerCheck", "fd", "loop"), rounds: 2 }],
};

async function runGraph(handoff) {
  const drafted = [];
  const ended = [];
  const logs = [];
  const turn = { reviewedAs: null, handoff, answerChecks: { code: async () => ({ notice: "do it, don't offer it", review: false }), review: async () => null } };
  const fd = async (input, io) => {
    const t = io.ctx.turn;
    const stopOutput = (stop) => (stop.paused ? { when: ["drafted"], pending: true } : { when: ["done"], pending: false });
    if (t.drafts?.waiting) return stopOutput(await t.drafts.resume(input?.notice ?? null));
    const drafts = (t.drafts = draftBridge());
    const check = async (draft, info) => {
      const notice = await drafts.answerCheck(draft, info);
      return typeof t.handedOff === "string" ? { handedOff: t.handedOff } : notice;
    };
    const modelLoop = async () => {
      for (const draft of ["d1", "d2", "d3", "d4"]) {
        drafted.push(draft);
        const notice = await check(draft, { messages: [] });
        if (notice === null) return ended.push(["sent", draft]);
        if (notice?.handedOff) return ended.push(["handed", notice.handedOff]);
      }
    };
    return stopOutput(await drafts.start(modelLoop()));
  };
  const graph = createGraph(CONFIG, { fd, answerCheck: answerCheckNode, send: async () => ({ when: ["sent"] }) }, { log: (e) => logs.push(e) });
  const { outputs } = await graph.run("fd", {}, { turn });
  return { drafted, ended, logs, outputs };
}

test("a spent budget hands the job off when the hook is set, and the model loop ends on its line", async () => {
  const background = fakeBackground();
  const { drafted, ended, logs, outputs } = await runGraph(handoffHook({ background, gate: (input) => handoffNode(input), ask: "book the cheapest flight" }));
  assert.deepEqual(drafted, ["d1", "d2", "d3"], "two send-backs, then the third draft is handed off");
  assert.deepEqual(ended, [["handed", QUIET_ACK]]);
  assert.equal(background.calls.length, 1);
  assert.match(background.calls[0].brief, /book the cheapest flight/);
  assert.match(background.calls[0].brief, /d3/);
  assert.equal(outputs.answerCheck.spent, true);
  assert.ok(logs.some((e) => e.node === "answerCheck" && JSON.stringify(e).includes("handedOff")), "the hand-off is logged");
});

test("with the node not wired (no hook), a spent budget lets the draft go as it is", async () => {
  const { ended, outputs } = await runGraph(null);
  assert.deepEqual(ended, [["sent", "d3"]]);
  assert.equal(outputs.answerCheck.spent, true);
});

test("runTurn ends on the hand-off's line, settled as a started job, with no round after", async () => {
  const MAIN = "@cf/acme/main-model";
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push(input.messages);
      return { choices: [{ message: { content: "Want me to book it?", tool_calls: [] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
  const result = await runTurn({
    question: "book the cheapest flight",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    answerCheck: async () => ({ handedOff: QUIET_ACK }),
    callTool: async () => ({ content: [] }),
  });
  assert.equal(result.answer, QUIET_ACK);
  assert.equal(result.settled, "start_background_job");
  assert.equal(calls.length, 1, "no model round after the hand-off");
});
