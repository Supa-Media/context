/**
 * REPLY, REACT OR QUIET, DECIDED BEFORE THE MODEL (`respond.js`; Dev2, 2026-11-10: the classifier decides).
 *
 * End to end through `texEntryPoint`: a 1:1 "thanks ill look at it later" the classifier calls a react is answered
 * with a 👍 and no text, and the model never runs; a question, and a bare "ok" straight after Tex asked something,
 * still reach the model whatever the classifier said; a reply carries where it goes. Fails if `runTheModel.js` stops
 * hushing, or hushes past code's floor. Every turn the classifier ran leaves one `classify` entry in the chat's history
 * with both reasons, and the floor's when it kept the text for the model (Dev2, 2026-11-11).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { systemText } from "./agentModelFixture.mjs";
import { THREADS_SYSTEM } from "../src/agent/conversationThreads.js";
import { classifyEntry, examplesText, floorHolds, lastTexBefore, mayHush, readRespond, RESPOND_EXAMPLES } from "../src/agent/respond.js";

const CHAT = "sendblue:line:+15555550101";
let seq = 0;
const event = (at, fields = {}) => ({ id: `${at}-${String(++seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields });
const classified = (world) => world.tex.ledgerIn("person:ws_egress").filter((entry) => entry.kind === "classify");
const isClassifier = (body) => systemText(body).includes(THREADS_SYSTEM.slice(0, 60));

/** One texted turn after Tex's `said`, the classifier answering `verdict`, the model (if it runs) "Sure." */
async function turnAfter(said, text, verdict) {
  const world = await createEgressWorld();
  world.env.CONVERSATION_THREADS = "on";
  const now = Date.now();
  const earlier = event(now - 60_000, { text: "remind me about benefits" });
  const tex = event(now - 50_000, { from: { kind: "tex" }, text: said, turn: "turn-respond-0000", covers: [earlier.id], delivered: true });
  const asked = event(now - 1_000, { text });
  world.model.install([{ text: JSON.stringify({ thread: "new", title: "Benefits", description: "benefits deadline", thread_why: "a new subject: the benefits deadline", finished: [], ...verdict }) }, { text: "Sure." }]);
  assert.equal((await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [earlier, tex, asked] })).status, 200);
  const answer = await request(world.env, TOKEN_TEXTS, "/agent", { question: text, conversation: "texts", covers: [asked.id], chat: CHAT, turn: `turn-respond-${String(++seq).padStart(4, "0")}` });
  return { world, answer };
}

test("a thanks the classifier calls a react gets the tapback and no text, and the model never runs", async () => {
  const { world, answer } = await turnAfter("Reminder: today's the deadline to pick your benefits.", "thanks ill look at it at work today", { respond: "react", emoji: "👍", why: "thanks, asks nothing" });
  try {
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.answer, "");
    assert.equal(answer.body.quiet, true);
    assert.equal(answer.body.react, "👍");
    assert.equal(world.model.requests.length, 1, "only the classifier ran");
    assert.ok(isClassifier(world.model.requests[0]));
    const [kept] = classified(world);
    assert.equal(classified(world).length, 1, "one classify entry for the turn");
    assert.equal(kept.thread, "t1");
    assert.equal(kept.threadWhy, "a new subject: the benefits deadline");
    assert.deepEqual([kept.respond, kept.emoji, kept.why, kept.held], ["react", "👍", "thanks, asks nothing", undefined]);
    assert.match(kept.text, /^t1 \(new\) Benefits: a new subject: the benefits deadline · react 👍: thanks, asks nothing$/);
  } finally {
    world.restore();
  }
});

test("a quiet verdict on a question still runs the model", async () => {
  const { world, answer } = await turnAfter("Reminder: today's the deadline to pick your benefits.", "thanks, is it at 5?", { respond: "quiet", why: "thanks" });
  try {
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.answer, "Sure.");
    assert.equal(answer.body.react, undefined);
    assert.equal(world.model.requests.length, 2, "the model ran after the classifier");
    const [kept] = classified(world);
    assert.deepEqual([kept.respond, kept.held], ["quiet", "a question in a 1:1"], "the floor's reason is kept beside the classifier's");
  } finally {
    world.restore();
  }
});

test("a bare ok straight after Tex asked something is never hushed: it may be the yes", async () => {
  const { world, answer } = await turnAfter("Want me to put Dec 5 on your calendar? 👍 or 👎", "ok", { respond: "quiet", why: "an ok" });
  try {
    assert.equal(answer.body.answer, "Sure.");
    assert.equal(world.model.requests.length, 2);
  } finally {
    world.restore();
  }
});

