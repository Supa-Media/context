/**
 * WHETHER TEX ANSWERS IS THE WORKER'S ONE JUDGE'S, NEVER THE GATEWAY'S (Dev2, 2026-11-11, one judge:
 * `docs/decisions/texting-assistant/one-judge-one-record.md`). The Haiku respond classifier and code's floor under
 * it (`mayHush`) are gone: a turn the Worker asked for runs the model, whatever the conversation classifier says, and
 * the classifier only sorts the thread, after the reply has gone (2026-11-12).
 *
 * Sabotage record (2026-11-11): `readVerdict` keeping the classifier's `respond` → "the classifier is asked only for the
 * thread and the place, and reads only those" fails.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { systemText } from "./agentModelFixture.mjs";
import { readVerdict, THREADS_SYSTEM } from "../src/agent/conversationThreads.js";

const CHAT = "sendblue:line:+15555550101";
let seq = 0;
const event = (at, fields = {}) => ({ id: `${at}-${String(++seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields });
const isClassifier = (body) => systemText(body).includes(THREADS_SYSTEM.slice(0, 60));

/** One texted turn after Tex's `said`, the classifier answering `verdict`, the model (if it runs) "Sure." */
async function turnAfter(said, text, verdict) {
  const world = await createEgressWorld();
  world.env.CONVERSATION_THREADS = "on";
  const now = Date.now();
  const earlier = event(now - 60_000, { text: "remind me about benefits" });
  const tex = event(now - 50_000, { from: { kind: "tex" }, text: said, turn: "turn-respond-0000", covers: [earlier.id], delivered: true });
  const asked = event(now - 1_000, { text });
  world.model.install([{ text: "Sure." }, { text: JSON.stringify({ thread: "new", title: "Benefits", description: "benefits deadline", finished: [], ...verdict }) }]);
  assert.equal((await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [earlier, tex, asked] })).status, 200);
  const answer = await request(world.env, TOKEN_TEXTS, "/agent", { question: text, conversation: "texts", covers: [asked.id], chat: CHAT, turn: `turn-respond-${String(++seq).padStart(4, "0")}` });
  return { world, answer };
}

test("a turn the Worker asked for always runs the model, whatever the classifier would once have said", async () => {
  for (const verdict of [{ respond: "react", emoji: "👍" }, { respond: "quiet" }]) {
    const { world, answer } = await turnAfter("Reminder: today's the deadline to pick your benefits.", "thanks ill look at it at work today", verdict);
    try {
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.equal(answer.body.answer, "Sure.");
      assert.equal(answer.body.react, undefined);
      assert.equal(world.model.requests.length, 2, "the model ran, and the classifier after it");
      assert.ok(!isClassifier(world.model.requests[0]));
      assert.ok(isClassifier(world.model.requests[1]));
    } finally {
      world.restore();
    }
  }
});

test("a reply carries no place from the classifier: it runs after the reply (Dev2, 2026-11-12)", async () => {
  const { world, answer } = await turnAfter("Reminder: today's the deadline to pick your benefits.", "can you move it to 4", { place: "under" });
  try {
    assert.equal(answer.body.answer, "Sure.");
    assert.equal(answer.body.place, undefined);
  } finally {
    world.restore();
  }
});

test("the classifier is asked only for the thread, and reads the thread and a place at most", () => {
  assert.ok(!/respond|quiet|"place"/.test(THREADS_SYSTEM));
  const verdict = readVerdict(JSON.stringify({ thread: "new", title: "x", description: "", finished: [], respond: "quiet", place: "plain" }), []);
  assert.deepEqual(verdict, { thread: "new", title: "x", description: "", finished: [], place: "plain" });
  assert.equal(readVerdict(JSON.stringify({ thread: "new", title: "x", place: "sideways" }), []).place, undefined);
});
