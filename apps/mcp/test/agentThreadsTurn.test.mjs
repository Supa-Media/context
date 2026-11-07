/**
 * A TEXTED TURN, BY CONVERSATION, END TO END (`texEntryPoint/readTheHistory.js` starts the classifier,
 * `runTheModel.js` waits for it and keeps its verdict; Dev2, 2026-11-07, "just launch it").
 *
 * The first text starts thread t1 and the verdict is kept after the answer; the second text's classifier is shown
 * t1, and the front door's prompt lists it, says the text continues it, and offers `read_thread`.
 * Fails if `runTheModel.js` stops using the threaded history, or the verdict is never written.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { systemText } from "./agentModelFixture.mjs";
import { THREADS_SYSTEM } from "../src/agent/conversationThreads.js";

const CHAT = "sendblue:line:+15555550100";
let seq = 0;
const event = (at, fields = {}) => ({ id: `${at}-${String(++seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields });
const isClassifier = (body) => systemText(body).includes(THREADS_SYSTEM.slice(0, 60));

test("a texted turn is sorted into a thread before the model, and the next turn is shown it", async () => {
  const world = await createEgressWorld();
  world.env.CONVERSATION_THREADS = "on";
  try {
    const now = Date.now();
    const first = event(now - 5_000, { text: "find me a hotel in Lisbon under 180" });
    world.model.install([{ text: '{"thread":"new","title":"Lisbon hotel","description":"wants a hotel under $180","finished":[]}' }, { text: "Memmo Alfama, $172." }]);
    assert.equal((await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [first] })).status, 200);
    const one = await request(world.env, TOKEN_TEXTS, "/agent", { question: first.text, conversation: "texts", covers: [first.id], chat: CHAT, turn: "turn-threads-0001" });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.ok(isClassifier(world.model.requests[0]), "the classifier is the first call");
    assert.match(JSON.stringify(world.model.requests[1].messages), /starts a new conversation/);

    const reply = event(now - 4_000, { from: { kind: "tex" }, text: "Memmo Alfama, $172.", turn: "turn-threads-0001", covers: [first.id], delivered: true });
    assert.equal((await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [reply] })).status, 200);
    const second = event(now - 1_000, { text: "book it" });
    world.model.install([{ text: '{"thread":"t1","title":"Lisbon hotel","description":"booking Memmo Alfama","finished":[]}' }, { text: "Booking it." }]);
    const two = await request(world.env, TOKEN_TEXTS, "/agent", { question: second.text, conversation: "texts", covers: [second.id], chat: CHAT, recent: [second], turn: "turn-threads-0002" });
    assert.equal(two.status, 200, JSON.stringify(two.body));
    const classifier = world.model.requests.at(-2);
    assert.ok(isClassifier(classifier));
    assert.match(JSON.stringify(classifier.messages), /t1 · open · Lisbon hotel/, "the first verdict was kept and read back");
    const front = JSON.stringify(world.model.requests.at(-1));
    assert.match(front, /t1 · open · Lisbon hotel/);
    assert.match(front, /most likely continues t1/);
    assert.match(front, /read_thread/);
  } finally {
    world.restore();
  }
});
