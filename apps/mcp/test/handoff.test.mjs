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
 *   - out of rounds (`fd -> handoff`, cause "rounds"): the node hands the job on with no notice, its brief saying the
 *     turn ran out of rounds; the hook fires over the front door's wire; `runTurn` asks `roundsOut` once, at the round
 *     two from its bound, and ends there on its line with no round after; unasked (not wired) it runs to its bound as
 *     today; and every turn says its rounds of its bound and whether it ran out (`roundsField`), as the bench records.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-18):
 *   (i)   answerCheck.js: `spentOn` calling `letGo()` without asking `t.handoff`. "a spent budget hands the job off" fails.
 *   (ii)  handoff.js: the `started.length === before` check removed. "no job started" fails: the turn would end on a tapback for a job that never ran.
 *   (iii) turn.js: the `recheck?.handedOff` return removed. "runTurn ends on the hand-off's line" fails (the object is pushed as a notice).
 *   (iv)  turn.js: the `roundsOut` call removed. "out of rounds, runTurn hands the job off" fails (it runs all four rounds).
 *   (v)   handoff.js node: the `rounds` exception to the notice check removed. "out of rounds the node hands on" fails (keep).
 *   (vi)  turn.js: the "last round ended on tool calls" check removed. "a turn sent back into its last rounds" fails.
 *   (vii) turn.js: the only-read check removed. "a turn that changed something is never handed on" fails.
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
import { roundsField } from "../src/agent/lastRound.js";

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
  assert.deepEqual(gated, { ask: "do the thing", draft: "Want me to?", notice: "do it", found: [{ name: "read", text: "r" }], cause: "check" });
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

test("out of rounds the node hands the job on with no notice, saying the turn ran out of rounds", async () => {
  const out = await handoffNode({ ask: "Compare the readers' prices and pick one.", draft: "Checking the third site.", found: [{ name: "fetch", text: "Reader A $40/mo" }], cause: "rounds" });
  assert.equal(out.to, "hand");
  assert.match(out.brief, /ran out of rounds/);
  assert.match(out.brief, /Checking the third site\./);
  assert.match(out.brief, /fetch: Reader A \$40\/mo/);
  assert.doesNotMatch(out.brief, /never sent, because/);
  assert.equal((await handoffNode({ ask: "x", cause: "check" })).to, "keep", "from the check, a draft nobody held back still stays");
});

test("the hook fires over the wire it was asked from, with that wire's cause", async () => {
  const background = fakeBackground();
  const seen = [];
  const hook = handoffHook({ background, gate: async (input, from) => (seen.push([from, input.cause]), HAND()), ask: "x" });
  assert.equal(await hook("words", { messages: [] }, "", "fd"), QUIET_ACK);
  assert.deepEqual(seen, [["fd", "rounds"]]);
});

