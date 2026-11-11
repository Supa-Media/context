/**
 * GROUP TIME AWARENESS (`src/agent/chatTime.js`, `callbacks.js`, `threadedTurn.js`; Dev2, 2026-11-11: plan v3,
 * "the right context, then let Tex choose"). Code says how old each thing is and offers old moments that fit, with
 * how the chat took them; Tex decides what to say.
 *
 * Sabotage record (2026-11-11), each applied, this file run, named test failing, reverted:
 *  1. `threadedTurn` keeping a group's untagged texts at any age again (`!tags.has`) → "a group's old chatter leaves…" fails.
 *  2. `pickCallbacks` dropping the fit floor (`fit < 2`) → "an old aside that fits nothing is not offered" fails.
 *  3. `landings` ignoring laughs → "a moment the chat laughed at ranks above…" fails.
 *  4. `renderEvents` ignoring `now` → "each day says how long ago it was…" fails.
 *  5. `timeNote` skipping the lull → "a text after a quiet stretch says so…" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { agoWords, dayAgo, spanWords, timeNote } from "../src/agent/chatTime.js";
import { callbacksPrompt, landings, pickCallbacks, wordsOf } from "../src/agent/callbacks.js";
import { renderEvents } from "../src/agent/logRender.js";
import { threadsChat } from "../src/agent/conversationThreads.js";
import { threadedTurn } from "../src/agent/threadedTurn.js";

const M = 60e3;
const H = 60 * M;
const D = 24 * H;
const NOW = Date.parse("2026-11-11T15:00:00Z");
const person = (id, at, text, name = "ben", extra = {}) => ({ id, at, from: { kind: "person", name }, kind: "text", text, ...extra });
const tex = (id, at, text, covers) => ({ id, at, from: { kind: "tex" }, kind: "text", text, delivered: true, covers });
const tapback = (id, at, text, name = "maya") => ({ id, at, from: { kind: "person", name }, kind: "reaction", text });

function fakeLedger(entries = []) {
  const kept = { [threadsChat("group:g1")]: [...entries] };
  return {
    async read(chat) {
      return { entries: kept[chat] ?? [] };
    },
    async append(chat, list) {
      (kept[chat] ??= []).push(...list);
      return { added: list.length };
    },
  };
}

const answering = (verdict) => async () => ({ text: JSON.stringify(verdict) });
const NEW_THREAD = { thread: "new", title: "Tonight", description: "plans tonight", finished: [] };

function turnOf(shown, question, extra = {}) {
  const covered = [person("now1", NOW, question, "priya", extra)];
  const byId = new Map([...shown, ...covered].map((event) => [event.id, event]));
  return { question, replying: [], covered, parts: { shown, answeredBy: shown, tools: new Map(), summaries: [], answering: NOW, timeZone: "UTC", byId } };
}

const groupTurn = (shown, question, extra) =>
  threadedTurn({ logged: turnOf(shown, question, extra), ledger: fakeLedger([{ kind: "thread", thread: "t1", at: NOW - 10 * D, title: "Old", description: "d", status: "finished", texts: [] }]), chat: "group:g1", group: true, config: {}, request: answering(NEW_THREAD), now: NOW, log: () => {} });

test("spans and ages read as a person says them", () => {
  assert.equal(spanWords(12 * M), "12 minutes");
  assert.equal(spanWords(5 * H), "5 hours");
  assert.equal(spanWords(2 * D), "2 days");
  assert.equal(agoWords(30e3), "just now");
  assert.equal(dayAgo(NOW - 2 * H, NOW), "today");
  assert.equal(dayAgo(NOW - 20 * H, NOW), "yesterday");
  assert.equal(dayAgo(NOW - 4 * D, NOW), "4 days ago");
  assert.equal(dayAgo(Date.parse("2026-11-11T03:00:00Z"), NOW, "America/New_York"), "yesterday", "days are the person's, not UTC's");
});

test("each day says how long ago it was, and a quiet stretch is marked where it happened", () => {
  const events = [person("a", NOW - 4 * D, "who's in for fantasy this year"), person("b", NOW - 3 * H, "lunch?"), person("c", NOW - 2 * H, "sure")];
  const aged = renderEvents(events, { timeZone: "UTC", now: NOW });
  assert.match(aged, /--- Saturday, Nov 7 \(4 days ago\) ---/);
  assert.match(aged, /\(quiet for 4 days\)\n--- Wednesday, Nov 11 \(today\) ---/);
  assert.doesNotMatch(aged, /quiet for 1 hours/, "an hour between texts is no lull");
  const plain = renderEvents(events, { timeZone: "UTC" });
  assert.doesNotMatch(plain, /days ago|quiet for/, "without `now` (the cached log) nothing changes");
});

test("a text after a quiet stretch says so, and a reply under an old text names it", () => {
  const shown = [person("old", NOW - 2 * D, "anyone know a good plumber"), person("x", NOW - 2 * D + M, "ask tex")];
  const lull = timeNote({ covered: [person("n", NOW, "morning all")], shown, timeZone: "UTC" });
  assert.match(lull, /quiet for 2 days/);
  assert.match(lull, /fresh start/);
  const byId = new Map(shown.map((event) => [event.id, event]));
  const late = timeNote({ covered: [person("n", NOW, "found one btw", "ben", { replyTo: "old" })], shown, byId, timeZone: "UTC" });
  assert.match(late, /replies to a message from Nov 9, .*2 days ago: pick that conversation back up/);
  assert.equal(timeNote({ covered: [person("n", NOW, "ok")], shown: [person("y", NOW - 10 * M, "dinner at 7?")], timeZone: "UTC" }), "", "nothing to say mid-conversation");
});

test("a group's old chatter leaves the word-for-word transcript; an open ask of Tex stays", async () => {
  const shown = [
    person("aside", NOW - 4 * D, "my oauth token expired again, I'm a security risk lol", "instinct"),
    person("ask", NOW - 3 * D, "tex can you find the league rules doc", "ben"),
    person("today", NOW - H, "what time is kickoff", "maya"),
  ];
  const turn = await groupTurn(shown, "anyone up for wings");
  const text = turn.history[0].text;
  assert.doesNotMatch(text, /oauth token expired/, "a four-day-old aside is not shown as if it were live");
  assert.match(text, /tex can you find the league rules doc/, "an unanswered ask of Tex survives a lull");
  assert.match(text, /what time is kickoff/);
  assert.match(text, /\(today\) ---/);
});

test("an old moment that fits what's said now is offered with its age and how it landed", async () => {
  const shown = [
    person("aside", NOW - 4 * D, "my oauth token expired again, I'm a security risk lol", "instinct"),
    tapback("r1", NOW - 4 * D + M, "Laughed at “my oauth token expired again, I'm a security risk lol”"),
    tapback("r2", NOW - 4 * D + 2 * M, "Loved “my oauth token expired again, I'm a security risk lol”", "ben"),
    person("today", NOW - H, "what time is kickoff", "maya"),
  ];
  const turn = await groupTurn(shown, "tex roast instinct about security");
  const text = turn.history[0].text;
  assert.match(text, /Things from earlier in this chat that may fit/);
  assert.match(text, /- @instinct, Nov 7 \(4 days ago\): "my oauth token expired again, I'm a security risk lol" \(1 laugh, 1 tapback\)/);
  assert.match(text, /If someone pushes back on one, drop it/);
  assert.ok(text.indexOf("Things from earlier") < text.indexOf("what time is kickoff"), "offered before the last day's texts, which come last");
});

test("an old aside that fits nothing is not offered", async () => {
  const shown = [person("aside", NOW - 4 * D, "my oauth token expired again, I'm a security risk lol", "instinct"), person("today", NOW - H, "what time is kickoff", "maya")];
  const turn = await groupTurn(shown, "anyone up for wings tonight");
  assert.doesNotMatch(turn.history[0].text, /Things from earlier|oauth/);
});

test("a moment the chat laughed at ranks above one nobody reacted to", () => {
  const pool = [person("a", NOW - 3 * D, "the grill caught fire at the cookout", "ben"), person("b", NOW - 3 * D + M, "the cookout grill needs new propane", "maya"), tapback("r", NOW - 3 * D + 2 * M, "Laughed at “the grill caught fire at the cookout”")];
  const picked = pickCallbacks({ pool, live: [person("n", NOW, "cookout grill this weekend?")], all: pool, now: NOW });
  assert.deepEqual(picked.map((each) => each.event.id), ["a", "b"]);
  assert.deepEqual(landings(pool).get("a"), { tapbacks: 1, laughs: 1, replies: 0 });
  assert.match(callbacksPrompt(picked, { now: NOW }), /\(1 laugh\)[\s\S]*\(no reactions\)/);
});

test("a moment Tex already brought back this week counts half, and Tex's offer stays one line each", () => {
  const pool = [person("a", NOW - 5 * D, "cookout grill propane exploded spectacularly", "ben"), person("b", NOW - 5 * D, "cookout grill propane delivery arrives monday", "maya")];
  const all = [...pool, tex("t", NOW - 2 * D, "Remember when the cookout grill propane exploded spectacularly?", ["x"])];
  const picked = pickCallbacks({ pool, live: [person("n", NOW, "cookout grill propane plans")], all, now: NOW });
  assert.equal(picked[0].event.id, "b");
  assert.ok(wordsOf("Remember THE Cookout").has("cookout"));
  assert.ok(!wordsOf("yeah that thing").has("that"));
});

test("a one-to-one chat keeps its texts no thread holds, and gets no old-moments block", async () => {
  const shown = [person("loose", NOW - 30 * H, "nobody answered this cookout question"), person("today", NOW - H, "lunch?")];
  const turn = await threadedTurn({ logged: turnOf(shown, "cookout question again"), ledger: { read: async () => ({ entries: [{ kind: "thread", thread: "t1", at: NOW - 10 * D, title: "Old", description: "d", status: "open", texts: [] }] }), append: async () => ({}) }, chat: "texts", config: {}, request: answering(NEW_THREAD), now: NOW, log: () => {} });
  assert.match(turn.history[0].text, /nobody answered this cookout question/);
  assert.doesNotMatch(turn.history[0].text, /Things from earlier/);
});

test("the threaded turn hands its time note to the person's turn", async () => {
  const shown = [person("a", NOW - 2 * D, "anyone know a good plumber", "ben")];
  const turn = await groupTurn(shown, "found one btw", { replyTo: "a" });
  assert.match(turn.timeNote, /quiet for 2 days/);
  assert.match(turn.timeNote, /replies to a message from Nov 9/);
});
