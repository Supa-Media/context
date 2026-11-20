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

const WRITE = { name: "write_note", description: "Save a note", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } }, annotations: { readOnlyHint: false } };
const say = (content) => ({ choices: [{ message: { content } }], usage: USAGE });
const call = (id, name, args) => ({ choices: [{ message: { content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: USAGE });
const LIST = { path: "work/missing-timecards.md", content: "Missing this week: Ana, Bo, Cy" };
const REPORT = "Three timecards are missing; the list is in work/missing-timecards.md.";

/** A job's model that searches mail, saves the list as a note, then reports: each step only once what it needs is in front of it. */
function savingModel({ dies = false } = {}) {
  const asked = [];
  return {
    asked,
    async run(_model, input) {
      asked.push(input);
      const results = JSON.stringify(input.messages.filter((m) => m.role === "tool"));
      if (/Saved work\/missing-timecards\.md/.test(results)) {
        if (dies) throw new Error("model down"); // the part dies after the save and before the report
        return say(REPORT);
      }
      if (/3 timecards missing/.test(results)) return call(`call_w${asked.length}`, "write_note", LIST);
      return call(`call_s${asked.length}`, "search_email", { query: "timecards" });
    },
  };
}

async function savingPart(ai, extra, home) {
  const ran = [];
  const job = jobOf({ id: "job-replay-0002", title: "Timecards", attempt: 1, ...extra });
  const rounds = await carriedRounds({ store: { texLedger: () => home }, session: { workspaceKind: "personal", workspaceId: "ws-replay" }, body: {}, question: "Check this week's timecards and save who is missing.", job, log: () => {} });
  const done = runTurn({
    question: "Check this week's timecards and save who is missing.",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH, WRITE],
    env: { AI: ai, AGENT_BUILTIN_MODEL: "@cf/acme/main" },
    providerOptions: { ai },
    texting: true,
    resumeFrom: rounds.from,
    keepRounds: { keep: rounds.keep, marks: rounds.marks },
    callTool: async (name, args) => (ran.push(name), { content: [{ type: "text", text: name === "write_note" ? `Saved ${args.path}` : "Payroll: 3 timecards missing (Ana, Bo, Cy)" }] }),
  });
  return { ran, done, rounds };
}

export default {
  id: "job-part-resumed",
  incident: "2026-11-17: a timecards job's parts each died before answering, and every next part searched the same mail and opened the same pages again from its prompt, minutes later. 2026-11-20 (durable jobs review): a part that had saved a note and then died had its try after save the note again.",
  cause: "A job's part kept only a short list of what it had done (`jobSaved.js`); the next part started its model over from the job's prompt, so it re-planned and re-ran its reads. Then the saved rounds (`savedRounds.js` `carriesOn`) kept only reads, so a part's snapshot froze before its first note write, and the try after ran that write again.",
  path: "background job",
  async run() {
    const kept = new Map();
    const home = { roundsOf: async (chat, key) => kept.get(key) ?? null, keepRounds: async (chat, key, data) => void kept.set(key, structuredClone(data)), forgetRounds: async (chat, key) => void kept.delete(key) };
    const first = await part(model(), 1, {}, home);
    await assert.rejects(first.done, /gateway died/);
    await first.rounds.flush();
    assert.deepEqual(first.ran, ["search_email"]);
    // The Worker names part 1 for part 2 (`packages/tex/worker/jobPartResume.ts`): part 2 reads its saved rounds and searches nothing again.
    const ai = model();
    const second = await part(ai, 2, { resumeFrom: 1 }, home);
    assert.ok(second.rounds.from, "part 2 found what part 1 had done");
    assert.equal((await second.done).answer, "Three timecards are missing for this week.");
    assert.deepEqual(second.ran, [], "part 2 searched nothing again");
    assert.equal(ai.asked.length, 1, "one model round, from where part 1 was");
    // A part that saved a note, then died: the workflow tries it again, and the note is not saved twice (the action log, `turnResume.js`).
    const notes = new Map();
    const saved = { roundsOf: async (chat, key) => notes.get(key) ?? null, keepRounds: async (chat, key, data) => void notes.set(key, structuredClone(data)), forgetRounds: async (chat, key) => void notes.delete(key) };
    const firstSave = await savingPart(savingModel({ dies: true }), {}, saved);
    await assert.rejects(firstSave.done, /model failed/);
    await firstSave.rounds.flush();
    assert.deepEqual(firstSave.ran, ["search_email", "write_note"]);
    // The workflow tries part 1 again (`packages/tex/worker/jobWorkflow.ts`): the try reads that the note was saved.
    const saver = savingModel();
    const again = await savingPart(saver, { resumeFrom: 1 }, saved);
    assert.ok(again.rounds.from, "the try found what part 1 had done");
    assert.equal((await again.done).answer, REPORT);
    assert.deepEqual(again.ran, [], "the note is not saved again, and the mail not searched again");
    assert.equal(saver.asked.length, 1, "one model round, from after the save");
  },
};