/** A model that calls a tool every round, so a turn only ends at its bound. */
function toolEveryRound(calls) {
  return {
    async run(_model, input) {
      calls.push(input.messages);
      return { choices: [{ message: { content: "Checking another site.", tool_calls: [{ id: `c${calls.length}`, type: "function", function: { name: "look", arguments: "{}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}

const LOOK = { name: "look", description: "look something up", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } };

async function turnOf(ai, extra = {}) {
  const MAIN = "@cf/acme/main-model";
  return runTurn({
    question: "compare the readers' prices",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [LOOK],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    maxRounds: 4,
    callTool: async () => ({ content: [{ type: "text", text: "Reader A $40/mo" }] }),
    ...extra,
  });
}

test("out of rounds, runTurn hands the job off at the round two from its bound, and ends on its line", async () => {
  const calls = [];
  const asked = [];
  const result = await turnOf(toolEveryRound(calls), { roundsOut: async (at) => (asked.push(at), QUIET_ACK) });
  assert.equal(asked.length, 1, "asked once");
  assert.equal(calls.length, 2, "two rounds of four ran, then the job went on: no round after");
  assert.ok(asked[0].messages.some((m) => m.role === "tool"), "with what the turn found");
  assert.equal(asked[0].lastWords, "Checking another site.");
  assert.equal(result.answer, QUIET_ACK);
  assert.equal(result.settled, "start_background_job");
  assert.equal(result.handedOff, "rounds");
  assert.deepEqual(roundsField(result), { rounds: { used: 2, of: 4, toEnd: true, handedOff: true } });
});

test("not wired (no roundsOut), or the node kept it, the turn runs to its bound as today, and says it ran out", async () => {
  const calls = [];
  const result = await turnOf(toolEveryRound(calls));
  assert.equal(calls.length, 4);
  assert.equal(result.exhausted, true);
  assert.deepEqual(roundsField(result), { rounds: { used: 4, of: 4, toEnd: true, exhausted: true } });
  const kept = [];
  const goesOn = await turnOf(toolEveryRound(kept), { roundsOut: async () => null });
  assert.equal(kept.length, 4, "a null answer goes on");
  assert.notEqual(goesOn.settled, "start_background_job");
});

test("a turn that answers inside its bound says its rounds and nothing ran out", async () => {
  const ai = { async run() { return { choices: [{ message: { content: "Hi.", tool_calls: [] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } };
  let asked = 0;
  const result = await turnOf(ai, { roundsOut: async () => ((asked += 1), QUIET_ACK) });
  assert.equal(asked, 0, "never asked inside the bound");
  assert.deepEqual(roundsField(result), { rounds: { used: 1, of: 4 } });
  assert.deepEqual(roundsField({}), {}, "no timing, nothing said");
});

// The schema a Lab draft gives the shelf node: `cause` is one of its inputs, so a hand-off from either wire passes the
// runner's strict shape check. Sabotage: drop `cause` from it and the fire throws "has "cause", which its schema does not name".
const HANDOFF_SCHEMA = {
  inSchema: [{ name: "ask", type: "text" }, { name: "draft", type: "text", optional: true }, { name: "notice", type: "text", optional: true }, { name: "found", type: "list", optional: true }, { name: "cause", type: "choice", options: "rounds, check", optional: true }],
  outSchema: [{ name: "to", type: "choice", options: "hand, keep" }, { name: "title", type: "text", optional: true }, { name: "brief", type: "text", optional: true }, { name: "doneWhen", type: "text", optional: true }, { name: "why", type: "text", optional: true }],
};

test("on the real runner, the front door's wire fires the node with cause rounds, and only when drawn", async () => {
  const config = { nodes: [node("fd"), node("handoff", HANDOFF_SCHEMA)], edges: [wire("fd", "handoff", "uses")] };
  const graph = createGraph(config, { fd: async () => ({ when: ["done"] }), handoff: handoffNode }, { log: () => {} });
  assert.equal(graph.wired("fd", "handoff"), true);
  assert.equal(graph.wired("answerCheck", "handoff"), false, "the answer check's moment stays off unless drawn too");
  const background = fakeBackground();
  const hook = handoffHook({ background, gate: (input, from) => graph.fire(from, "handoff", input), ask: "compare the readers' prices" });
  assert.equal(await hook("Checking another site.", { messages: [{ role: "tool", name: "look", text: "A $40" }] }, "", "fd"), QUIET_ACK);
  assert.match(background.calls[0].brief, /ran out of rounds/);
});

/** A model that calls `name` every round. */
function calling(calls, name) {
  return { async run(_m, input) { calls.push(input.messages); return { choices: [{ message: { content: "", tool_calls: [{ id: `c${calls.length}`, type: "function", function: { name, arguments: "{}" } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } };
}

test("a turn that changed something is never handed on: a worker could do the write again", async () => {
  const WRITE = { name: "write_it", description: "writes", inputSchema: { type: "object", properties: {} } };
  const calls = [];
  let asked = 0;
  const result = await turnOf(calling(calls, "write_it"), { tools: [WRITE], roundsOut: async () => ((asked += 1), QUIET_ACK) });
  assert.equal(asked, 0, "never asked after a write");
  assert.equal(calls.length, 4);
  assert.equal(result.exhausted, true);
});

test("a turn sent back into its last rounds is drafting, not gathering: never handed on", async () => {
  const calls = [];
  const ai = {
    async run(_m, input) {
      calls.push(input.messages);
      if (calls.length === 1) return { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "look", arguments: "{}" } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      return { choices: [{ message: { content: `Draft ${calls.length}.`, tool_calls: [] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  };
  let checks = 0;
  let asked = 0;
  const result = await turnOf(ai, { answerCheck: async () => ((checks += 1) === 1 ? "say it plainly" : null), roundsOut: async () => ((asked += 1), QUIET_ACK) });
  assert.equal(asked, 0, "never asked on a send-back");
  assert.equal(result.answer, "Draft 3.");
});

test("a hook that throws lets the turn go on as it would unwired", async () => {
  const calls = [];
  const result = await turnOf(toolEveryRound(calls), { roundsOut: async () => { throw new Error("schema"); } });
  assert.equal(calls.length, 4);
  assert.equal(result.exhausted, true);
  const background = fakeBackground();
  assert.equal(await handoffHook({ background, gate: async () => { throw new Error("has cause, which its schema does not name"); }, ask: "x" })("d", {}, "n"), null, "the hook itself answers null");
});

test("a bound too short for its last-two notice still hands on at the bound", async () => {
  const calls = [];
  const result = await turnOf(toolEveryRound(calls), { maxRounds: 2, roundsOut: async () => QUIET_ACK });
  assert.equal(calls.length, 2);
  assert.equal(result.handedOff, "rounds");
  assert.equal(result.settled, "start_background_job");
});

test("the brief fits the job's cap with what was found ahead of the unsent words", async () => {
  const out = await handoffNode({ ask: "a".repeat(3_000), draft: "d".repeat(3_000), cause: "rounds", found: Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, text: "x".repeat(1_000) })) });
  assert.ok(out.brief.length <= 2_000, String(out.brief.length));
  assert.ok(out.brief.indexOf("Already found") < out.brief.indexOf("What it last said"), "found first");
  assert.match(out.brief, /- t9:/, "the newest result kept");
});
