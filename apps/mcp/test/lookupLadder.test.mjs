/**
 * The lookup ladder (`lookupLadder.js`, the Before-asking step `graph/nodes/askGate.js` and its rungs; Dev2,
 * 2026-11-20: "before you search, what do you have in your memory ... then search the user's context, then the
 * internet ... and even before it asks me, ask the smarter model"). On the node shelf: nothing runs it until a Lab
 * draft wires `answerCheck -> askGate`.
 *
 * What is proven:
 *   - code only pre-filters: a draft with no question mark never reaches the model;
 *   - the model's read decides: nothing or an approval or what only they can answer goes on as it is; a fact climbs;
 *   - a fact climbs rungs 1 to 4, each its own step, and goes back once with what they found or which fast rung is
 *     untried; a connector that failed is said and asked about, never sent round through the browser;
 *   - still asking after that send-back, or nothing found with every fast rung tried, the slow rungs go to a job
 *     through the Hand-off node (cause "ladder"), and the turn ends on the job's start line;
 *   - unwired (no `t.ladderOn`), the Answer check lets the draft go as today.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-20):
 *   (i)   askGate.js: the `questions.length === 0` early return removed. "no question mark, no model" fails (the model is called).
 *   (ii)  askGate.js: `t.ladderSentBack` check removed. "still asking after the send-back goes to a job" fails (a second send-back).
 *   (iii) answerCheck.js: the `askBefore` call removed. "a fact climbs, goes back with what memory found" fails (d1 is sent).
 *   (iv)  lookupLadder.js: the failedApps branch removed. "a failed connector is said" fails.
 *   (v)   askGate.js: `got.error` dropped from the pass output. "a model call that fails says why" fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/tex/src/texGraph.cjs";
import { draftBridge } from "../../../packages/tex/gateway/agent/graph/draftBridge.js";
import { answerCheckNode } from "../../../packages/tex/gateway/agent/graph/nodes/answerCheck.js";
import { askEngine, askGateNode, climbBarOf } from "../../../packages/tex/gateway/agent/graph/nodes/askGate.js";
import { rungToolsNode } from "../../../packages/tex/gateway/agent/graph/nodes/rungTools.js";
import { handoffNode } from "../../../packages/tex/gateway/agent/graph/nodes/handoff.js";
import { causeOf, handoffHook } from "../../../packages/tex/gateway/agent/handoff.js";
import { QUIET_ACK } from "../../../packages/tex/gateway/agent/background.js";
import { ladderNotice, linesWith, questionsIn, readAsk, rungOf, selectorOf, termsOf, triedRungs, untriedFast } from "../../../packages/tex/gateway/agent/lookupLadder.js";

const { createGraph } = graphLib;

test("questions are the sentences that end in a question mark", () => {
  assert.deepEqual(questionsIn("Done. What's your flight number? Also, which day?"), ["What's your flight number?", "Also, which day?"]);
  assert.deepEqual(questionsIn("All set, it's booked."), []);
  assert.deepEqual(questionsIn("???"), []);
});

test("the model's read is a known kind with its confidence, or nothing", () => {
  assert.deepEqual(readAsk({ kind: { choice: "fact", confidence: 0.8 } }), { kind: "fact", sure: 0.8 });
  assert.equal(readAsk({ kind: { choice: "maybe" } }), null);
  assert.equal(readAsk(null), null);
  assert.equal(selectorOf("@cf/typesafe/jev"), "jev");
  assert.equal(selectorOf("@cf/cloudflare/clef-flash"), "clef-flash");
});

test("each lookup is its rung", () => {
  assert.equal(rungOf("search_web"), "web");
  assert.equal(rungOf("open_page"), "browser");
  assert.equal(rungOf("search", { email: true }), "apps");
  assert.equal(rungOf("fetch", { id: "calendar:today" }), "apps");
  assert.equal(rungOf("fetch", { id: "projects/a.md" }), "notes");
  assert.equal(rungOf("search", { query: "x" }), "notes");
  assert.equal(rungOf("read_day"), "knows");
  assert.equal(rungOf("ask_advisor"), "advisor");
  assert.equal(rungOf("write"), null);
  const messages = [
    { role: "assistant", toolCalls: [{ id: "a", name: "search", args: { email: true } }, { id: "b", name: "search_web", args: {} }] },
    { role: "tool", id: "a", name: "search", text: "Gmail sign-in expired", isError: true },
    { role: "tool", id: "b", name: "search_web", text: "results" },
  ];
  const { tried, failedApps } = triedRungs(messages);
  assert.deepEqual([...tried].sort(), ["apps", "web"]);
  assert.deepEqual(failedApps, ["search"]);
  assert.deepEqual(untriedFast(new Set(["web"])), ["apps"]);
});

test("search words are the questions' content words; lines need half of them", () => {
  const terms = termsOf(["What's your flight number for Denver?"]);
  assert.ok(terms.includes("flight") && terms.includes("denver") && terms.includes("number"));
  assert.ok(!terms.includes("what") && !terms.includes("your"));
  assert.deepEqual(linesWith("Seyi: flight to Denver is UA 412\nlunch tomorrow", ["flight", "denver"]), ["Seyi: flight to Denver is UA 412"]);
});

test("a notes line needs two of the words: one shared word like 'email' is not a find", async () => {
  const { rungNotesNode } = await import("../../../packages/tex/gateway/agent/graph/nodes/rungNotes.js");
  const terms = termsOf(["what's my sister's address again? want to send her a card", "Do you have her address in an old email?"], 8);
  assert.ok(terms.includes("sister") && terms.includes("address"));
  const text = "I don't have an email address for Ama in your notes\n- an emailed article you have not read yet\nSister Bisi: 12 Oak Lane, address for cards";
  const io = { ctx: { turn: { toolCalls: { mcp: async () => text } } } };
  const out = await rungNotesNode({ query: "sister address", terms }, io);
  assert.deepEqual(out.found, ["Sister Bisi: 12 Oak Lane, address for cards", "I don't have an email address for Ama in your notes"]);
  assert.ok(!out.found.some((l) => l.includes("emailed article")));
});

test("the send-back carries what was found, names the untried fast rungs, and never routes round a broken connector", () => {
  const found = ladderNotice({ questions: ["Which flight?"], knows: ["flight UA 412"], notes: [], untried: ["web"] });
  assert.match(found, /^Before this goes:/);
  assert.match(found, /flight UA 412/);
  assert.match(found, /a web search/);
  const broken = ladderNotice({ questions: ["Which flight?"], untried: ["web"], failedApps: ["search"] });
  assert.match(broken, /Don't work around it with the browser/);
  assert.doesNotMatch(broken, /a web search/);
  assert.equal(ladderNotice({ questions: ["Which flight?"] }), null, "nothing to send back with");
});

/** A Workers AI binding that answers one kind, counting its calls. */
function fakeAi(kind, confidence = 0.9) {
  const ai = { calls: 0, async run(_model, input) { ai.calls += 1; ai.last = input; return { answers: { kind: { choice: kind, confidence } } }; } };
  return ai;
}

