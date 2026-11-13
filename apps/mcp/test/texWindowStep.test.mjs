/**
 * The threaded history's word-for-word window starts on a six-hour step, never 24 hours before each text
 * (`conversationThreads.js` `windowStart`; one record per chat, 2026-11-13). Measured in production on 2026-11-12: in a
 * busy group the next text's first round often read only the tools and system prompt from the cache (about 46,000
 * tokens) and wrote the chat's history again (25,000 to 50,000), because the oldest lines slid out of a window that
 * started exactly 24 hours back, and every byte after them changed with them.
 *
 * Sabotage (2026-11-13, a temporary local edit, reverted): `windowStart` answering `at - RECENT_MS` → "a busy chat's
 * next text starts with this text's history" fails (the texts first differ about 240 characters in).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loggedTurn } from "../src/agent/loggedTurn.js";
import { threadedTurn } from "../src/agent/threadedTurn.js";
import { RECENT_MS, WINDOW_STEP_MS, windowStart } from "../src/agent/conversationThreads.js";

const KEY = "a".repeat(64);
const PEOPLE = ["b", "c", "d", "e"].map((letter) => letter.repeat(64));

/** A group chat two days long, a text every few minutes, with Tex answering every fifth. */
function busyChat(now) {
  let seq = 0;
  const entries = [];
  const add = (at, from, text, extra = {}) => {
    const entry = { v: 1, seq: ++seq, kind: "text", eid: `${at}-${String(seq).padStart(6, "0")}`, event: "text", at, from, text, ...extra };
    entries.push(entry);
    return entry;
  };
  const start = now - 30 * 3_600_000;
  let asked = null;
  for (let i = 0; i < 600; i += 1) {
    const at = start + i * 3 * 60_000;
    if (i % 5 === 4) add(at, { kind: "tex" }, `Sure, noted (${i}).`, { covers: [asked.eid], delivered: true });
    else asked = add(at, { kind: "person", who: PEOPLE[i % 4], name: `P${i % 4}` }, `message ${i} about the picnic plans and who brings what`);
  }
  const threads = [{ v: 1, id: "th-1", at: start, kind: "thread", thread: "t1", status: "open", title: "Picnic", texts: entries.map((entry) => entry.eid) }];
  return { entries, threads, add };
}

async function historyFor(chat, text) {
  const read = { entries: [...chat.entries].reverse(), chat: KEY, ledger: { read: async () => ({ entries: [] }) } };
  const logged = await loggedTurn({}, { covers: [text.eid], chat: KEY, question: text.text }, { group: { key: KEY }, ledger: Promise.resolve(read) });
  const threaded = await threadedTurn({ logged, ledger: { read: async () => ({ entries: chat.threads }) }, chat: KEY, group: true, config: {}, metadata: {}, now: text.at, log: () => {} });
  return threaded.history.map((message) => message.text).join("\n");
}

test("a busy chat's next text starts with this text's history, though older lines passed 24 hours in between", async () => {
  const now = Date.UTC(2026, 10, 12, 20, 0); // 2 pm Eastern: mid-step, as most texts are
  const chat = busyChat(now - 40 * 60_000);
  const first = chat.add(now - 30 * 60_000, { kind: "person", who: PEOPLE[0], name: "P0" }, "Tex what time do we meet?");
  const before = await historyFor(chat, first);
  chat.threads[0].texts.push(first.eid);
  chat.add(now - 29 * 60_000, { kind: "tex" }, "Noon at the north gate.", { covers: [first.eid], delivered: true });
  const second = chat.add(now, { kind: "person", who: PEOPLE[1], name: "P1" }, "Tex and who brings the blanket?");
  const after = await historyFor(chat, second);
  assert.ok(after.startsWith(before), "everything the first text was shown is the start of what the second is shown");
  assert.match(after, /Noon at the north gate\./, "and the second sees Tex's newest answer");
});

test("the window starts on a six-hour step and always holds at least the last 24 hours", () => {
  const at = Date.UTC(2026, 10, 12, 14, 5);
  assert.equal(windowStart(at), windowStart(at + 3 * 3_600_000), "texts within one step share the window's start");
  assert.equal(windowStart(at) % WINDOW_STEP_MS, 0);
  for (const later of [0, 1, 59 * 60_000, 5 * 3_600_000 + 59 * 60_000]) {
    const shownFrom = at + later - windowStart(at + later);
    assert.ok(shownFrom >= RECENT_MS && shownFrom < RECENT_MS + WINDOW_STEP_MS, "24 to 30 hours shown");
  }
});
