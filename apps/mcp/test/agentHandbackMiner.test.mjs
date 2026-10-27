/**
 * THE NIGHTLY HAND-BACK COUNT (`src/agent/handbackMiner.js`; the owner
 * adopted transcript mining with the hand-back rule, 2026-10-22). After the
 * dream, the gateway reads the day's texted answers again with the hand-back
 * judge, writes what it found to the person's own `tex/handbacks/`, and logs
 * counts only.
 *
 * The transcripts here are written by the real `openTranscript`, so a change
 * to the transcript's shape that the miner can't read fails here.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-22).
 *
 *  1. `turnsOf` keeping a routine's run. → "a transcript's texted turns are
 *     read back …" fails.
 *  2. `mineHandbacks` ignoring `since`. → "a turn an earlier night counted is
 *     not counted again" fails.
 *  3. The judge shown the tool's arguments. → "the judge sees the person's
 *     text, the answer and tool names, never a tool's arguments or result"
 *     fails.
 *  4. The log line carrying the quote. → "the log line has counts only"
 *     fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { openTranscript } from "../src/agent/transcript.js";
import { HANDBACKS_FOLDER, MAX_MINED_TURNS, mineHandbacks, turnsOf } from "../src/agent/handbackMiner.js";

const NOW = Date.UTC(2026, 9, 22, 15, 0);
const DAY = "tex/transcripts/2026-10-22.md";

function notes() {
  const store = new Map();
  let n = 0;
  const callTool = async (name, args) => {
    const text = (value) => ({ content: [{ type: "text", text: value }] });
    if (name === "read_note") {
      const note = store.get(args.path);
      if (!note) return { ...text("not found"), isError: true };
      return text(`etag: ${note.etag}\npath: ${args.path}\nvisibility: private\n\n${note.body}`);
    }
    if (name === "write_note") {
      const note = store.get(args.path);
      if (note && args.expected_etag !== note.etag) return { ...text("conflict"), isError: true };
      const etag = `e${(n += 1)}`;
      store.set(args.path, { body: args.content, etag });
      return text(`written: ${args.path} (etag ${etag})`);
    }
    throw new Error(`unexpected ${name}`);
  };
  return { store, callTool };
}

/** A texted turn written by the real transcript, at `at`. */
async function texted(callTool, { at, question, tools = [], answer }) {
  const t = openTranscript(callTool, { now: at, timeZone: "UTC", question, clock: () => at });
  for (const [name, args, ok] of tools) t.record({ kind: "tool", name, args, ok, ms: 120 });
  await t.finish({ answer });
}

async function day() {
  const { store, callTool } = notes();
  await texted(callTool, {
    at: NOW - 3 * 3600_000,
    question: "what's my landlord's email?",
    tools: [["search_notes", { query: "landlord email" }, true]],
    answer: "Sam's email is sam@example.com.",
  });
  await texted(callTool, {
    at: NOW - 2 * 3600_000,
    question: "why didn't ama get the receipt?",
    tools: [["email_search", { query: "secret-query-words" }, false]],
    answer: "I couldn't find it. Can you forward me the receipt?",
  });
  const routine = openTranscript(callTool, { now: NOW - 3600_000, timeZone: "UTC", question: "Morning check", routine: "tex/routines/daily/morning.md", clock: () => NOW - 3600_000 });
  await routine.finish({ answer: "Anything you want me to look at?" });
  return { store, callTool };
}

test("a transcript's texted turns are read back: their text, the tools by name and outcome, and the answer; never a routine's run", async () => {
  const { store } = await day();
  const turns = turnsOf(store.get(DAY).body);
  assert.deepEqual(
    turns.map((t) => [t.question, t.steps, t.answer]),
    [
      ["what's my landlord's email?", [{ name: "search_notes", ok: true }], "Sam's email is sam@example.com."],
      ["why didn't ama get the receipt?", [{ name: "email_search", ok: false }], "I couldn't find it. Can you forward me the receipt?"],
    ],
  );
  assert.equal(turns[1].at, NOW - 2 * 3600_000, "a turn's time is read from its id");
});

