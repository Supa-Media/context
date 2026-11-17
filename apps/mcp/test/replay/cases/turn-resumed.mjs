import assert from "node:assert/strict";
import { BUILTIN_PROVIDER } from "../../../src/agent/builtin.js";
import { checkedSnapshot } from "../../../src/agent/savedRounds.js";
import { runTurn } from "../../../src/agent/turn.js";

const SEARCH = { name: "search_notes", description: "Search notes", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } };
const USAGE = { prompt_tokens: 10, completion_tokens: 5 };
const searched = (id) => ({ choices: [{ message: { content: "", tool_calls: [{ id, type: "function", function: { name: "search_notes", arguments: JSON.stringify({ query: "piano lesson" }) } }] } }], usage: USAGE });

/** A model that searches until it has a search's result in front of it, then answers from it. */
function model() {
  const asked = [];
  return { asked, async run(_model, input) { asked.push(input); return input.messages.some((m) => m.role === "tool") ? { choices: [{ message: { content: "Thursday at 5." } }], usage: USAGE } : searched(`call_${asked.length}`); } };
}

function turn(ai, extra) {
  const ran = [];
  const done = runTurn({
    question: "When is Mira's piano lesson?",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH],
    env: { AI: ai, AGENT_BUILTIN_MODEL: "@cf/acme/main" },
    providerOptions: { ai },
    texting: true,
    callTool: async (name) => (ran.push(name), { content: [{ type: "text", text: "Piano: Thursdays 5pm with Mr. Oduya" }] }),
    ...extra,
  });
  return { ran, done };
}

export default {
  id: "turn-resumed",
  incident: "2026-11-17: a texted turn that died after its tools ran (a crash in its checks, the gateway out of memory) was tried again by the Worker from the person's text, running every search and read a second time, minutes later.",
  cause: "A try kept nothing of what it had done, so the next try of the same text could only start over (Dev2 asked for LangGraph's save-after-every-step, built on our own pieces).",
  path: "1:1 text",
  async run() {
    const kept = [];
    const first = turn(model(), { keepRounds: { keep: (snapshot) => kept.push(structuredClone(snapshot)), marks: () => ({}) }, answerCheck: async () => { throw new Error("checks crashed"); } });
    await assert.rejects(first.done, /checks crashed/);
    assert.deepEqual(first.ran, ["search_notes"]);
    const resumeFrom = checkedSnapshot(kept.at(-1));
    assert.ok(resumeFrom, "the first try kept what its search returned");
    const ai = model();
    const second = turn(ai, { resumeFrom });
    assert.equal((await second.done).answer, "Thursday at 5.");
    assert.deepEqual(second.ran, [], "the try after runs no search again");
    assert.equal(ai.asked.length, 1, "and asks its model once, from where the first try was");
  },
};