test("no question mark, no model", async () => {
  const ai = fakeAi("fact");
  const out = await askGateNode({ ask: "book it", draft: "Booked for 7." }, { ctx: { turn: { env: { AI: ai } } }, use: {} });
  assert.equal(out.to, "pass");
  assert.equal(ai.calls, 0);
});

test("an approval or what only they can answer goes on; so does no real ask", async () => {
  for (const [kind, to] of [["approval", "bypass"], ["person", "bypass"], ["none", "pass"]]) {
    const out = await askGateNode({ ask: "email Sam", draft: "Send it to Sam now?" }, { ctx: { turn: { env: { AI: fakeAi(kind) } } }, use: {} });
    assert.equal(out.to, to, kind);
  }
  const unsure = await askGateNode({ ask: "x", draft: "Which one?" }, { ctx: { turn: { env: { AI: fakeAi("fact", 0.2) } } }, use: {} });
  assert.equal(unsure.to, "job", "with no bar set, the choice alone decides: an unsure fact still climbs");
});

test("the climb bar is the step's own whole percent, or none", () => {
  assert.equal(climbBarOf({ limits: { climbAt: 40 } }), 0.4);
  for (const bad of [{}, { limits: {} }, { limits: { climbAt: 0.4 } }, { limits: { climbAt: 140 } }, { limits: { climbAt: "40" } }, null]) assert.equal(climbBarOf(bad), 0);
});

test("a model call that fails says why in the step's log, and the draft goes on", async () => {
  const broken = { async run() { throw new Error("No such model typesafe/jev"); } };
  const out = await askGateNode({ ask: "x", draft: "Which one?" }, { ctx: { turn: { env: { AI: broken } } }, use: {} });
  assert.equal(out.to, "pass");
  assert.match(out.why, /No such model/);
  assert.equal(out.model, "@cf/cloudflare/clef");
  const engine = askEngine({ async run(model, input) { return { answers: { kind: { choice: "none" } }, asked: [model, input.model] }; } }, "@cf/typesafe/jev");
  assert.deepEqual((await engine("s", {})).answers, { kind: { choice: "none" } });
});

// The graph: a fake front door that drafts in turn, on the real runner and bridge, with the real Answer check and gate.
const node = (id, extra = {}) => ({ id, on: true, rounds: 1, ...extra });
const wire = (from, to, mode = "wait", when = ["*"]) => ({ from, to, mode, when });
const CONFIG = {
  nodes: [node("fd"), node("answerCheck"), node("askGate"), node("rungKnows"), node("rungNotes"), node("rungTools"), node("send")],
  edges: [
    wire("fd", "answerCheck"),
    wire("answerCheck", "send"),
    { ...wire("answerCheck", "fd", "loop"), rounds: 2 },
    wire("answerCheck", "askGate", "uses"),
    wire("askGate", "rungKnows", "uses"),
    wire("askGate", "rungNotes", "uses"),
    wire("askGate", "rungTools", "uses"),
  ],
};