test("a reply carries where it goes", async () => {
  const { world, answer } = await turnAfter("Reminder: today's the deadline to pick your benefits.", "can you move it to 4", { respond: "reply", place: "under", why: "an ask" });
  try {
    assert.equal(answer.body.answer, "Sure.");
    assert.equal(answer.body.place, "under");
    const [kept] = classified(world);
    assert.deepEqual([kept.respond, kept.place, kept.why, kept.held], ["reply", "under", "an ask", undefined], "a reply's decision and reason are kept too");
  } finally {
    world.restore();
  }
});

test("the respond part reads only its own words, and anything else is a reply", () => {
  assert.deepEqual(readRespond({}), { respond: "reply" });
  assert.deepEqual(readRespond({ respond: "shrug", emoji: "👍" }), { respond: "reply" });
  assert.deepEqual(readRespond({ respond: "react", emoji: " 🎉 ", place: "under", why: "news" }), { respond: "react", emoji: "🎉", why: "news" });
  assert.deepEqual(readRespond({ respond: "reply", place: "sideways" }), { respond: "reply" });
  assert.deepEqual(readRespond({ respond: "reply", place: "plain" }), { respond: "reply", place: "plain" });
  assert.equal(readRespond({ respond: "react", emoji: "a long word, not an emoji" }).emoji, undefined);
});

test("code's floor: what is never hushed whatever the classifier says", () => {
  const quiet = { respond: "quiet" };
  assert.equal(mayHush({ verdict: quiet, text: "lol" }), true);
  assert.equal(mayHush({ verdict: { respond: "reply" }, text: "lol" }), false);
  assert.equal(mayHush({ verdict: quiet, text: "is it at 5?" }), false, "a question in a 1:1");
  assert.equal(mayHush({ verdict: quiet, text: "is it at 5?", group: true }), true, "a question to someone else in a group");
  assert.equal(mayHush({ verdict: quiet, text: "Tex you talk too much", group: true }), false, "a group text naming Tex");
  assert.equal(mayHush({ verdict: quiet, text: "look", files: 1 }), false, "a file in a 1:1");
  assert.equal(mayHush({ verdict: quiet, text: "look", files: 1, group: true }), true);
  assert.equal(mayHush({ verdict: quiet, text: "👍", tapback: true }), false, "a tapback that reached a turn");
  assert.equal(mayHush({ verdict: quiet, text: "ok", lastTex: "Want me to? 👍 or 👎", between: 0 }), false, "straight after Tex asked");
  assert.equal(mayHush({ verdict: quiet, text: "ok", group: true, lastTex: "Want me to?", between: 2 }), true, "others talked since");
  assert.equal(mayHush({ verdict: quiet, text: "  " }), false);
  assert.equal(mayHush({ verdict: quiet, text: "still where?", group: true, repliesToTex: true }), false, "a question typed under Tex's text");
  assert.equal(mayHush({ verdict: quiet, text: "💔", group: true, repliesToTex: true }), true, "a reaction typed under it");
});

test("Tex's last text before the new ones, and how many people's texts came since", () => {
  const events = [
    { id: "a", from: { kind: "person" }, text: "x" },
    { id: "b", from: { kind: "tex" }, text: "Want it?" },
    { id: "c", from: { kind: "person" }, text: "y" },
    { id: "d", from: { kind: "person" }, text: "z" },
  ];
  assert.deepEqual(lastTexBefore(events, ["d"]), { lastTex: "Want it?", between: 1 });
  assert.deepEqual(lastTexBefore(events.slice(0, 1)), { lastTex: null, between: 1 });
});

test("the classifier is shown every labelled example, and each label is one it may give", () => {
  for (const item of RESPOND_EXAMPLES) {
    assert.ok(["reply", "react", "quiet"].includes(item.respond), item.text);
    assert.ok(item.chat === "group" || item.chat === "one");
    if (item.respond === "reply") assert.ok(item.place === "under" || item.place === "plain", item.text);
    assert.ok(THREADS_SYSTEM.includes(item.text), item.text);
  }
  assert.ok(THREADS_SYSTEM.includes(examplesText()));
});

test("a classifier that failed or was late is kept as no verdict; the floor names why it held a text", () => {
  const none = classifyEntry({ ms: 4_000, verdict: null }, { model: "m", turn: "t" });
  assert.deepEqual([none.kind, none.verdict, none.ms, none.turn], ["classify", "none", 4000, "t"]);
  assert.equal(floorHolds({ text: "ok", lastTex: "Want it?", between: 0 }), "straight after Tex asked something");
  assert.equal(floorHolds({ text: "lol" }), null);
  assert.equal(floorHolds({ text: "look", files: 1 }), "a file in a 1:1");
});
