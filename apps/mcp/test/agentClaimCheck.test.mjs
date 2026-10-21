/**
 * A TEXTED ANSWER IS CHECKED AGAINST WHAT THE TURN DID (`claimCheck.js`),
 * from the owner's chat with Tex on 2026-10-21.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-21).
 *
 *  1. `turn.js` returning the first answer without calling `answerCheck`.
 *     → "an answer that says it added something, with no write, gets one more round" fails.
 *  2. `claimCheck` counting a failed or held call as a write.
 *     → "a write that was refused is no write" fails.
 *  3. `check` giving its notice every time it is asked.
 *     → "the notice is given once, so the check never loops" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { CLAIM_NOTICE, MUTE_NOTICE, asksToMute, claimCheck, claimsAChange } from "../src/agent/claimCheck.js";
import { runTurn } from "../src/agent/turn.js";

const MAIN = "@cf/acme/main-model";
const WRITE = {
  name: "write_note",
  description: "Write a note",
  inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
  annotations: { readOnlyHint: false },
};

test("the words from the chat that said a change was made are read as a claim, and the honest ones are not", () => {
  assert.ok(claimsAChange("You're right, I dropped that one. It's on your to-do list now, at the top under this week: check the router deploy."));
  assert.ok(claimsAChange("I've added it to your calendar for Friday."));
  assert.ok(claimsAChange("Saved it to your notes."));
  assert.ok(claimsAChange("Put it on your list."));
  assert.ok(!claimsAChange("I wrote up the bug. It's about me not being able to forward the receipt with its PDF attached."));
  assert.ok(!claimsAChange("I can't attach the PDF from here, so forward it yourself."));
  assert.ok(!claimsAChange("Want me to add a to-do to check the router deploy?"));
});

test("a text asking never to be texted about something is a mute", () => {
  assert.ok(asksToMute("never message me about github stuff unless i ask"));
  assert.ok(asksToMute("Stop texting me about deploys"));
  assert.ok(asksToMute("no more pings about CI please"));
  assert.ok(!asksToMute("what's on my list today?"));
  assert.ok(!asksToMute("tell me about the github outage"));
});

test("a write that went through clears a claim; a write that was refused is no write", async () => {
  const done = claimCheck({ question: "add it to my to-do list" });
  await done.wrap(async () => ({ content: [{ type: "text", text: "Saved." }] }))("write_note", { path: "todo.md", content: "x" });
  assert.equal(done.check("It's on your to-do list now."), null);

  const refused = claimCheck({ question: "add it to my to-do list" });
  await refused.wrap(async () => ({ isError: true, content: [{ type: "text", text: "Not saved." }] }))("write_note", { path: "todo.md", content: "x" });
  assert.equal(refused.check("It's on your to-do list now."), CLAIM_NOTICE);

  const read = claimCheck({ question: "add it to my to-do list" });
  await read.wrap(async () => ({ content: [{ type: "text", text: "..." }] }))("read_note", { path: "todo.md" });
  assert.equal(read.check("It's on your to-do list now."), CLAIM_NOTICE, "a read is not a write");
});

test("\"Will do.\" to a mute, with nothing kept, is sent back; kept in tex/attention.md, it goes", async () => {
  const question = "never message me about github stuff unless i ask";
  const forgot = claimCheck({ question });
  assert.equal(forgot.check("Will do."), MUTE_NOTICE);

  const elsewhere = claimCheck({ question });
  await elsewhere.wrap(async () => ({ content: [] }))("write_note", { path: "todo.md", content: "x" });
  assert.equal(elsewhere.check("Will do."), MUTE_NOTICE, "a write somewhere else keeps nothing");

  const kept = claimCheck({ question });
  await kept.wrap(async () => ({ content: [] }))("write_note", { path: "tex/attention.md", content: "---\nmute: [github]\n---\n" });
  assert.equal(kept.check("Muted github."), null);
});

test("the notice is given once, so the check never loops", () => {
  const once = claimCheck({ question: "hi" });
  assert.equal(once.check("I've added it."), CLAIM_NOTICE);
  assert.equal(once.check("I've added it."), null);
});

/** A Workers AI binding that answers from a script, one reply per call. */
function scripted(replies) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push(input.messages);
      const reply = replies.shift();
      if (!reply) throw new Error("script ran out");
      const tool_calls = (reply.calls ?? []).map((call, i) => ({
        id: `call_${calls.length}_${i}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
      return { choices: [{ message: { content: reply.text ?? "", tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}

function turn(ai, claims, callTool) {
  return runTurn({
    question: "do it for me, and if you can't do it, file a bug",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [WRITE],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    answerCheck: claims.check,
    callTool: claims.wrap(callTool),
  });
}

test("an answer that says it added something, with no write, gets one more round", async () => {
  const ai = scripted([{ text: "It's on your to-do list now, at the top under this week." }, { text: "I haven't added it yet. Want me to?" }]);
  const claims = claimCheck({ question: "do it for me" });
  const result = await turn(ai, claims, async () => ({ content: [] }));
  assert.equal(result.answer, "I haven't added it yet. Want me to?");
  assert.equal(ai.calls.length, 2);
  assert.ok(JSON.stringify(ai.calls[1]).includes("no change to their notes went through"), "the second round is told why");
});

test("an answer backed by a write that went through goes as it is, in one round", async () => {
  const ai = scripted([
    { calls: [{ name: "write_note", args: { path: "todo.md", content: "- check the router" } }] },
    { text: "It's on your to-do list now." },
  ]);
  const claims = claimCheck({ question: "add it" });
  const result = await turn(ai, claims, async () => ({ content: [{ type: "text", text: "Saved todo.md." }] }));
  assert.equal(result.answer, "It's on your to-do list now.");
  assert.equal(ai.calls.length, 2);
});
