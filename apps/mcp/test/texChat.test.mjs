/**
 * The chat's intake object (`src/texChat.js`): queuing, the day-long dedupe, the caps per queue, the alarm that prunes
 * seen events and touches nothing queued, and what `GET /queue` shows.
 *
 * Sabotage record (to be applied, run, observed failing, reverted):
 *  1. Skip the dedupe check in `arrive` → "a duplicate within a day is answered, not queued" must fail.
 *  2. Drop the cap check in `arrive` → "a queue at its cap refuses the next text" must fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SEEN_FOR_MS, TexChatDurableObject } from "../src/texChat.js";
import { chatState } from "./texChatFixture.mjs";

const DAY = SEEN_FOR_MS;

function chatAt(clock = { now: 1_000_000 }) {
  const state = chatState();
  const chat = new TexChatDurableObject(state, {}, { now: () => clock.now });
  return { chat, state, storage: state.storage, clock };
}

const arrive = (chat, body) => chat.fetch(new Request("https://chat/arrive", { method: "POST", body: JSON.stringify(body) }));
const text = (eventId, extra = {}) => ({ kind: "one", inbox: "chat-one", eventId, message: { text: `words ${eventId}` }, ...extra });

test("a new text is queued with its sequence number and the inbox kept", async () => {
  const { chat, storage } = chatAt();
  const answer = await arrive(chat, text("e1", { origin: "sendblue" }));
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { outcome: "queued", seq: 1 });
  assert.equal(await storage.get("inbox"), "chat-one");
  const stored = await storage.get("pending:000000000001");
  assert.deepEqual(stored, { kind: "one", inbox: "chat-one", origin: "sendblue", message: { text: "words e1" }, at: 1_000_000 });
  assert.equal(await storage.get("seq"), 1);
});

test("an event seen within a day is answered duplicate and queued once", async () => {
  const { chat, clock, storage } = chatAt();
  await arrive(chat, text("e1"));
  clock.now += DAY - 1;
  assert.deepEqual(await (await arrive(chat, text("e1"))).json(), { outcome: "duplicate" });
  assert.equal((await storage.list({ prefix: "pending:" })).size, 1);
});

test("a duplicate is answered even when its queue is full", async () => {
  const { chat } = chatAt();
  await arrive(chat, text("e0"));
  for (let i = 1; i < 20; i += 1) await arrive(chat, text(`e${i}`));
  assert.deepEqual(await (await arrive(chat, text("e0"))).json(), { outcome: "duplicate" });
});

test("an event seen more than a day ago is queued again", async () => {
  const { chat, clock } = chatAt();
  await arrive(chat, text("e1"));
  clock.now += DAY + 1;
  assert.deepEqual(await (await arrive(chat, text("e1"))).json(), { outcome: "queued", seq: 2 });
});

test("a text without an event id is never deduped", async () => {
  const { chat } = chatAt();
  const body = { kind: "one", inbox: "chat-one", message: { text: "same" } };
  assert.equal((await (await arrive(chat, body)).json()).outcome, "queued");
  assert.equal((await (await arrive(chat, body)).json()).outcome, "queued");
});

test("the alarm prunes seen events older than a day and leaves the queue alone", async () => {
  const { chat, clock, storage } = chatAt();
  await arrive(chat, text("old"));
  clock.now += 1_000;
  await arrive(chat, text("new"));
  clock.now += DAY - 500;
  await chat.alarm();
  assert.equal(await storage.get("seen:old"), undefined);
  assert.notEqual(await storage.get("seen:new"), undefined);
  assert.equal((await storage.list({ prefix: "pending:" })).size, 2);
  assert.equal(await storage.get("seq"), 2);
});

test("the alarm keeps itself for the next expiry while seen events remain, and nothing once none do", async () => {
  const { chat, clock, storage } = chatAt();
  await arrive(chat, text("a"));
  clock.now += 5_000;
  await arrive(chat, text("b"));
  clock.now += DAY;
  storage.fire();
  await chat.alarm();
  assert.equal(storage.alarm, 1_000_000 + 5_000 + DAY);
  clock.now += 5_000;
  storage.fire();
  await chat.alarm();
  assert.equal(storage.alarm, null);
  assert.equal((await storage.list({ prefix: "seen:" })).size, 0);
});

test("a 1:1 queue at its cap of twenty refuses the next text, and a react counts against it", async () => {
  const { chat } = chatAt();
  for (let i = 0; i < 19; i += 1) assert.equal((await (await arrive(chat, text(`t${i}`))).json()).outcome, "queued");
  assert.equal((await (await arrive(chat, { kind: "react", inbox: "chat-one", eventId: "r1", message: {} })).json()).outcome, "queued");
  assert.deepEqual(await (await arrive(chat, text("t-over"))).json(), { outcome: "full" });
  assert.deepEqual(await (await arrive(chat, { kind: "react", inbox: "chat-one", eventId: "r2", message: {} })).json(), { outcome: "full" });
});

test("a group queue at its cap of ten refuses the next group or members text, and a refused text can be retried", async () => {
  const { chat, storage } = chatAt();
  for (let i = 0; i < 10; i += 1) assert.equal((await (await arrive(chat, { kind: i % 2 ? "members" : "group", inbox: "g-1", eventId: `g${i}`, message: {} })).json()).outcome, "queued");
  assert.deepEqual(await (await arrive(chat, { kind: "group", inbox: "g-1", eventId: "g-over", message: {} })).json(), { outcome: "full" });
  assert.equal(await storage.get("seen:g-over"), undefined);
  // The refused text was not seen, so the same event queues once there is room.
  assert.equal(await storage.get("gseq"), 10);
  // A full group queue leaves the one queue alone.
  assert.equal((await (await arrive(chat, text("still-room"))).json()).outcome, "queued");
});

test("a malformed body is answered 400 and nothing is queued", async () => {
  const { chat, storage } = chatAt();
  for (const body of [
    { kind: "bogus", inbox: "chat-one", message: {} },
    { kind: "one", inbox: "chat-one", message: [] },
    { kind: "one", inbox: 7, message: {} },
  ]) {
    assert.equal((await arrive(chat, body)).status, 400);
  }
  const notJson = await chat.fetch(new Request("https://chat/arrive", { method: "POST", body: "{nope" }));
  assert.equal(notJson.status, 400);
  assert.equal((await storage.list({})).size, 0);
});

test("GET /queue lists both queues in arrival order without any message text", async () => {
  const { chat, clock } = chatAt();
  await arrive(chat, text("one-a", { message: { text: "SECRET WORDS" } }));
  clock.now += 10;
  await arrive(chat, { kind: "group", inbox: "g-1", eventId: "g-a", message: { text: "SECRET GROUP" } });
  clock.now += 10;
  await arrive(chat, text("one-b"));
  const body = await (await chat.fetch(new Request("https://chat/queue"))).json();
  assert.deepEqual(body.items, [
    { seq: 1, at: 1_000_000, kind: "one" },
    { seq: 1, at: 1_000_010, kind: "group" },
    { seq: 2, at: 1_000_020, kind: "one" },
  ]);
  assert.ok(!JSON.stringify(body).includes("SECRET"));
});

test("unknown routes are 404", async () => {
  const { chat } = chatAt();
  assert.equal((await chat.fetch(new Request("https://chat/nope"))).status, 404);
});
