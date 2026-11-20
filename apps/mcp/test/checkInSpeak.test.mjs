/**
 * A check-in that found mail worth a text does not stay quiet on the first
 * try (`checkInSpeak.js`). Training is the proof: an approval that leaves
 * the facts out is said, a newsletter is not.
 *
 * Sabotage: `mailWorthAText` returning true for every line → "a newsletter
 * stays quiet on the first call" fails. `sayNothingNotice` ignored → "worth
 * mail holds the first silence" fails.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CHECK_IN_SPEAK_NOTICE, mailWorthAText } from "../../../packages/tex/gateway/agent/checkInSpeak.js";
import { SAID_NOTHING } from "../../../packages/tex/gateway/agent/sayNothing.js";

const training = (id) => JSON.parse(readFileSync(new URL(`../bench/sets/training/${id}.json`, import.meta.url), "utf8"));
const textOf = (convo, id) => convo.msgs.find((m) => m.id === id).text;

test("Training check-ins: an incomplete approval is worth a text, a newsletter is not", () => {
  const loose = training("loose-ends");
  assert.equal(mailWorthAText([textOf(loose, "m1")]), true);
  assert.equal(mailWorthAText([textOf(loose, "m26")]), false);
  const hire = training("trial-hire");
  assert.equal(mailWorthAText([textOf(hire, "m3")]), true);
  assert.equal(mailWorthAText([]), false);
  assert.equal(mailWorthAText(["a receipt from the kiln"]), false);
});

const MAIN = "@cf/acme/main-model";

function scripted(replies) {
  const calls = [];
  return {
    calls,
    async run(_model, _input) {
      calls.push(1);
      const reply = replies.shift();
      if (!reply) throw new Error("script ran out");
      const tool_calls = (reply.calls ?? []).map((call, i) => ({
        id: `call_${calls.length}_${i}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      }));
      return { choices: [{ message: { content: reply.text ?? "", tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}

async function look(replies, { notice = null } = {}) {
  const { runTurn } = await import("../../../packages/tex/gateway/agent/turn.js");
  const { BUILTIN_PROVIDER } = await import("../../../packages/tex/gateway/agent/builtin.js");
  const ai = scripted(replies);
  const result = await runTurn({
    question: "New email since you last looked.",
    history: [],
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    builtinModelOverride: MAIN,
    sayNothing: true,
    sayNothingNotice: notice,
    scheduled: true,
  });
  return { ai, result };
}

const quiet = { calls: [{ name: "say_nothing", args: { why: "nothing new" } }] };

test("worth mail holds the first silence, and the text that follows is what goes out", async () => {
  const said = "The permit was approved, and the email leaves out the field and the dates. Want me to pull the permit?";
  const { ai, result } = await look([quiet, { text: said }], { notice: CHECK_IN_SPEAK_NOTICE });
  assert.equal(ai.calls.length, 2);
  assert.equal(result.answer, said);
  assert.equal(result.settled, undefined);
});

test("a second silence on worth mail stands", async () => {
  const { result } = await look([quiet, quiet], { notice: CHECK_IN_SPEAK_NOTICE });
  assert.equal(result.answer, SAID_NOTHING);
  assert.equal(result.settled, "say_nothing");
});

test("a newsletter stays quiet on the first call", async () => {
  const { ai, result } = await look([quiet, { text: "should not run" }], { notice: null });
  assert.equal(ai.calls.length, 1);
  assert.equal(result.settled, "say_nothing");
  assert.equal(result.answer, SAID_NOTHING);
});
