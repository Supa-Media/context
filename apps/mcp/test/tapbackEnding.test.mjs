/**
 * A TAPBACK AS THE WHOLE ANSWER (`../../../packages/tex/gateway/agent/tapbackEnding.js`, node `tapback`; Dev2, 2026-11-17).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `tapbackNode` ignoring `lastFailed`.
 *     → "the node refuses a tapback after a failed call, and one not on the list" fails.
 *  2. `endsTurn` settling on a refused call (`chosen` set before the gate answers).
 *     → "a refused tapback goes back to the model and never ends the turn" fails.
 *  3. `tapbackOf` reading any emoji in the mark.
 *     → "the turn's answer carries the emoji and reads back only one of the 64" fails.
 *  4. `tapbackOf` not checking `settled`.
 *     → "the turn's answer carries the emoji and reads back only one of the 64" fails.
 *  5. `lastCallFailed` reading the whole history.
 *     → "only this turn's last call before it counts as failed" fails.
 *  6. `turn.js` settling without `roundFailed`.
 *     → "through the turn: a save that fails in the same round, after the tapback, keeps the turn going to words" fails.
 *  7. `turn.js` telling the Worker a tool started on `tapback`.
 *     → "through the turn: a tapback after a save ends it at once, ... with no early tapback of the Worker's" fails.
 *  8. The config's wire `tools -> tapback` dropped.
 *     → "wired on main: off the shelf, a send action, and a chat turn is offered it" fails.
 *  9. `runTheModel.js` offering it on their own tapback (`reactable` always true).
 *     → "through /agent: never offered where the Worker can't react, as on their own tapback" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TAPBACK_TOOL, eitherEnds, lastCallFailed, tapbackAnswer, tapbackEmoji, tapbackEnding, tapbackOf, tapbackSaidLine } from "../../../packages/tex/gateway/agent/tapbackEnding.js";
import { tapbackNode } from "../../../packages/tex/gateway/agent/graph/nodes/tapback.js";
import { GATEWAY_NODES } from "../../../packages/tex/gateway/agent/graph/gatewayNodes.js";
import { gatewayGraph } from "../../../packages/tex/gateway/agent/graph/gatewayGraph.js";
import { TEX_CONFIG, texToolList, withDraft } from "../../../packages/tex/gateway/agent/texConfig.js";
import { ASSISTANT_SEND_ACTIONS } from "../../../packages/tex/gateway/agent/sixTools.js";
import SHELF from "../../../packages/tex/src/texNodeShelf.json" with { type: "json" };

const gateOf = (input) => tapbackNode(input);

test("an emoji is one of the 64, by itself, without its variation selector, or by name", () => {
  assert.equal(tapbackEmoji("📅"), "📅");
  assert.equal(tapbackEmoji("❤"), "❤️");
  assert.equal(tapbackEmoji("thumbs up"), "👍");
  assert.equal(tapbackEmoji("✅"), null, "never ✅: it says done before anything is");
  assert.equal(tapbackEmoji("🗓️"), null, "not on the list");
  assert.equal(tapbackEmoji(""), null);
  assert.equal(tapbackEmoji(undefined), null);
});

test("the node refuses a tapback after a failed call, and one not on the list", async () => {
  assert.deepEqual(await tapbackNode({ emoji: "📅" }), { to: "react", emoji: "📅" });
  assert.equal((await tapbackNode({ emoji: "📅", lastFailed: true })).to, "refuse");
  assert.equal((await tapbackNode({ emoji: "✅" })).to, "refuse");
  assert.equal((await tapbackNode({ emoji: "📅", tagged: true })).to, "refuse", "a literal @Tex is answered in words, as say_nothing is refused there");
});

test("a tapback ends the turn with nothing texted, and the turn's answer carries the emoji", async () => {
  const ending = tapbackEnding({ gate: gateOf });
  assert.equal(ending.endsTurn(TAPBACK_TOOL), null, "nothing settles before the call");
  const result = await ending.local.call({ emoji: "📅", why: "added it" }, { messages: [{ role: "tool", isError: false }] });
  assert.notEqual(result.isError, true);
  assert.equal(ending.endsTurn(TAPBACK_TOOL), tapbackAnswer("📅"));
  assert.equal(ending.endsTurn("say_nothing"), null, "only its own call");
  assert.equal(ending.endsTurn(TAPBACK_TOOL, {}, { roundFailed: true }), null, "a call beside it that failed after it: the turn goes on, in words");
});

test("a tagged turn's tapback is refused", async () => {
  const ending = tapbackEnding({ gate: gateOf, tagged: true });
  assert.equal((await ending.local.call({ emoji: "👍" }, { messages: [] })).isError, true);
  assert.equal(ending.endsTurn(TAPBACK_TOOL), null);
});

test("a refused tapback goes back to the model and never ends the turn", async () => {
  const ending = tapbackEnding({ gate: gateOf });
  const failedFirst = await ending.local.call({ emoji: "👍" }, { messages: [{ role: "tool", isError: true }] });
  assert.equal(failedFirst.isError, true);
  assert.match(failedFirst.content[0].text, /Write your reply in words/);
  assert.equal(ending.endsTurn(TAPBACK_TOOL), null);
  const broken = tapbackEnding({ gate: async () => { throw new Error("down"); } });
  assert.equal((await broken.local.call({ emoji: "👍" }, {})).isError, true, "a gate that fails refuses");
  assert.equal(broken.endsTurn(TAPBACK_TOOL), null);
});

test("the turn's answer carries the emoji and reads back only one of the 64", () => {
  const settled = (answer) => ({ answer, settled: TAPBACK_TOOL });
  assert.equal(tapbackOf(settled(tapbackAnswer("❤️"))), "❤️");
  assert.equal(tapbackOf({ answer: tapbackAnswer("❤️") }), null, "the mark typed as words never reacts: only a turn the call settled");
  assert.equal(tapbackOf(settled("[[tex:tapback:✅]]")), null);
  assert.equal(tapbackOf(settled("ok 👍")), null);
  assert.equal(tapbackOf({ answer: "[[tex:quiet-ack]]", settled: "start_background_job" }), null);
  assert.match(tapbackSaidLine("📅"), /reacted 📅 to their text/);
});

test("only this turn's last call before it counts as failed", () => {
  assert.equal(lastCallFailed([]), false);
  assert.equal(lastCallFailed([{ role: "user" }, { role: "tool", isError: true }, { role: "assistant" }, { role: "user" }]), false, "a call an earlier turn made never counts");
  assert.equal(lastCallFailed([{ role: "tool", isError: true }, { role: "user" }, { role: "tool", isError: false }]), false);
  assert.equal(lastCallFailed([{ role: "tool", isError: true }, { role: "assistant" }, { role: "tool", isError: false }]), false);
  assert.equal(lastCallFailed([{ role: "tool", isError: false }, { role: "tool", isError: true }]), true);
});

test("two endings compose: a started job's still settles beside it", () => {
  const job = (name) => (name === "start_background_job" ? "[[tex:quiet-ack]]" : null);
  const tap = (name) => (name === TAPBACK_TOOL ? tapbackAnswer("👍") : null);
  const both = eitherEnds(job, (name, args, round) => (round?.roundFailed ? null : tap(name, args)));
  assert.equal(both(TAPBACK_TOOL, {}, { roundFailed: true }), null, "the round passes through");
  assert.equal(both("start_background_job"), "[[tex:quiet-ack]]");
  assert.equal(both(TAPBACK_TOOL), tapbackAnswer("👍"));
  assert.equal(eitherEnds(null, tap), tap);
  assert.equal(eitherEnds(job, null), job);
  assert.equal(eitherEnds(null, null), null);
});

test("wired on main: off the shelf, a send action, and a chat turn is offered it", () => {
  assert.equal(typeof GATEWAY_NODES.tapback, "function");
  assert.equal(SHELF.nodes.tapback, undefined, "promoted: the shelf no longer names it");
  assert.equal(ASSISTANT_SEND_ACTIONS.tapback.tool, TAPBACK_TOOL);
  assert.equal(TEX_CONFIG.nodes.some((node) => node.id === "tapback"), true);
  assert.equal(gatewayGraph().wired("tools", "tapback"), true, "the config wires tools -> tapback");
});

test("a Lab draft that wires it runs the node over the wire, with its shape", async () => {
  const node = {
    id: "tapback", label: "Tapback", model: "code", group: "tools-subagents", x: 900, y: 160,
    inSchema: [{ name: "emoji", type: "text" }, { name: "why", optional: true, type: "text" }, { name: "lastFailed", optional: true, type: "yesno" }, { name: "tagged", optional: true, type: "yesno" }],
    outSchema: [{ name: "to", options: "react, refuse", type: "choice" }, { name: "emoji", optional: true, type: "text" }, { name: "why", optional: true, type: "text" }],
  };
  const bare = { nodes: TEX_CONFIG.nodes.filter((n) => n.id !== "tapback"), edges: TEX_CONFIG.edges.filter((e) => e.to !== "tapback") };
  const draft = { nodes: [...bare.nodes, node], edges: [...bare.edges, { from: "tools", to: "tapback", mode: "uses", when: ["tapback"] }] };
  const config = withDraft(TEX_CONFIG, draft);
  const graph = gatewayGraph({ config });
  assert.equal(graph.wired("tools", "tapback"), true);
  assert.deepEqual(await graph.fire("tools", "tapback", { emoji: "📅", why: "added", lastFailed: false, tagged: false }), { to: "react", emoji: "📅" });
  const ending = tapbackEnding({ gate: (input) => graph.fire("tools", "tapback", input) });
  await ending.local.call({ emoji: "🎉" }, { messages: [] });
  assert.equal(ending.endsTurn(TAPBACK_TOOL), tapbackAnswer("🎉"));
});

/* ---------------- through the turn (`turn.js`): the six-tool `send` action, the round's settle, the early tapback ---------------- */