/** A judge that finds an H1 in any answer asking to be forwarded something, and records what it was shown. */
function scriptedJudge() {
  const shown = [];
  const request = async (body) => {
    const text = body.messages[0].text;
    shown.push(text);
    const asks = /forward me/i.test(text.split("\n\nTEXT\n\n")[1]) ? [{ code: "H1", quote: "Can you forward me the receipt?" }] : [];
    return { text: JSON.stringify({ asks }) };
  };
  return { shown, request };
}

test("the night's answers that may ask something are judged, and what was found goes in their own tex/handbacks note", async () => {
  const { store, callTool } = await day();
  const judge = scriptedJudge();
  const lines = [];
  const mined = await mineHandbacks({
    dispatch: callTool,
    transcripts: [DAY],
    since: null,
    now: NOW,
    timeZone: "UTC",
    config: { gateway: true },
    request: judge.request,
    metadata: { workspace: "ws_1" },
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.deepEqual(mined, { read: 1, codes: { H1: 1 } });
  assert.equal(judge.shown.length, 1, "an answer that asks nothing is never judged");
  const note = store.get(`${HANDBACKS_FOLDER}/2026-10-22.md`).body;
  assert.match(note, /^# Hand-backs, October 22, 2026/);
  assert.match(note, /1 answer read, 1 handing you work Tex could do\./);
  assert.match(note, /- 1:00 pm, H1 \(hand-back\): "Can you forward me the receipt\?"/);
});

test("the judge sees the person's text, the answer and tool names, never a tool's arguments or result", async () => {
  const { callTool } = await day();
  const judge = scriptedJudge();
  await mineHandbacks({ dispatch: callTool, transcripts: [DAY], since: null, now: NOW, timeZone: "UTC", config: {}, request: judge.request, metadata: {}, log: () => {} });
  assert.match(judge.shown[0], /why didn't ama get the receipt\?/);
  assert.match(judge.shown[0], /email_search: failed/);
  assert.doesNotMatch(judge.shown[0], /secret-query-words/);
});

test("the log line has counts only", async () => {
  const { callTool } = await day();
  const lines = [];
  await mineHandbacks({ dispatch: callTool, transcripts: [DAY], since: null, now: NOW, timeZone: "UTC", config: {}, request: scriptedJudge().request, metadata: { workspace: "ws_1" }, log: (line) => lines.push(line) });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { event: "handbacks_mined", workspace: "ws_1", turns: 1, read: 1, codes: { H1: 1 }, logged: true });
  assert.doesNotMatch(lines[0], /receipt|ama/i);
});

test("a turn an earlier night counted is not counted again", async () => {
  const { callTool, store } = await day();
  const judge = scriptedJudge();
  const mined = await mineHandbacks({ dispatch: callTool, transcripts: [DAY], since: NOW - 90 * 60_000, now: NOW, timeZone: "UTC", config: {}, request: judge.request, metadata: {}, log: () => {} });
  assert.deepEqual(mined, { read: 0, codes: {} });
  assert.equal(judge.shown.length, 0);
  assert.equal(store.has(`${HANDBACKS_FOLDER}/2026-10-22.md`), false, "nothing to read, nothing written");
});

test("without a model road, or past the night's limit, it stops", async () => {
  const { callTool } = await day();
  assert.equal(await mineHandbacks({ dispatch: callTool, transcripts: [DAY], since: null, now: NOW, timeZone: "UTC", config: null, log: () => {} }), null);
  assert.ok(MAX_MINED_TURNS <= 30, "one night's reading stays a few cents");
});

test("a judge that fails counts nothing and never throws", async () => {
  const { callTool } = await day();
  const mined = await mineHandbacks({
    dispatch: callTool,
    transcripts: [DAY],
    since: null,
    now: NOW,
    timeZone: "UTC",
    config: {},
    request: async () => {
      throw new Error("down");
    },
    metadata: {},
    log: () => {},
  });
  assert.deepEqual(mined, { read: 0, codes: {} });
});
