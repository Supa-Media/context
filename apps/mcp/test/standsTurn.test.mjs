/**
 * THE STANDS GATE NEVER COSTS A TURN ITS REPLY (2026-11-19; `src/agent/standsCheck.js` `standsGate`,
 * `src/agent/texEntryPoint/runTheModel.js`). The gate sends an unbacked "already done" back once. On a two-round turn
 * that send-back lands on the penultimate round, and `turn.js` runs no answer check on the last round, so a retry that
 * came back empty went out empty ("the model gave an empty answer"). `final`, run on what the turn returns, puts a
 * non-empty honest line in its place, and replaces a second unbacked claim the same way.
 *
 * Sabotage (temporary local edits, reverted): `final` returning null whenever the answer is empty makes "a send-back
 * then an empty last round" fail; `final` returning null always makes "a second unbacked claim on the last round" fail.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { STANDS_HONEST, STANDS_NOTICE, standsGate } from "../src/agent/standsCheck.js";
import { runTurn } from "../src/agent/turn.js";

const MAIN = "@cf/acme/main-model";
const DRAFT = { name: "save_email_draft", description: "Save a Gmail draft.", inputSchema: { type: "object", properties: { to: { type: "string" } } } };
const ASK = "Write Bo a short reply about the rota and save it as a Gmail draft, don't send it.";
const CLAIM = "I already saved that draft reply to Bo earlier, so I didn't make a second one.";

/** A Workers AI binding that answers from a script, one reply per call. */
function scripted(replies) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push(input.messages);
      const reply = replies.shift();
      if (!reply) throw new Error("script ran out");
      const tool_calls = (reply.calls ?? []).map((call, i) => ({ id: `call_${calls.length}_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }));
      return { choices: [{ message: { content: reply.text ?? "", tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}

/** The turn as `runTheModel.js` runs it: the gate's check as the answer check, its wrap on the calls, its `final` on what comes back. */
async function turn(ai, { maxRounds = 2, callTool = async () => ({ content: [{ type: "text", text: "Saved." }] }) } = {}) {
  const stands = standsGate({ question: ASK });
  const result = await runTurn({
    question: ASK,
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [DRAFT],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    maxRounds,
    answerCheck: (answer, context) => stands.check(answer, context),
    callTool: stands.wrap(callTool),
  });
  const honest = stands.final(result.answer, { exhausted: result.exhausted === true, silent: false });
  return { ...result, answer: honest ?? result.answer };
}

test("a send-back then an empty last round: a non-empty honest line, never an empty reply", async () => {
  const ai = scripted([{ text: CLAIM }, { text: "   " }]);
  const result = await turn(ai);
  assert.equal(ai.calls.length, 2, "one send-back, then the last round");
  assert.ok(JSON.stringify(ai.calls[1]).includes(STANDS_NOTICE.slice(0, 40)), "the retry is told why");
  assert.equal(result.answer, STANDS_HONEST);
  assert.notEqual(result.answer.trim(), "");
});

test("a second unbacked claim on the last round is replaced, not sent", async () => {
  const ai = scripted([{ text: CLAIM }, { text: "As I said, it's already saved in your drafts." }]);
  const result = await turn(ai);
  assert.equal(result.answer, STANDS_HONEST);
});

test("a claim on the last round with no send-back before it is replaced (the last round is checked too)", async () => {
  const ai = scripted([{ text: CLAIM }]);
  const result = await turn(ai, { maxRounds: 1 });
  assert.equal(result.answer, STANDS_HONEST);
});

test("a send-back then a fresh draft save: the reply goes as written", async () => {
  const ai = scripted([{ text: CLAIM }, { calls: [{ name: "save_email_draft", args: { to: "bo@example.com" } }] }, { text: "Saved a new draft to Bo in your Gmail drafts. Nothing was sent." }]);
  const result = await turn(ai, { maxRounds: 3 });
  assert.equal(result.answer, "Saved a new draft to Bo in your Gmail drafts. Nothing was sent.");
});

test("a turn the gate never sent back keeps an honest answer as it is", async () => {
  const ai = scripted([{ text: "I couldn't save the draft: Gmail refused it. Want me to try again?" }]);
  const result = await turn(ai, { maxRounds: 2 });
  assert.equal(result.answer, "I couldn't save the draft: Gmail refused it. Want me to try again?");
});
