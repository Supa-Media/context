/**
 * A ROUTINE THAT RUNS OUT OF STEPS ENDS QUIET, AND SEES THE JOB THAT FINISHED ITS WORK (Dev2, 2026-11-09).
 *
 * Sunday 2026-11-08, Dev2's 1:1. At 9:04 pm a background job set Home in Google Maps and Tex texted "Home in Google
 * Maps ... now reads 12 Example Street". The hourly routine set up to retry the same change never saw that text.
 * A job's report answers no text of theirs, and `conversationFromLedger` dropped every Tex text that answered none.
 * So the routine ran at 10 pm and again at 11 pm. At 11 it ran out of steps. Told on its second-to-last round to
 * "write what you have where it belongs", it tried a note write that no routine run is given. Told on its last round
 * to "Answer them now in words, with no tool calls", it wrote three paragraphs about its own run ("I didn't text
 * you"). The reviewer is skipped on a last round, so they were texted. Dev2 chose all three fixes.
 *
 * Sabotage record (local edits, reverted):
 * 1. `roundNotice` ignoring `scheduled`: "a scheduled run's last two rounds ..." fails.
 * 2. turn.js back to `round < rounds - 1 ? answerCheck : null`: "the reviewer reads a scheduled run's last answer ..." fails.
 * 3. `scheduled` not passed in runTheModel.js / heartbeat.js: the source checks below fail.
 * 4. `flush` back to dropping a reply with no question: "a job's report is kept ..." fails.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { conversationFromLedger } from "../src/agent/ledgerConversation.js";
import {
  FINISH_NOTICE,
  FINISH_SCHEDULED_NOTICE,
  LAST_NOTICE,
  LAST_SCHEDULED_NOTICE,
  roundNotice,
} from "../src/agent/lastRound.js";
import { recentTextsSection, routineQuestion, runOutcome } from "../src/agent/routine.js";
import { SAID_NOTHING, SAY_NOTHING_TOOL } from "../src/agent/sayNothing.js";
import { runTurn } from "../src/agent/turn.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";
const SEARCH = {
  name: "search_notes",
  description: "Search notes",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
/** What the 11 pm run texted, its first paragraph. */
const LEAKED =
  "I signed in to Google Maps through the account chooser and opened the Saved panel. I haven't read the Home place yet, so I can't say whether it changed. I didn't change anything, and I didn't text you.";

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
    choices: [{ message: { content: text, tool_calls: toolCalls.map(([name, args], i) => ({ id: `call_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

const browsing = (n) => Array.from({ length: n }, () => chat("", [["search_notes", { query: "maps" }]]));

function turn(ai, extra) {
  return runTurn({
    question: "This is a scheduled routine, not a text from a person.",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH],
    callTool: async () => ({ content: [{ type: "text", text: "found" }] }),
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    maxRounds: 4,
    sayNothing: true,
    ...extra,
  });
}

test("a scheduled run's last two rounds say silence is the answer, and never ask for a note", async () => {
  assert.equal(roundNotice(2, 4, { scheduled: true }), FINISH_SCHEDULED_NOTICE);
  assert.equal(roundNotice(3, 4, { scheduled: true }), LAST_SCHEDULED_NOTICE);
  assert.equal(roundNotice(2, 4), FINISH_NOTICE, "a texted turn is unchanged");
  assert.equal(roundNotice(3, 4), LAST_NOTICE);
  assert.equal(roundNotice(0, 4, { scheduled: true }), null);
  for (const notice of [FINISH_SCHEDULED_NOTICE, LAST_SCHEDULED_NOTICE]) {
    assert.match(notice, /say_nothing/);
    assert.doesNotMatch(notice, /note/i, "a routine run has no note write");
  }
  assert.doesNotMatch(LAST_SCHEDULED_NOTICE, /Answer them now in words/);

  const ai = scripted([...browsing(3), chat("", [[SAY_NOTHING_TOOL, { why: "Home not read yet." }]])]);
  const result = await turn(ai, { scheduled: true });
  const said = (n) => JSON.stringify(ai.calls[n].input.messages);
  assert.ok(said(2).includes("nobody is waiting on it"));
  assert.ok(said(3).includes("Never text them about this run itself"));
  assert.equal(result.answer, SAID_NOTHING, "say_nothing on the last round still ends it quiet");
  assert.equal(runOutcome(result.answer).outcome, "skipped");
});

test("the reviewer reads a scheduled run's last answer, and one it sends back is never texted", async () => {
  const read = [];
  const answerCheck = async (text) => {
    read.push(text);
    return /didn't text you/.test(text) ? "not_for_them: this explains Tex's own run." : null;
  };
  const leaked = await turn(scripted([...browsing(3), chat(LEAKED)]), { scheduled: true, answerCheck });
  assert.deepEqual(read, [LEAKED], "read on the last round");
  assert.equal(leaked.answer, SAID_NOTHING);
  assert.equal(leaked.settled, SAY_NOTHING_TOOL);
  assert.equal(runOutcome(leaked.answer).outcome, "skipped", "the routine keeps a quiet run, nothing texted");

  const found = await turn(scripted([...browsing(3), chat("DONE: Home in Google Maps now reads 12 Example Street.")]), { scheduled: true, answerCheck });
  assert.match(found.answer, /^DONE: Home/, "a passed last answer still goes");

  read.length = 0;
  const texted = await turn(scripted([...browsing(3), chat(LEAKED)]), { answerCheck });
  assert.deepEqual(read, [], "a texted turn's last round is not reviewed again: someone is waiting on it");
  assert.equal(texted.answer, LEAKED);
});

test("routine runs and check-ins are run as scheduled", () => {
  const model = readFileSync(new URL("../src/agent/texEntryPoint/runTheModel.js", import.meta.url), "utf8");
  assert.match(model, /scheduled: runner === true/);
  const heartbeat = readFileSync(new URL("../src/agent/heartbeat.js", import.meta.url), "utf8");
  assert.match(heartbeat, /scheduled: true,/);
});

test("a routine is told only DONE: stops it, since a run can't archive its note", () => {
  const routine = { path: "tex/routines/hourly/maps-home.md", cadence: { unit: "hour", every: 1 }, settings: {}, body: "Change Home, then archive this note to stop the routine." };
  const question = routineQuestion(routine, { now: Date.UTC(2026, 10, 9, 4), timeZone: "America/New_York", lastRun: null });
  assert.match(question, /A run can't write, edit or archive notes, this routine's included: whatever its words say, starting with DONE: is how it stops\./);
});

test("a job's report is kept in the rebuilt chat, as Tex's own text, and a routine reads it", () => {
  const at = Date.UTC(2026, 10, 9, 2, 4);
  const entries = [
    { seq: 1, kind: "text", event: "text", eid: "e1", at: at - 3_600_000, from: { kind: "person" }, text: "change my maps home" },
    { seq: 2, kind: "reply", turn: "T1", clean: true, text: "On it." },
    { seq: 3, kind: "text", event: "text", eid: "e2", at: at - 3_590_000, from: { kind: "tex" }, turn: "T1", delivered: true, text: "On it." },
    { seq: 4, kind: "job", turn: "R1", job: "job-maps" },
    { seq: 5, kind: "reply", turn: "R1", clean: true, text: "Home in Google Maps now reads 12 Example Street." },
    { seq: 6, kind: "text", event: "text", eid: "e3", at, from: { kind: "tex" }, turn: "R1", delivered: true, text: "Home in Google Maps now reads 12 Example Street." },
  ];
  const turns = conversationFromLedger(entries);
  assert.equal(turns.length, 4);
  assert.match(turns[2].text, /^\(Not a text from them\. You texted them what follows on your own/);
  assert.equal(turns[2].at, at);
  assert.equal(turns[2].theirs, undefined, "never read as their words");
  assert.equal(turns[3].text, "Home in Google Maps now reads 12 Example Street.");

  const section = recentTextsSection(turns, "tex/routines/hourly/maps-home.md", "America/New_York");
  assert.match(section, /\(Sun 2026-11-08 21:04\) You: Home in Google Maps now reads 12 Example Street\./);
  assert.doesNotMatch(section, /Them: \(Not a text from them/, "Tex's own line is never shown as theirs");
});
