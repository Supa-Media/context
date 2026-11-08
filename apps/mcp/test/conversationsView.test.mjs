/**
 * A CHAT'S CONVERSATIONS, SHOWN (Dev2, 2026-11-07: the conversations UI "in the Tex Hub and also when you open the Tex
 * folder", then "build it then"; `src/http/texPage/conversations.js`, `src/texStore/historyView.js`).
 *
 * The Tex page reads a chat's conversations and one conversation's texts; the Tex folder holds
 * `conversations.ledger.json` beside the history file, a second view of the same chat: a marker in the object, the
 * threads as they stand on every read, read only.
 *
 * Sabotage record (2026-11-07), each applied, this file run, named test failing, reverted:
 *  1. `threadLines` keeping every Tex answer → "a conversation's lines are its texts and Tex's answers to them" fails.
 *  2. `withHistoryView` rendering the history for the conversations marker → "the conversations file answers the
 *     threads as they stand" fails.
 *  3. the put check comparing against the history marker only → "nothing writes over the conversations file" fails.
 *  4. `ensureHistoryFile` always writing the history marker → "the conversations row is made beside the history" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { texLedger } from "../src/texStore/ledger.js";
import { TexObjectRefused, texObjects } from "../src/texStore/objects.js";
import { CONVERSATIONS_VIEW_MARKER, HISTORY_VIEW_MARKER, withHistoryView } from "../src/texStore/historyView.js";
import { CONVERSATIONS_PATH, ensureHistoryFile, historyWriteRefusal, homeConversationsPath } from "../src/agent/historyFile.js";
import { conversationsView, conversationView, threadLines } from "../src/http/texPage/conversations.js";
import { isChatHistoryPath } from "../src/notes/paths.js";
import { durableSql } from "./texStoreFixture.mjs";

const KEY = "notes/01890000-0000-7000-8000-000000000003.json";
const HISTORY_KEY = "notes/01890000-0000-7000-8000-000000000004.json";
const decode = (body) => new TextDecoder().decode(body);

function object() {
  const sql = durableSql();
  return { ...texObjects(sql), ledger: texLedger(sql) };
}

const person = (eid, at, words, extra = {}) => ({ id: `ev${eid}`, eid, at, kind: "text", event: "text", from: { kind: "person", name: "dana" }, text: words, ...extra });
const tex = (eid, at, words, covers) => ({ id: `ev${eid}`, eid, at, kind: "text", event: "text", from: { kind: "tex" }, text: words, ...(covers ? { covers } : {}) });
const thread = (at, fields) => ({ id: `th${at}${fields.thread}`, at, kind: "thread", ...fields });

const TEXTS = [
  person("a1", 1000, "find me a hotel in Lisbon"),
  tex("b1", 1100, "Memmo Alfama, $172", ["a1"]),
  person("a2", 2000, "and the dentist on Thursday?"),
  tex("b2", 2100, "Booked, Thursday at 3"), // an older answer naming no texts: answers the texts since the last answer
  person("a3", 3000, "book the hotel"),
  tex("b3", 3100, "Booked Memmo", ["a3"]),
];
const THREADS = [
  thread(1000, { thread: "t1", status: "open", title: "Lisbon hotel", description: "wants a hotel", texts: ["a1"] }),
  thread(2000, { thread: "t2", status: "open", title: "Dentist", description: "Thursday", texts: ["a2"] }),
  thread(2100, { thread: "t2", status: "finished", title: "Dentist", description: "booked Thursday at 3", texts: [] }),
  thread(3000, { thread: "t1", status: "open", title: "Lisbon hotel", description: "booking Memmo", texts: ["a3"] }),
];

function seeded() {
  const stored = object();
  stored.ledger.append("texts", TEXTS);
  stored.ledger.append("texts.threads", THREADS);
  return stored;
}

/** The ledger as the gateway's Tex page reads it: async, as `ledgerFor` answers. */
const asyncLedger = (ledger) => ({ read: async (chat, options) => ledger.read(chat, options) });

test("a conversation's lines are its texts and Tex's answers to them", () => {
  const sorted = TEXTS.slice();
  assert.deepEqual(threadLines({ texts: ["a1", "a3"] }, sorted).map((e) => e.eid), ["a1", "b1", "a3", "b3"]);
  assert.deepEqual(threadLines({ texts: ["a2"] }, sorted).map((e) => e.eid), ["a2", "b2"], "an answer naming none answers the texts since the last");
});

