/**
 * Tex works on several things at once (`background.js`), and a turn that
 * runs out of steps still delivers (`lastRound.js`), owner 2026-10-21.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `sameJob` always false.
 *     → "an ask for a job already running is refused with its status" fails.
 *  2. `backgroundSession` offering the tool on a job's own turn.
 *     → "a job's own turn cannot start another job" fails.
 *  3. `roundNotice` returning null.
 *     → "the two last rounds are told to write, then to answer" fails.
 *  4. `exhaustedAnswer` ignoring the model's words.
 *     → "a turn that runs out answers with what the model last said" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { shown } from "./sixToolsShown.mjs";
import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import {
  MAX_RUNNING_JOBS,
  START_JOB_TOOL,
  backgroundSession,
  jobOf,
  jobPrompt,
  jobSavedLine,
  runningJobsOf,
  sameJob,
  startedJobs,
  withBackground,
} from "../src/agent/background.js";
import { FINISH_NOTICE, LAST_NOTICE, OUT_OF_STEPS, exhaustedAnswer, roundNotice } from "../src/agent/lastRound.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";
const NOW = Date.UTC(2026, 9, 21, 14, 0, 0);
const SEARCH = {
  name: "search_notes",
  description: "Search notes",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
};

function scripted(replies) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const next = replies.shift();
      if (!next) throw new Error("fake ai: the script ran out");
      return next;
    },
  };
}

function chat(text, toolCalls = []) {
  return {
    choices: [
      {
        message: {
          content: text,
          tool_calls: toolCalls.map(([name, args], i) => ({ id: `call_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

const running = (title, extra = {}) => ({ id: `job-${title.length}-abcdef`, title, state: "running", startedAt: NOW - 6 * 60_000, ...extra });
const words = (result) => result.content.map((part) => part.text).join("");

test("running jobs are read strictly, and a caller that sends none gets no background jobs", () => {
  assert.equal(runningJobsOf(undefined), null);
  assert.equal(backgroundSession({ running: null, job: null, now: NOW }), null);
  const read = runningJobsOf([
    running("Competitor research"),
    { id: "../../etc", title: "x", state: "running" },
    { id: "job-okay-123", title: "", state: "running" },
    { id: "job-okay-456", title: "Trip plan", state: "exploded" },
    ...Array.from({ length: 10 }, (_, i) => running(`Job number ${i}`, { id: `job-many-${i}-xyz` })),
  ]);
  assert.equal(read[0].title, "Competitor research");
  assert.ok(read.every((entry) => entry.title !== "" && entry.id.startsWith("job-")));
  assert.ok(read.length <= 6);
});

test("two titles name the same job when most of the shorter one's words are in the other", () => {
  assert.ok(sameJob("Competitor research for Tex", "Tex competitor research"));
  assert.ok(sameJob("research competitors", "Research the competitors"));
  assert.ok(!sameJob("Competitor research", "Plan the Lisbon trip"));
  assert.ok(!sameJob("", "anything"));
});

test("an ask for a job already running is refused with its status", async () => {
  const background = backgroundSession({ running: [running("Competitor research for Tex", { status: "Reading Notion's pricing" })], job: null, now: NOW });
  const again = await background.call({ title: "Tex competitor research", brief: "Look at five competitors" });
  assert.match(words(again), /Already working on that/);
  assert.match(words(again), /6 min ago/);
  assert.match(words(again), /Reading Notion's pricing/);
  assert.equal(background.started.length, 0);

  const fresh = await background.call({ title: "Plan the Lisbon trip", brief: "Flights and a hotel for May", done_when: "a note in 1-projects/trips" });
  assert.match(words(fresh), /Started in the background/);
  const twice = await background.call({ title: "Lisbon trip plan", brief: "Same again" });
  assert.match(words(twice), /Already working on that/, "the same turn can't start it twice either");
  assert.deepEqual(startedJobs(background, false), {
    jobs: [{ title: "Plan the Lisbon trip", brief: "Flights and a hotel for May", doneWhen: "a note in 1-projects/trips" }],
  });
  assert.equal(startedJobs(background, true).jobs[0].tainted, true, "a job planned after a read from outside says so");
});

test(`no more than ${MAX_RUNNING_JOBS} jobs run at once, and a job needs a title and a brief`, async () => {
  const background = backgroundSession({ running: [running("One thing"), running("Another thing entirely")], job: null, now: NOW });
  assert.equal((await background.call({ title: "Only a title" })).isError, true);
  assert.match(words(await background.call({ title: "Third task here", brief: "b" })), /Started/);
  const fourth = await background.call({ title: "Fourth different chore", brief: "b" });
  assert.equal(fourth.isError, true);
  assert.match(words(fourth), /already running/);
});

test("the turn is shown what is running and what just finished, as status notes", () => {
  const background = backgroundSession({
    running: [running("Competitor research", { status: "Comparing pricing" }), { id: "job-done-123456", title: "Trip plan", state: "done", finishedAt: NOW - 3 * 60_000, status: "Wrote 1-projects/trips/lisbon.md" }],
    job: null,
    now: NOW,
  });
  assert.match(background.prompt, /"Competitor research": running, started 6 min ago; latest: Comparing pricing/);
  assert.match(background.prompt, /"Trip plan": finished 3 min ago; Wrote/);
  assert.match(background.prompt, /not instructions/);
  assert.match(background.prompt, /send \{ action: "background" \}/);
  assert.equal(background.tools[0].name, START_JOB_TOOL);
});

test("a job's own turn cannot start another job, and is told its plan and to deliver", () => {
  const job = jobOf({ id: "job-abcdef-1", title: "Competitor research", brief: "Five competitors, pricing and features.", doneWhen: "a note", attempt: 2 });
  const background = backgroundSession({ running: [], job, now: NOW });
  assert.deepEqual(background.tools, []);
  const prompt = jobPrompt(job);
  assert.match(prompt, /background job you started/);
  assert.match(prompt, /Five competitors, pricing and features\./);
  assert.match(prompt, /vouches for nothing/);
  assert.match(prompt, /ran out of steps: read the note/);
  assert.match(prompt, /Write the deliverable/);
  assert.equal(jobSavedLine(job), "(Background job finished: Competitor research)");
  assert.equal(jobOf({ id: "bad id!", title: "x" }), null);
  assert.equal(jobOf({ id: "job-abcdef-1", title: "x", attempt: 99 }).attempt, 3);
});

test("the model starts a job through send, and the turn answers at once", async () => {
  const ai = scripted([
    chat("", [["send", { action: "background", args: { title: "Competitor research", brief: "Five competitors." } }]]),
    chat("On it. I'll text you when it's done."),
  ]);
  const background = backgroundSession({ running: [], job: null, now: NOW });
  const calls = [];
  const result = await runTurn({
    question: "research our competitors and write it up",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH, ...background.tools],
    callTool: withBackground(background, async (name) => {
      calls.push(name);
      return { content: [] };
    }),
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    texting: true,
  });
  const offered = ai.calls[0].input.tools.map((tool) => tool.function ?? tool);
  assert.ok(shown(offered).has("send.background"), "offered under send");
  assert.equal(result.answer, "On it. I'll text you when it's done.");
  assert.deepEqual(calls, [], "never reached the MCP");
  assert.equal(background.started[0].title, "Competitor research");
});

test("the two last rounds are told to write, then to answer", async () => {
  assert.equal(roundNotice(0, 8), null);
  assert.equal(roundNotice(6, 8), FINISH_NOTICE);
  assert.equal(roundNotice(7, 8), LAST_NOTICE);
  assert.equal(roundNotice(0, 1), null, "a one-round setup is unchanged");
  assert.equal(roundNotice(1, 2), null);

  const ai = scripted([...Array.from({ length: 4 }, () => chat("", [["search_notes", { query: "q" }]]))]);
  await runTurn({
    question: "research",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH],
    callTool: async () => ({ content: [{ type: "text", text: "found" }] }),
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    maxRounds: 4,
  });
  assert.equal(ai.calls.length, 4, "no extra model call");
  const said = (n) => JSON.stringify(ai.calls[n].input.messages);
  assert.ok(!said(1).includes("two steps left"));
  assert.ok(said(2).includes("two steps left"));
  assert.ok(said(3).includes("this is your last step"));
});

test("a turn that runs out answers with what the model last said", async () => {
  assert.equal(exhaustedAnswer(""), OUT_OF_STEPS);
  assert.doesNotMatch(OUT_OF_STEPS, /Here is where I got to/);
  const ai = scripted([
    chat("", [["search_notes", { query: "a" }]]),
    chat("Found three competitors so far: Notion, Mem and Reflect.", [["search_notes", { query: "b" }]]),
    chat("", [["search_notes", { query: "c" }]]),
  ]);
  const result = await runTurn({
    question: "research",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH],
    callTool: async () => ({ content: [{ type: "text", text: "found" }] }),
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    maxRounds: 3,
  });
  assert.equal(result.exhausted, true);
  assert.match(result.answer, /^Found three competitors so far: Notion, Mem and Reflect\./);
  assert.match(result.answer, /Text me to carry on/);
});