const MAIN = "@cf/acme/main-model";
const writeTool = { name: "write_note", description: "write_note", inputSchema: { type: "object", properties: {} } };

function scripted(replies) {
  const calls = [];
  return {
    calls,
    async run(_model, input) {
      calls.push(structuredClone(input));
      const reply = replies.shift();
      if (!reply) throw new Error("script ran out");
      const tool_calls = (reply.calls ?? []).map((call, i) => ({ id: `call_${calls.length}_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }));
      return { choices: [{ message: { content: reply.text ?? "", tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}

async function tapTurn(replies, { writeFails = false } = {}) {
  const { runTurn } = await import("../../../packages/tex/gateway/agent/turn.js");
  const { BUILTIN_PROVIDER } = await import("../../../packages/tex/gateway/agent/builtin.js");
  const ai = scripted(replies);
  const ending = tapbackEnding({ gate: gateOf });
  const started = [];
  const result = await runTurn({
    question: "add dinner with Sam on Friday",
    history: [],
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [writeTool],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    sayNothing: true,
    endsTurn: eitherEnds(null, ending.endsTurn),
    local: [ending.local],
    onToolStart: (name) => started.push(name),
    callTool: async () => (writeFails ? { isError: true, content: [{ type: "text", text: "could not save" }] } : { content: [{ type: "text", text: "saved" }] }),
  });
  return { ai, result, started };
}

const tap = (emoji) => ({ name: "send", args: { action: "tapback", args: { emoji, why: "added it" } } });
const save = { name: "write", args: { path: "plans/friday.md", content: "Dinner with Sam" } };

test("through the turn: a tapback after a save ends it at once, settled by the tapback, with no early tapback of the Worker's", async () => {
  const { ai, result, started } = await tapTurn([{ calls: [save] }, { calls: [tap("📅")] }]);
  assert.equal(result.settled, TAPBACK_TOOL);
  assert.equal(tapbackOf(result), "📅");
  assert.equal(ai.calls.length, 2, "no model round after it");
  assert.equal(started.includes(TAPBACK_TOOL), false, "the model's own tapback is not a tool start the Worker taps for");
  assert.match(JSON.stringify(ai.calls[0].tools), /tapback: Answer their text with only a tapback/, "offered as a send action when the turn holds it");
});

test("through the turn: a save that fails in the same round, after the tapback, keeps the turn going to words", async () => {
  const { ai, result } = await tapTurn([{ calls: [tap("👍"), save] }, { text: "I couldn't save that, want me to try again?" }], { writeFails: true });
  assert.equal(tapbackOf(result), null);
  assert.equal(ai.calls.length, 2);
  assert.match(result.answer, /couldn't save/);
});

test("through the turn: after a failed save, the tapback is refused and the model writes words", async () => {
  const { result } = await tapTurn([{ calls: [save] }, { calls: [tap("📅")] }, { text: "That didn't save. Try again?" }], { writeFails: true });
  assert.equal(tapbackOf(result), null);
  assert.match(result.answer, /didn't save/);
});

test("in a Lab test chat the tapback runs for real, so it ends the turn there too (2026-11-17: answered as a write, Tex texted \"Heart sent.\")", async () => {
  const { sandboxedTool, LAB_SANDBOX_KEY } = await import("../src/labSandbox/policy.js");
  const gate = { record() {}, async kvGet() { return null; }, async kvPut() {} };
  const env = { [LAB_SANDBOX_KEY]: gate };
  assert.equal(await sandboxedTool(env, { name: TAPBACK_TOOL, args: { emoji: "❤️" } }), null, "not answered by the sandbox: the turn's own local tool runs");
});

test("through /agent: never offered where the Worker can't react, as on their own tapback", async () => {
  const { oneToOne } = await import("./replay/chats.mjs");
  const offered = (chat, from) => chat.world.model.requests.slice(from).some((request) => JSON.stringify(request.tools ?? []).includes("- tapback:"));
  const chat = await oneToOne();
  try {
    let from = chat.world.model.requests.length;
    await chat.text("perfect thank you", "Anytime.");
    assert.equal(offered(chat, from), true, "a text of theirs is offered the tapback");
    from = chat.world.model.requests.length;
    await chat.text("Loved \u201cAnytime.\u201d", "", { body: { quoted: "Anytime.", tapback: "Loved" } });
    // On the fixed list every 1:1 turn is shown the tapback, and a turn that doesn't hold it is refused the call.
    if (texToolList("fd", TEX_CONFIG) !== "fixed") assert.equal(offered(chat, from), false, "their own tapback is never tapped back");
  } finally {
    chat.restore?.();
  }
});