test("the Tex page lists a chat's conversations, open first, and opens one with its lines", async () => {
  const ledger = asyncLedger(seeded().ledger);
  const { threads } = await conversationsView(ledger, "texts");
  assert.deepEqual(threads.map((t) => [t.id, t.status, t.texts]), [["t1", "open", 2], ["t2", "finished", 1]]);
  assert.equal(threads[0].description, "booking Memmo", "the newest entry's words");
  const one = await conversationView(ledger, "texts", "t1");
  assert.equal(one.thread.title, "Lisbon hotel");
  assert.deepEqual(one.lines.map((l) => [l.who, l.text]), [["person", "find me a hotel in Lisbon"], ["tex", "Memmo Alfama, $172"], ["person", "book the hotel"], ["tex", "Booked Memmo"]]);
  assert.equal(one.lines[0].name, "dana");
  assert.equal(one.more, false);
  assert.deepEqual(await conversationView(ledger, "texts", "t9"), { thread: null, lines: [], more: false });
  assert.deepEqual(await conversationView(ledger, "texts", "../x"), { thread: null, lines: [], more: false }, "an id that is not a thread's reads nothing");
});

test("the conversations file answers the threads as they stand, and keeps only its marker", async () => {
  const stored = seeded();
  const objects = withHistoryView(stored);
  await objects.put(KEY, CONVERSATIONS_VIEW_MARKER);
  await objects.put(HISTORY_KEY, HISTORY_VIEW_MARKER);
  const first = objects.get(KEY);
  const shown = JSON.parse(decode(first.body));
  assert.equal(shown.chat, "texts");
  assert.deepEqual(shown.threads.map((t) => [t.id, t.status]), [["t1", "open"], ["t2", "finished"]]);
  assert.deepEqual(shown.threads[0].texts, ["a1", "a3"]);
  assert.equal(objects.head(KEY).etag, first.etag);
  assert.equal(decode(stored.get(KEY).body), CONVERSATIONS_VIEW_MARKER);
  // The history file beside it is still the chat's history, not its threads.
  assert.deepEqual(JSON.parse(decode(objects.get(HISTORY_KEY).body)).entries.map((e) => e.eid), ["a1", "b1", "a2", "b2", "a3", "b3"]);
  // A new verdict is in the next read, under a new etag.
  stored.ledger.append("texts.threads", [thread(4000, { thread: "t3", status: "open", title: "Gym", description: "freeze", texts: ["a4"] })]);
  const second = objects.get(KEY, { onlyIf: { etagDoesNotMatch: first.etag } });
  assert.notEqual(second.etag, first.etag);
  assert.deepEqual(JSON.parse(decode(second.body)).threads.map((t) => t.id), ["t3", "t1", "t2"]);
});

test("nothing writes over the conversations file, and no tool may", async () => {
  const objects = withHistoryView(seeded());
  await objects.put(KEY, CONVERSATIONS_VIEW_MARKER);
  await assert.rejects(() => objects.put(KEY, "{}"), TexObjectRefused);
  await assert.rejects(() => objects.put(KEY, HISTORY_VIEW_MARKER), TexObjectRefused, "nor turned into the history");
  assert.ok(await objects.put(KEY, CONVERSATIONS_VIEW_MARKER));
  for (const path of ["tex/conversations.ledger.json", "@seyi/tex/Conversations.Ledger.JSON", "tex/groups/blue-fox/conversations.ledger.json"]) {
    assert.equal(isChatHistoryPath(path), true, path);
    assert.match(historyWriteRefusal(path), /can be read but not written/);
  }
  assert.equal(isChatHistoryPath("projects/conversations.ledger.json"), false);
});

test("the conversations row is made beside the history, with its own marker, once", async () => {
  const put = [];
  const store = { put: async (path, value, options) => put.push({ path, value, options }) };
  await ensureHistoryFile(store, CONVERSATIONS_PATH, { [CONVERSATIONS_PATH]: false });
  await ensureHistoryFile(store, CONVERSATIONS_PATH, { [CONVERSATIONS_PATH]: "notes/x.json" });
  assert.deepEqual(put.map((p) => [p.path, p.value]), [["tex/conversations.ledger.json", CONVERSATIONS_VIEW_MARKER]]);
  assert.equal(homeConversationsPath({ folder: "tex/groups/blue-fox" }), "tex/groups/blue-fox/conversations.ledger.json");
});
