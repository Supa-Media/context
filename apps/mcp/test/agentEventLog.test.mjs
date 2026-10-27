/**
 * The chat event log (`src/agent/log.js`), its rendering (`src/agent/logRender.js`)
 * and what a turn is shown from it (`src/agent/loggedTurn.js`), per
 * docs/design/tex-event-log/CONTRACT.md sections 1, 2 and 5.
 *
 * Sabotage these and a test here fails (each was run):
 *
 *  1. `checkEvent` accepting any `kind` (drop the `EVENT_KINDS.has` check) →
 *     "closed sets refuse what is not in them".
 *  2. `checkEvent` not checking the id names its `at` → "a bad id is refused".
 *  3. `checkEvent` not bounding `at` → "an at more than a day away is refused".
 *  4. `checkEvent` taking unknown fields (drop `onlyKeys(event, FIELDS)`) →
 *     "closed sets refuse what is not in them". Copying only the contract's
 *     fields is a second layer behind it ("only the contract's fields are
 *     kept"); breaking that layer alone fails nothing, since the first holds.
 *  5. `appendEvents` overwriting an id already kept → "appending is idempotent by id".
 *  6. `renderEvents` ignoring `delivered: false` on answers → "an answer that
 *     wasn't delivered leaves its question not answered".
 *  7. `seenBy` returning every event → "a newcomer's view starts where they joined".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appendEvents, checkEvent, EventRefusal, logPrefix, MAX_EVENT_TEXT, MAX_EVENTS_PER_CALL, readEvents } from "../src/agent/log.js";
import { renderEvents } from "../src/agent/logRender.js";
import { LOG_PREFACE, loggedTurn } from "../src/agent/loggedTurn.js";
import { TOLD } from "../src/agent/conversation.js";

const NOW = Date.UTC(2026, 9, 26, 16, 16, 0); // Monday, Oct 26, 12:16 PM in New York
const CHAT = "chat-ada-1";
const HEX = "a".repeat(64);
const OTHER_PEOPLE = "b".repeat(64);

function memoryStore() {
  const data = new Map();
  return {
    data,
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

const refusedField = (fn) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EventRefusal) return error.field;
    throw error;
  }
  return null;
};

/* ---------------- validation ---------------- */

test("a well-formed event is kept", () => {
  const ok = event({ replyTo: event().id, people: HEX, from: { kind: "person", who: HEX, name: "Ada" } });
  assert.deepEqual(checkEvent(ok, { chat: CHAT, now: NOW }), ok);
});

test("closed sets refuse what is not in them", () => {
  const check = (fields) => refusedField(() => checkEvent(event(fields), { chat: CHAT, now: NOW }));
  assert.equal(check({ kind: "tool_result" }), "kind");
  assert.equal(check({ from: { kind: "admin" } }), "from");
  assert.equal(check({ reason: "because" }), "reason");
  assert.equal(check({ told: "anything" }), "told");
  assert.equal(check({ result: "a tool said this" }), "event", "an unknown field refuses the event");
  assert.equal(check({ from: { kind: "person", secret: 1 } }), "from");
  assert.equal(check({ told: "ready" }), null);
});

test("caps refuse what is too long", () => {
  const check = (fields) => refusedField(() => checkEvent(event(fields), { chat: CHAT, now: NOW }));
  assert.equal(check({ text: "x".repeat(MAX_EVENT_TEXT + 1) }), "text");
  assert.equal(check({ text: "x".repeat(MAX_EVENT_TEXT) }), null);
  assert.equal(check({ from: { kind: "person", name: "n".repeat(65) } }), "from");
  assert.equal(check({ covers: Array.from({ length: 33 }, () => event().id) }), "covers");
  assert.equal(check({ turn: "short" }), "turn");
  assert.equal(check({ people: "nothex" }), "people");
});

test("a bad id is refused", () => {
  const check = (fields) => refusedField(() => checkEvent(event(fields), { chat: CHAT, now: NOW }));
  assert.equal(check({ id: "../../x" }), "id");
  assert.equal(check({ id: `${String(NOW + 1).padStart(13, "0")}-000001` }), "id", "an id that names another time");
  assert.equal(check({ replyTo: "nope" }), "replyTo");
  assert.equal(check({ chat: "another-chat" }), "chat");
});

test("an at more than a day away is refused", () => {
  const check = (at) => refusedField(() => checkEvent(event({ at }), { chat: CHAT, now: NOW }));
  assert.equal(check(NOW - 86_400_001), "at");
  assert.equal(check(NOW + 86_400_001), "at");
  assert.equal(check(NOW - 86_400_000), null);
  assert.equal(check(1.5), "at");
});

test("only the contract's fields are kept", async () => {
  const store = memoryStore();
  const sent = event({ text: "the words" });
  await appendEvents(store, CHAT, [sent], { now: NOW });
  const kept = JSON.parse([...store.data.values()][0]);
  assert.deepEqual(Object.keys(kept).sort(), ["at", "chat", "from", "id", "kind", "text"]);
});

test("one bad event refuses the whole call, and nothing is written", async () => {
  const store = memoryStore();
  await assert.rejects(appendEvents(store, CHAT, [event(), event({ kind: "nope" })], { now: NOW }), (error) => error instanceof EventRefusal && error.field === "events[1].kind");
  assert.equal(store.data.size, 0);
  await assert.rejects(appendEvents(store, CHAT, Array.from({ length: MAX_EVENTS_PER_CALL + 1 }, () => event()), { now: NOW }), EventRefusal);
  await assert.rejects(appendEvents(store, CHAT, [], { now: NOW }), EventRefusal);
  await assert.rejects(appendEvents(store, "bad/chat", [event()], { now: NOW }), EventRefusal);
});

