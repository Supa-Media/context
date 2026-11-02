/**
 * A texted turn is shown what Tex texted by itself (`src/agent/sentByItself.js`).
 *
 * 2026-11-02: a check-in asked a person whether to forward two receipts, they
 * answered "yes please", and Tex said it had no open question. The check-in
 * was kept in their record, but the turn was shown the chat's log, which a
 * check-in never reaches. Sabotage: drop the `record` option in `loggedTurn`,
 * and the first test fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appendEvents } from "../src/agent/log.js";
import { loggedTurn } from "../src/agent/loggedTurn.js";
import { sentByItself, WINDOW_MS } from "../src/agent/sentByItself.js";

const NY = "America/New_York";
const NOW = Date.UTC(2026, 10, 1, 23, 4, 0); // Sunday, Nov 1, 6:04 PM in New York
const CHAT = "chat-ada-1";
const CHECK_IN = "(Not a text from them. This was your own check-in: you looked through their workspace on your own and texted them what follows.)";
const OFFER = "Two receipts came in today. Want me to forward both?";

function memoryStore() {
  const data = new Map();
  return {
    async put(key, body) {
      data.set(key, body);
    },
    async get(key) {
      return data.has(key) ? { text: async () => data.get(key) } : null;
    },
    async list({ prefix }) {
      return { objects: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

let seq = 0;
function event(fields = {}) {
  const at = fields.at ?? NOW;
  seq += 1;
  return { id: `${String(at).padStart(13, "0")}-${String(seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person", name: "Ada" }, kind: "text", text: "hi", ...fields };
}

const exchange = (question, answer, at, extra = {}) => [
  { role: "user", text: question, at },
  { role: "assistant", text: answer, ...extra },
];

async function yesTurn(record, { group = null } = {}) {
  const store = memoryStore();
  const earlier = event({ at: NOW - 3_600_000, text: "morning" });
  const reply = event({ at: NOW - 3_599_000, from: { kind: "tex" }, text: "Morning!", covers: [earlier.id], turn: "turn-clean-0001" });
  const yes = event({ at: NOW, text: "yes please" });
  await appendEvents(store, CHAT, [earlier, reply, yes], { now: NOW });
  await store.put(".context/agent/turns/turn-clean-0001.json", JSON.stringify({ clean: true }));
  return loggedTurn(store, { chat: CHAT, covers: [yes.id] }, { timeZone: NY, group, record: Promise.resolve(record) });
}

test("a check-in in the record is shown in the log, before the yes that answers it", async () => {
  const logged = await yesTurn(exchange(CHECK_IN, OFFER, NOW - 30_000));
  assert.equal(logged.question, "yes please");
  const transcript = logged.history[0].text;
  assert.match(transcript, /\[6:03 PM\] You: Two receipts came in today\. Want me to forward both\?/);
  assert.ok(transcript.indexOf("Morning!") < transcript.indexOf(OFFER), "kept in time order");
  assert.equal(logged.tainted, false);
});

test("a check-in that read mail taints the turn shown it", async () => {
  assert.equal((await yesTurn(exchange(CHECK_IN, OFFER, NOW - 30_000, { tainted: true }))).tainted, true);
});

test("a text the log already holds, a texted exchange and one past the day are not shown twice or at all", async () => {
  const record = [
    ...exchange("(Not a text from them. Your background job \"Plan\" reported back to you; nothing from it has reached them yet.)", "Morning!", NOW - 3_599_000),
    ...exchange("what's up", "Not much.", NOW - 120_000),
    ...exchange(CHECK_IN, "Old check-in from yesterday.", NOW - WINDOW_MS - 1),
  ];
  const transcript = (await yesTurn(record)).history[0].text;
  assert.equal(transcript.split("Morning!").length, 2, "the logged reply once");
  assert.ok(!transcript.includes("Not much."), "a texted exchange is the log's, not the record's");
  assert.ok(!transcript.includes("Old check-in"), "past the log's day");
});

test("a group turn is never shown a person's record", async () => {
  const shown = sentByItself(exchange(CHECK_IN, OFFER, NOW - 30_000), [], { chat: CHAT, newest: NOW });
  assert.equal(shown.shown.length, 1);
  const store = memoryStore();
  const yes = event({ at: NOW, text: "yes please", people: "a".repeat(64) });
  await appendEvents(store, CHAT, [yes], { now: NOW });
  const logged = await loggedTurn(store, { chat: CHAT, covers: [yes.id] }, { timeZone: NY, group: { members: "a".repeat(64) }, record: Promise.resolve(exchange(CHECK_IN, OFFER, NOW - 30_000)) });
  assert.ok(!(logged?.history[0]?.text ?? "").includes(OFFER));
});
