/**
 * CONVERSATION THREADS (`src/agent/conversationThreads.js`, `threadedTurn.js`; Dev2, 2026-11-07: a classifier
 * "that decides if a message is part of an existing convo open, or is a new convo", kept in its own ledger,
 * up to 50 threads shown, "24 hours worth of conversations and the suggested thread", "just launch it").
 *
 * Sabotage record (2026-11-07), each applied, this file run, named test failing, reverted:
 *  1. `verdictEntries` finishing a thread that was already finished → "a verdict finishes only open threads…" fails.
 *  2. `threadedTurn` keeping every text instead of the last 24 hours → "classified texts older than a day…" fails.
 *  3. `listedThreads` putting finished threads first → "the list holds 50 at most, open first…" fails.
 *  4. `threadsChat` writing to the chat's own ledger → "a turn's verdict is kept in the chat's threads ledger…" fails.
 *  5. a 400-token cap on the call → "the classifier's call sets no output cap…" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyText, foldThreads, listedThreads, MAX_LISTED, readVerdict, threadsChat, threadsOn, threadsWrite, verdictEntries } from "../src/agent/conversationThreads.js";
import { threadedTurn } from "../src/agent/threadedTurn.js";

const H = 3600e3;
const NOW = Date.parse("2026-11-07T15:00:00Z");
const person = (id, at, text) => ({ id, at, from: { kind: "person", name: "dana" }, kind: "text", text });
const tex = (id, at, text, covers) => ({ id, at, from: { kind: "tex" }, kind: "text", text, delivered: true, covers });
const entry = (thread, at, extra) => ({ kind: "thread", thread, at, ...extra });

function fakeLedger(entries = []) {
  const kept = { [threadsChat("texts")]: [...entries] };
  return {
    kept,
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

function turnOf(shown, question = "and the hotel?") {
  return {
    question,
    replying: [],
    covered: [person("new1", NOW, question)],
    parts: { shown, answeredBy: shown, tools: new Map(), summaries: [], answering: NOW, timeZone: "UTC", byId: new Map() },
  };
}

test("the newest entry's words and status win, and a thread keeps every text it was given", () => {
  const { threads, start } = foldThreads([
    entry("t1", 10, { title: "Dentist", description: "booking", status: "open", texts: ["a"] }),
    entry("t1", 30, { status: "finished" }),
    entry("t1", 20, { description: "booked Thursday", status: "open", texts: ["b"] }),
  ]);
  assert.equal(start, 10);
  assert.deepEqual(threads, [{ id: "t1", title: "Dentist", description: "booked Thursday", status: "finished", texts: ["a", "b"], at: 10, last: 20 }]);
});

test("a verdict naming a thread that doesn't exist, or a new one with no title, is no verdict", () => {
  const threads = [{ id: "t1", status: "open" }];
  assert.equal(readVerdict('{"thread":"t9","title":"x","description":"y","finished":[]}', threads), null);
  assert.equal(readVerdict('{"thread":"new","title":"","description":"y"}', threads), null);
  assert.deepEqual(readVerdict('Here: {"thread":"new","title":"Hotel","description":"Lisbon hotel","finished":["t1","t7"]}', threads), { thread: "new", title: "Hotel", description: "Lisbon hotel", finished: ["t1"], respond: "reply" });
});

test("a verdict finishes only open threads, and reopens a finished one it continues", () => {
  const threads = [
    { id: "t1", title: "Dentist", status: "finished" },
    { id: "t2", title: "Trip", status: "open" },
    { id: "t3", title: "Bug", status: "finished" },
  ];
  const { id, entries } = verdictEntries({ thread: "t1", title: "Dentist", description: "moving it to Friday", finished: ["t2", "t3"] }, threads, ["new1"], 100);
  assert.equal(id, "t1");
  assert.equal(entries[0].reopened, true);
  assert.equal(entries[0].status, "open");
  assert.deepEqual(entries.slice(1).map((each) => [each.thread, each.status]), [["t2", "finished"]]);
  assert.equal(verdictEntries({ thread: "new", title: "Hotel", description: "", finished: [] }, threads, ["x"], 1).id, "t4");
});

test("the list holds 50 at most, open first and newest first, so the oldest finished drop out", () => {
  const threads = Array.from({ length: 70 }, (_, i) => ({ id: `t${i + 1}`, status: i % 7 === 0 ? "open" : "finished", last: i }));
  const listed = listedThreads(threads);
  assert.equal(listed.length, MAX_LISTED);
  const open = threads.filter((thread) => thread.status === "open").length;
  assert.ok(listed.slice(0, open).every((thread) => thread.status === "open"));
  assert.equal(listed[open].id, "t70");
  assert.ok(!listed.some((thread) => thread.id === "t2"), "an old finished thread is no longer listed");
});

test("classified texts older than a day are shown only through their thread; the last day is shown whole", async () => {
  const started = NOW - 72 * H;
  const ledger = fakeLedger([
    entry("t1", started, { title: "Lisbon trip", description: "flights booked, hotel next", status: "open", texts: ["old1"] }),
    entry("t2", started + 1, { title: "Dentist", description: "booked Thursday", status: "open", texts: ["old2"] }),
  ]);
  const shown = [person("old1", NOW - 48 * H, "find me a hotel in Lisbon under 180"), tex("old1r", NOW - 48 * H + 1, "Memmo Alfama, $172", ["old1"]), person("old2", NOW - 40 * H, "book the dentist"), person("loose", NOW - 30 * H, "nobody answered this"), person("today1", NOW - 2 * H, "lunch?")];
  const turn = await threadedTurn({ logged: turnOf(shown), ledger, chat: "texts", config: {}, request: answering({ thread: "t1", title: "Lisbon trip", description: "asking about the hotel again", finished: [] }), now: NOW, log: () => {} });
  const text = turn.history[0].text;
  assert.match(text, /- t1 · open · Lisbon trip/);
  assert.match(text, /most likely continues t1, "Lisbon trip"/);
  assert.match(text, /Its texts from before the last 24 hours:\n\[.*\] @dana: find me a hotel in Lisbon under 180\n\[.*\] You: Memmo Alfama, \$172/);
  assert.doesNotMatch(text, /book the dentist/, "another thread's old texts stay out");
  assert.match(text, /nobody answered this/, "a text no thread holds stays in view");
  assert.match(text, /@dana: lunch\?/);
  assert.equal(turn.suggested, "t1");
  assert.deepEqual(turn.entries.map((each) => [each.thread, each.texts]), [["t1", ["new1"]]]);
});

test("on a chat's first thread nothing older drops out: texts from before threads are shown as before", async () => {
  const shown = [person("a", NOW - 50 * H, "the bike lock code is in my notes"), person("b", NOW - H, "hey")];
  const turn = await threadedTurn({ logged: turnOf(shown, "what's the lock code"), ledger: fakeLedger(), chat: "texts", config: {}, request: answering({ thread: "new", title: "Bike lock code", description: "asking for the code", finished: [] }), now: NOW, log: () => {} });
  assert.match(turn.history[0].text, /bike lock code is in my notes/);
  assert.match(turn.history[0].text, /most likely starts a new conversation/);
  assert.equal(turn.entries[0].thread, "t1");
});

test("a classifier that fails leaves the list and the last day, with no suggestion and nothing written", async () => {
  const ledger = fakeLedger([entry("t1", NOW - 72 * H, { title: "Trip", description: "d", status: "open", texts: ["old1"] })]);
  const shown = [person("old1", NOW - 48 * H, "old trip text"), person("x", NOW - H, "recent")];
  const turn = await threadedTurn({ logged: turnOf(shown), ledger, chat: "texts", config: {}, request: async () => { throw new Error("down"); }, now: NOW, log: () => {} });
  assert.match(turn.history[0].text, /- t1 · open · Trip/);
  assert.doesNotMatch(turn.history[0].text, /most likely/);
  assert.doesNotMatch(turn.history[0].text, /old trip text/);
  assert.deepEqual(turn.entries, []);
});

test("silence finishes nothing: a thread closes only when the classifier names it", async () => {
  const ledger = fakeLedger([entry("t1", NOW - 72 * H, { title: "Trip", description: "d", status: "open", texts: [] })]);
  const turn = await threadedTurn({ logged: turnOf([]), ledger, chat: "texts", config: {}, request: answering({ thread: "new", title: "Lunch", description: "lunch plans", finished: [] }), now: NOW + 30 * 24 * H, log: () => {} });
  assert.equal(turn.threads.find((thread) => thread.id === "t1").status, "open");
});

test("read_thread lists every conversation, and opens one in full", async () => {
  const ledger = fakeLedger([entry("t1", NOW - 72 * H, { title: "Trip", description: "d", status: "open", texts: ["old1"] })]);
  const turn = await threadedTurn({ logged: turnOf([person("old1", NOW - 48 * H, "old trip text")]), ledger, chat: "texts", config: {}, request: answering({ thread: "new", title: "Lunch", description: "l", finished: [] }), now: NOW, log: () => {} });
  const listed = await turn.read_thread.call({});
  assert.match(listed.content[0].text, /t1 · open · Trip/);
  assert.match(listed.content[0].text, /t2 · open · Lunch/);
  const opened = await turn.read_thread.call({ thread: "t1" });
  assert.match(opened.content[0].text, /old trip text/);
  assert.equal((await turn.read_thread.call({ thread: "t9" })).isError, true);
});

test("a turn's verdict is kept in the chat's threads ledger, never the chat's own", async () => {
  const kept = {};
  const store = { texLedger: () => ({ append: async (chat, list) => ((kept[chat] ??= []).push(...list), { added: list.length }) }) };
  await threadsWrite(store, { workspaceKind: "personal", workspaceId: "ws1" }, [{ v: 1, id: "th1t1", at: 1, kind: "thread", thread: "t1", status: "open", texts: [] }]);
  assert.deepEqual(Object.keys(kept), ["texts.threads"]);
});

test("the classifier's call sets no output cap: a cap cuts its thinking and its answer off together", async () => {
  let body = null;
  await classifyText({ threads: [], lines: { byThread: new Map(), recent: [] }, question: "hi", replying: [], config: {}, request: async (sent) => ((body = sent), { text: '{"thread":"new","title":"Hi","description":"d","finished":[]}' }) });
  assert.equal(body.maxTokens, undefined);
});

test("CONVERSATION_THREADS=off turns it off", () => {
  assert.equal(threadsOn({}), true);
  assert.equal(threadsOn({ CONVERSATION_THREADS: "off" }), false);
});