test("appending is idempotent by id", async () => {
  const store = memoryStore();
  const first = event({ text: "first words" });
  assert.deepEqual(await appendEvents(store, CHAT, [first], { now: NOW }), [first.id]);
  assert.deepEqual(await appendEvents(store, CHAT, [{ ...first, text: "changed" }, first], { now: NOW }), [first.id]);
  assert.equal(store.data.size, 1);
  assert.match(store.data.get(`${await logPrefix(CHAT)}${first.id}.json`), /first words/);
});

test("reads are newest kept within the bounds, returned oldest first", async () => {
  const store = memoryStore();
  const events = Array.from({ length: 10 }, (_, i) => event({ at: NOW + i, text: `t${i}` }));
  await appendEvents(store, CHAT, events, { now: NOW });
  assert.deepEqual((await readEvents(store, CHAT, { limit: 3 })).map((e) => e.text), ["t7", "t8", "t9"]);
  const one = (await store.get(`${await logPrefix(CHAT)}${events[0].id}.json`).then((o) => o.text())).length;
  assert.equal((await readEvents(store, CHAT, { chars: one * 2 })).length, 2);
  assert.deepEqual(await readEvents(store, "no-such-chat"), []);
});

/* ---------------- rendering ---------------- */

const NY = "America/New_York";

test("day breaks and times are in the person's time zone, and Tex is You", () => {
  const sunday = event({ at: Date.UTC(2026, 9, 26, 3, 5), text: "late night" }); // 11:05 PM Sunday in New York
  const question = event({ text: "Tex check this link out" });
  const answer = event({ at: NOW + 60_000, from: { kind: "tex" }, text: "I read it", covers: [question.id, sunday.id] });
  assert.equal(
    renderEvents([sunday, question, answer], { timeZone: NY }),
    ["--- Sunday, Oct 25 ---", "[11:05 PM] Ada: late night", "--- Monday, Oct 26 ---", "[12:16 PM] Ada: Tex check this link out", "[12:17 PM] You: I read it"].join("\n"),
  );
  assert.match(renderEvents([question], { timeZone: "UTC" }), /^--- Monday, Oct 26 ---\n\[4:16 PM\]/);
});

test("an inbound message nothing answered is not answered", () => {
  const asked = event({ text: "are you thinking straight?" });
  assert.equal(renderEvents([asked], { timeZone: NY }).split("\n")[1], "[12:16 PM] Ada: are you thinking straight?   (not answered)");
});

test("an answer that wasn't delivered says why, and leaves its question not answered", () => {
  const asked = event({ text: "send me the picture" });
  const answer = event({ at: NOW + 60_000, from: { kind: "tex" }, text: "Here it is", delivered: false, reason: "upload_failed", covers: [asked.id] });
  const lines = renderEvents([asked, answer], { timeZone: NY }).split("\n");
  assert.match(lines[1], /\(not answered\)$/);
  assert.equal(lines[2], "[12:17 PM] You: Here it is");
  assert.equal(lines[3], "           (not delivered: the picture didn't reach them)");
});

test("a newcomer's view starts where they joined", () => {
  const before = event({ text: "before you came", people: OTHER_PEOPLE });
  const after = event({ at: NOW + 60_000, text: "welcome", people: HEX });
  const shown = renderEvents([before, after], { timeZone: NY, people: HEX });
  assert.ok(!shown.includes("before you came"));
  assert.match(shown, /welcome/);
  assert.equal(renderEvents([before], { timeZone: NY, people: HEX }), "", "no event of theirs, nothing shown");
});

test("a fixed Worker text is shown in the gateway's words for it", () => {
  const told = event({ from: { kind: "tex" }, told: "ready", text: undefined });
  assert.equal(renderEvents([told], { timeZone: NY }).split("\n")[1], `[12:16 PM] You: ${TOLD.ready}`);
});

/* ---------------- what a turn is shown ---------------- */

test("a turn that covers logged events is shown the log and asked their words", async () => {
  const store = memoryStore();
  const old = event({ text: "earlier words" });
  const reply = event({ at: NOW + 1, from: { kind: "tex" }, text: "earlier answer", covers: [old.id] });
  const fresh = event({ at: NOW + 2, text: "the new question" });
  await appendEvents(store, CHAT, [old, reply, fresh], { now: NOW });
  const logged = await loggedTurn(store, { chat: CHAT, covers: [fresh.id] }, { timeZone: NY });
  assert.equal(logged.question, "the new question");
  assert.equal(logged.history.length, 1);
  assert.ok(logged.history[0].text.startsWith(LOG_PREFACE));
  assert.match(logged.history[0].text, /Ada: earlier words\n\[12:16 PM\] You: earlier answer/);
  assert.ok(!logged.history[0].text.includes("the new question"), "the question is not also in the transcript");
});

test("a turn falls back to today's when there is no log, no covers, or a covered event isn't logged yet", async () => {
  const store = memoryStore();
  const fresh = event();
  assert.equal(await loggedTurn(store, { chat: CHAT, covers: [fresh.id] }), null, "no log");
  await appendEvents(store, CHAT, [fresh], { now: NOW });
  assert.equal(await loggedTurn(store, { chat: CHAT }), null, "no covers");
  assert.equal(await loggedTurn(store, { chat: CHAT, covers: [event().id] }), null, "not logged yet");
  assert.equal(await loggedTurn(store, { covers: [fresh.id] }), null, "no chat");
  assert.notEqual(await loggedTurn(store, { chat: CHAT, covers: [fresh.id] }), null);
});