async function runLadder({ drafts, messages = [], kind = "fact", knows = [], notes = [], ladderOn = true, ladderHandOff = null }) {
  const drafted = [];
  const ended = [];
  const logs = [];
  const ai = fakeAi(kind);
  const turn = { question: "when do I fly to Denver?", env: { AI: ai }, ladderOn, ladderHandOff, reviewedAs: null, answerChecks: { code: async () => ({ notice: null, review: false }), review: async () => null } };
  const notices = [];
  const fd = async (input, io) => {
    const t = io.ctx.turn;
    const stopOutput = (stop) => (stop.paused ? { when: ["drafted"], pending: true } : { when: ["done"], pending: false });
    if (t.drafts?.waiting) {
      if (input?.notice) notices.push(input.notice);
      return stopOutput(await t.drafts.resume(input?.notice ?? null));
    }
    const bridge = (t.drafts = draftBridge());
    const modelLoop = async () => {
      for (const draft of drafts) {
        drafted.push(draft);
        const notice = await bridge.answerCheck(draft, { messages });
        if (typeof t.handedOff === "string") return ended.push(["handed", t.handedOff]);
        if (notice === null) return ended.push(["sent", draft]);
      }
    };
    return stopOutput(await bridge.start(modelLoop()));
  };
  const nodes = {
    fd,
    answerCheck: answerCheckNode,
    askGate: askGateNode,
    rungKnows: async () => ({ found: knows }),
    rungNotes: async () => ({ found: notes }),
    rungTools: rungToolsNode,
    send: async () => ({ when: ["sent"] }),
  };
  const graph = createGraph(CONFIG, nodes, { log: (e) => logs.push(e) });
  const { outputs } = await graph.run("fd", {}, { turn });
  return { drafted, ended, logs, outputs, notices, ai };
}

test("a fact climbs, goes back with what memory found, and the answer goes out", async () => {
  const { drafted, ended, notices, logs } = await runLadder({ drafts: ["What's your flight to Denver?", "You fly to Denver Friday on UA 412."], knows: ["Fri: flight to Denver UA 412"] });
  assert.deepEqual(drafted.length, 2);
  assert.deepEqual(ended, [["sent", "You fly to Denver Friday on UA 412."]]);
  assert.match(notices[0], /UA 412/);
  for (const step of ["askGate", "rungKnows", "rungNotes", "rungTools"]) assert.ok(logs.some((e) => e.node === step), `${step} is logged as its own step`);
});

test("still asking after the send-back goes to a job, and the turn ends on its start line", async () => {
  const background = { started: [], calls: [], async call(args) { this.calls.push(args); this.started.push(args); }, endsTurn: () => QUIET_ACK };
  const hook = handoffHook({ background, gate: (input) => handoffNode(input), ask: "when do I fly to Denver?" });
  const ladderHandOff = (draft, info, notice) => hook(draft, info, notice, "askGate");
  const { ended } = await runLadder({ drafts: ["What's your flight to Denver?", "Which airline are you on for Denver?"], ladderHandOff });
  assert.deepEqual(ended, [["handed", QUIET_ACK]]);
  assert.equal(background.calls.length, 1);
  assert.match(background.calls[0].brief, /your own browser/);
  assert.equal(causeOf("askGate"), "ladder");
});

test("nothing found with every fast rung tried goes straight to a job", async () => {
  const messages = [
    { role: "assistant", toolCalls: [{ id: "a", name: "search", args: { email: true } }, { id: "b", name: "search_web", args: {} }] },
    { role: "tool", id: "a", name: "search", text: "none" },
    { role: "tool", id: "b", name: "search_web", text: "none" },
  ];
  let handed = 0;
  const { ended, drafted } = await runLadder({ drafts: ["What's your flight to Denver?"], messages, ladderHandOff: async () => ((handed += 1), "On it.") });
  assert.equal(handed, 1);
  assert.equal(drafted.length, 1);
  assert.deepEqual(ended, [["handed", "On it."]]);
});

test("an approval goes out as drafted, and unwired nothing changes", async () => {
  const approval = await runLadder({ drafts: ["Send the email to Sam now?"], kind: "approval" });
  assert.deepEqual(approval.ended, [["sent", "Send the email to Sam now?"]]);
  const off = await runLadder({ drafts: ["What's your flight to Denver?"], ladderOn: false });
  assert.deepEqual(off.ended, [["sent", "What's your flight to Denver?"]]);
  assert.equal(off.ai.calls, 0);
});
