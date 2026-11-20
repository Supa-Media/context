/**
 * LongMemEval as a memory test of Context (`bench/evals/`): the slice is the same every time and stratified, the
 * judge's prompt is LongMemEval's own per type, and one question runs end to end through a real gateway world on
 * scripted models: every session saved raw at its own date, housekeeping run the chosen number of times, a fresh
 * reader finding the saved session through search, and the judge grading it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { abilityOf, entryOf, judgePrompt, sessionsOf, sliceOf, transcriptOf, utcMs, verdictOf } from "../evals/longMemEval.mjs";
import { filingTimes, meteredSend, readerSystem, runQuestion, scoresOf } from "../evals/memoryRun.mjs";
import { fakeSend, fetchData } from "../evals/cli.mjs";
import { BENCHES } from "../evals/longMemEval.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedEmbeddings, fakeAi } from "../models.mjs";

const TYPES = ["single-session-user", "single-session-assistant", "single-session-preference", "multi-session", "temporal-reasoning", "knowledge-update"];

const item = (i, over = {}) => ({
  question_id: `q${i}`,
  question_type: TYPES[i % TYPES.length],
  question: "Which bicycle did I buy?",
  answer: "A red bicycle",
  question_date: "2023/05/20 (Sat) 02:21",
  haystack_session_ids: ["s-old", "s-new"],
  haystack_dates: ["2023/04/12 (Wed) 09:30", "2023/01/01 (Sun) 10:00"],
  haystack_sessions: [
    [
      { role: "user", content: "Pancakes for six?" },
      { role: "assistant", content: "Flour, eggs, milk." },
    ],
    [
      { role: "user", content: "Today I bought a red bicycle at the market." },
      { role: "assistant", content: "  Enjoy the rides!  " },
      { role: "user", content: "   " },
    ],
  ],
  ...over,
});

test("a question's ability: abstention by its id, else by its type", () => {
  assert.equal(abilityOf("x_abs", "multi-session"), "abstention");
  assert.equal(abilityOf("x", "multi-session"), "multi");
  assert.equal(abilityOf("x", "temporal-reasoning"), "temporal");
  assert.equal(abilityOf("x", "knowledge-update"), "update");
  assert.equal(abilityOf("x", "single-session-preference"), "extraction");
});

test("the slice is stratified, the same every time, and a larger one holds a smaller one", () => {
  const index = Array.from({ length: 120 }, (_, i) => entryOf(item(i, i % 10 === 0 ? { question_id: `q${i}_abs` } : {}), i));
  const ten = sliceOf(index, 10);
  assert.equal(ten.length, 10);
  assert.deepEqual(sliceOf(index, 10).map((e) => e.id), ten.map((e) => e.id));
  const forty = new Set(sliceOf(index, 40).map((e) => e.id));
  for (const e of ten) assert.ok(forty.has(e.id), `${e.id} is in the larger slice`);
  const types = new Set(ten.map((e) => `${e.type}${e.ability === "abstention" ? ":abs" : ""}`));
  assert.ok(types.size >= 6, "every kind of question is in a slice of ten");
  assert.equal(sliceOf(index, 1000).length, 120);
});

test("sessions come oldest first, at their own time, empty turns dropped", () => {
  const sessions = sessionsOf(item(0));
  assert.deepEqual(sessions.map((s) => s.id), ["s-new", "s-old"]);
  assert.equal(sessions[0].at, Date.UTC(2023, 0, 1, 10, 0));
  assert.equal(sessions[0].turns.length, 2);
  assert.equal(transcriptOf(sessions[0]), "**User:** Today I bought a red bicycle at the market.\n\n**Assistant:** Enjoy the rides!");
  assert.equal(utcMs("2023/05/20 (Sat) 02:21"), Date.UTC(2023, 4, 20, 2, 21));
  assert.equal(utcMs("not a date"), null);
});

test("the judge gets LongMemEval's template for each type, and yes is right", () => {
  const prompt = (over) => judgePrompt({ id: "q", type: "single-session-user", question: "Q?", answer: "A", ...over }, "R");
  assert.match(prompt({}), /contains the correct answer[\s\S]*Correct Answer: A[\s\S]*Model Response: R[\s\S]*Is the model response correct\? Answer yes or no only\.$/);
  assert.match(prompt({ type: "temporal-reasoning" }), /off-by-one errors/);
  assert.match(prompt({ type: "knowledge-update" }), /updated answer/);
  assert.match(prompt({ type: "single-session-preference" }), /Rubric: A/);
  assert.match(prompt({ id: "q_abs" }), /Explanation: A[\s\S]*identify the question as unanswerable/);
  assert.equal(verdictOf("Yes."), true);
  assert.equal(verdictOf("no"), false);
});

test("filing runs: the count asked for, spread out, the last just before the question", () => {
  const sessions = sessionsOf(item(0));
  const asked = utcMs("2023/05/20 (Sat) 02:21");
  const times = filingTimes(sessions, asked, 4);
  assert.equal(times.length, 4);
  assert.equal(times.at(-1), asked - 60_000);
  for (let k = 1; k < times.length; k += 1) assert.ok(times[k] > times[k - 1]);
  assert.ok(times[0] > sessions[0].at);
  assert.deepEqual(filingTimes(sessions, asked, 0), []);
  assert.deepEqual(filingTimes([], asked, 4), []);
});

test("the reader is told the question's date and the endpoint's own words", () => {
  const system = readerSystem("CALL orient FIRST.", Date.UTC(2023, 4, 20, 2, 21));
  assert.match(system, /Sat, 20 May 2023 02:21:00 UTC/);
  assert.match(system, /CALL orient FIRST\./);
});

test("one question end to end: saved raw at each date, filed, found by a fresh reader, graded", async () => {
  const sent = [];
  const fake = fakeSend();
  const send = async (body) => (sent.push(JSON.parse(body)), fake(body));
  const log = console.log;
  console.log = () => {};
  let row;
  try {
    row = await runQuestion(item(0), { send, ai: cachedEmbeddings(fakeAi()) }, { filings: 2 });
  } finally {
    console.log = log;
  }
  assert.equal(row.error, null);
  assert.equal(row.sessions, 2);
  assert.equal(row.saved, 2);
  assert.equal(row.saveErrors, 0);
  assert.equal(row.filings, 2);
  assert.equal(row.filingErrors, 0);
  // The reader searched the person's Context and found the session saved months before.
  assert.ok(row.calls.some((call) => call.tool === "search_notes"));
  const found = sent.flatMap((body) => body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result");
  assert.ok(found.some((b) => /red bicycle/.test(String(b.content))), "the search result names the saved session");
  assert.equal(typeof row.correct, "boolean");
  // Housekeeping ran as its own turns; the reader's first call carried the date it was asked.
  const reader = sent.find((body) => Array.isArray(body.tools) && body.tools.some((t) => t.name === "write") && String(body.system).includes("20 May 2023"));
  assert.ok(reader, "the reader is a client with the endpoint's tools");
  assert.ok(row.usd.filing > 0 && row.usd.reading > 0 && row.usd.judging > 0);
  const scores = scoresOf([{ ...row, correct: true }, { ...row, id: "q2", correct: false }, { ...row, id: "q3", correct: null, error: "reader: 500" }]);
  assert.equal(scores.n, 2);
  assert.equal(scores.correct, 1);
  assert.equal(scores.pct, 50);
  assert.equal(scores.failed, 1);
  assert.equal(scores.byAbility.extraction.n, 2);
});

test("the dataset is found in Hugging Face's listing by the bench's pattern and downloaded once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lme-"));
  const asked = [];
  const body = JSON.stringify([item(0)]);
  const fake = async (url) => {
    asked.push(url);
    if (url.endsWith("/tree/main")) return Response.json([{ type: "file", path: "longmemeval_oracle.json", size: 9 }, { type: "file", path: "longmemeval_s_cleaned.json", size: 120, lfs: { size: body.length } }, { type: "file", path: "README.md" }]);
    return new Response(body);
  };
  const path = await fetchData(BENCHES[0], dir, fake);
  assert.equal(path, join(dir, "longmemeval_s_cleaned.json"));
  assert.equal(readFileSync(path, "utf8"), body);
  assert.match(asked[1], /\/datasets\/xiaowu0162\/longmemeval-cleaned\/resolve\/main\/longmemeval_s_cleaned\.json$/);
  await fetchData(BENCHES[0], dir, fake);
  assert.equal(asked.length, 3, "a file already there is not downloaded again");
  await assert.rejects(fetchData({ ...BENCHES[0], file: /nothing/ }, dir, fake), /has 0 files/);
});

test("every call is priced into its phase; a reply with no usage (the socket's) is estimated from its characters", async () => {
  const reply = (usage) => async () => new Response(JSON.stringify({ content: [{ type: "text", text: "x".repeat(400) }], usage }), { status: 200 });
  const real = meteredSend(reply({ input_tokens: 1_000_000, output_tokens: 0 }));
  await real.send(JSON.stringify({ model: "claude-haiku-5-5", messages: [] }));
  real.phase("judging");
  await real.send(JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }));
  assert.deepEqual(real.usd, { filing: 0.1, reading: 0, judging: 2 });
  assert.equal(real.estimated(), false);
  const socket = meteredSend(reply({ input_tokens: 0, output_tokens: 0 }));
  socket.phase("reading");
  await socket.send(JSON.stringify({ model: "claude-haiku-5-5", system: "s".repeat(4_000), messages: [] }));
  assert.ok(socket.usd.reading > 0);
  assert.equal(socket.estimated(), true);
  const scores = scoresOf([{ ability: "multi", type: "multi-session", correct: true, usd: socket.usd, usdEstimated: true }]);
  assert.equal(scores.usd.estimated, true);
});
