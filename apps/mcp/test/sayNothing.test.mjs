/**
 * SAY NOTHING IS A CALL, NEVER A WORD (`src/agent/sayNothing.js`; Dev2,
 * 2026-11-05: "why do we need to send 'SKIP' lol, why not simply do nothing").
 * Built from the Tex Devs turn of 18:22:48 UTC that day: Jhon's ❓ tapback,
 * Tex answered SKIP, three reply gates sent the SKIP back as if it were a
 * text, and Tex texted the same answer and link a second time.
 *
 * Sabotage record (2026-11-05), each applied, this file run, named test failing, reverted:
 *  1. turn.js not settling the turn on the call (`withSayNothing`) → "a say_nothing call ends the turn…" fails.
 *  2. `isControlWord` check removed from replyJudge.js → "a typed SKIP is never judged…" fails.
 *  3. `sayNothing` offered whatever the option says → "only a turn that offers it…" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { QUIET_WORD } from "../src/agent/checkInGuards.js";
import { replyJudge } from "../src/agent/replyJudge.js";
import { SAID_NOTHING, SAY_NOTHING_TOOL } from "../src/agent/sayNothing.js";
import { runTurn } from "../src/agent/turn.js";

const MAIN = "@cf/acme/main-model";
const read = (name) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });

function scripted(replies) {
  const calls = [];
  const judged = [];
  return {
    calls,
    judged,
    async run(model, input) {
      if (model.startsWith("@cf/cloudflare/clef")) {
        const [name] = Object.keys(input.questions);
        judged.push(name);
        return { answers: { [name]: { type: "noul", noul: 0.9 } } };
      }
      calls.push(structuredClone(input));
      const reply = replies.shift();
      if (!reply) throw new Error("script ran out");
      const tool_calls = (reply.calls ?? []).map((call, i) => ({ id: `call_${calls.length}_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }));
      return { choices: [{ message: { content: reply.text ?? "", tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}

async function turn(replies, { sayNothing = true, judged = true } = {}) {
  const ai = scripted(replies);
  const ran = [];
  const judge = replyJudge({ setting: { model: "haiku" }, question: "❓ on Tex's \"Done\" text", history: [], request: async () => (ai.judged.push("review"), { text: '{"kind":"chat","send":true,"problems":[],"feedback":""}' }), log: () => {} });
  const result = await runTurn({
    question: "(a tapback) ❓ on your message \"Done.\"",
    history: [],
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [read("search_notes")],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    answerCheck: judged ? judge.check : null,
    sayNothing,
    callTool: async (name) => (ran.push(name), { content: [{ type: "text", text: "nothing found" }] }),
  });
  return { ai, ran, result };
}

const toolNames = (input) => (input.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
const sendDescription = (input) => JSON.stringify((input.tools ?? []).find((tool) => (tool.function?.name ?? tool.name) === "send") ?? {});

test("the quiet answer it hands on is the word every reader already treats as nothing to send", () => {
  assert.equal(SAID_NOTHING, QUIET_WORD);
});

test("a say_nothing call ends the turn at once: nothing is texted, no judge reads it, and no other round runs", async () => {
  const { ai, ran, result } = await turn([{ calls: [{ name: "send", args: { action: SAY_NOTHING_TOOL, args: { why: "a tapback on a message already answered" } } }] }]);
  assert.equal(result.answer, SAID_NOTHING);
  assert.equal(result.settled, SAY_NOTHING_TOOL);
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(ai.judged, []);
  assert.deepEqual(ran, []); // answered here, never by the MCP
});

test("a typed SKIP is never judged as a reply (the 18:22:48 turn)", async () => {
  const { ai, result } = await turn([{ text: "SKIP" }]);
  assert.equal(result.answer, "SKIP");
  assert.deepEqual(ai.judged, []);
  assert.equal(ai.calls.length, 1);
});

test("only a turn that offers it shows say_nothing", async () => {
  const offered = await turn([{ text: "Here it is." }], { judged: false });
  assert.match(sendDescription(offered.ai.calls[0]), /say_nothing/);
  const not = await turn([{ text: "Here it is." }], { sayNothing: false, judged: false });
  assert.doesNotMatch(JSON.stringify(not.ai.calls[0].tools ?? []), /say_nothing/);
  assert.ok(toolNames(not.ai.calls[0]).length > 0);
});

// A group, 2026-11-06 20:01 UTC: `{ action: "say_nothing" }` was texted as words. Dev2 chose a code catch.
test("say_nothing typed out as the reply is silence, and no judge reads it", async () => {
  const { ai, result } = await turn([{ text: '{ action: "say_nothing" }' }]);
  assert.equal(result.answer, SAID_NOTHING);
  assert.equal(result.settled, SAY_NOTHING_TOOL);
  assert.deepEqual(ai.judged, [], "nothing reviewed a draft that is never sent");
});

test("any other call typed out goes back to be made, and is never the text", async () => {
  const { ai, result } = await turn([{ text: '{ "action": "job_status" }' }, { text: "Nothing running right now." }]);
  assert.equal(result.answer, "Nothing running right now.");
  assert.match(JSON.stringify(ai.calls[1]), /job_status call written out as text/);
});
