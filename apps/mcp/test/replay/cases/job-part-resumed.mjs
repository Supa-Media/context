import assert from "node:assert/strict";
import { BUILTIN_PROVIDER } from "../../../src/agent/builtin.js";
import { jobOf } from "../../../src/agent/background.js";
import { runTurn } from "../../../src/agent/turn.js";
import { carriedRounds } from "../../../src/agent/turnResume.js";

const SEARCH = { name: "search_email", description: "Search mail", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } };
const USAGE = { prompt_tokens: 10, completion_tokens: 5 };

/** A job's model that searches mail until a search's result is in front of it, then reports from it. */
function model() {
  const asked = [];
  return {
    asked,
    async run(_model, input) {
      asked.push(input);
      if (input.messages.some((m) => m.role === "tool")) return { choices: [{ message: { content: "Three timecards are missing for this week." } }], usage: USAGE };
      return { choices: [{ message: { content: "", tool_calls: [{ id: `call_${asked.length}`, type: "function", function: { name: "search_email", arguments: JSON.stringify({ query: "timecards" }) } }] } }], usage: USAGE };
    },
  };
}

async function part(ai, attempt, extra, home) {
  const ran = [];
  const job = jobOf({ id: "job-replay-0001", title: "Timecards", attempt, ...extra });
  const rounds = await carriedRounds({ store: { texLedger: () => home }, session: { workspaceKind: "personal", workspaceId: "ws-replay" }, body: {}, question: "Check this week's timecards.", job, log: () => {} });
  const done = runTurn({
    question: "Check this week's timecards.",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH],
    env: { AI: ai, AGENT_BUILTIN_MODEL: "@cf/acme/main" },
    providerOptions: { ai },
    texting: true,
    resumeFrom: rounds.from,
    keepRounds: { keep: rounds.keep, marks: rounds.marks },
    callTool: async (name) => (ran.push(name), { content: [{ type: "text", text: "Payroll: 3 timecards missing (Ana, Bo, Cy)" }] }),
    ...(attempt === 1 ? { answerCheck: async () => { throw new Error("gateway died"); } } : {}),
  });
  return { ran, done, rounds };
}

export default {
  id: "job-part-resumed",
  incident: "2026-11-17: a timecards job's parts each died before answering, and every next part searched the same mail and opened the same pages again from its prompt, minutes later.",
  cause: "A job's part kept only a short list of what it had done (`jobSaved.js`); the next part started its model over from the job's prompt, so it re-planned and re-ran its reads.",
  path: "background job",
  async run() {
    const kept = new Map();
    const home = { roundsOf: async (chat, key) => kept.get(key) ?? null, keepRounds: async (chat, key, data) => void kept.set(key, structuredClone(data)), forgetRounds: async (chat, key) => void kept.delete(key) };
    const first = await part(model(), 1, {}, home);
    await assert.rejects(first.done, /gateway died/);
    await first.rounds.flush();
    assert.deepEqual(first.ran, ["search_email"]);
    // The Worker names part 1 for part 2 (`apps/agent/src/jobPartResume.ts`): part 2 reads its saved rounds and searches nothing again.
    const ai = model();
    const second = await part(ai, 2, { resumeFrom: 1 }, home);
    assert.ok(second.rounds.from, "part 2 found what part 1 had done");
    assert.equal((await second.done).answer, "Three timecards are missing for this week.");
    assert.deepEqual(second.ran, [], "part 2 searched nothing again");
    assert.equal(ai.asked.length, 1, "one model round, from where part 1 was");
  },
};
