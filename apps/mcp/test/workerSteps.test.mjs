// The texting Worker's own steps reach the chat's ledger (Dev2, 2026-11-13:
// "every step should log its input output time and stuff, we need to be able
// to replay everything and track bugs and regressions"): a person's own
// chat's judging and every tapback, posted as `step` events with the chat's
// other events (`apps/agent/src/stepEvents.ts`). A step is never a line of the
// chat: no reader of the chat's events takes one.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { eventEntry, ledgerFor, ONE_TO_ONE_CHAT } from "../src/agent/ledger.js";
import { appendEvents, checkEvent, checkEvents, EventRefusal, STEP_KIND } from "../src/agent/log.js";
import { mergeEvents } from "../src/agent/warmCopy.js";
import { dayFromLedger } from "../src/agent/ledgerHistory.js";

const CHAT = "sendblue:line:+15555550100";
let seq = 0;
const id = (at) => `${at}-${String(++seq).padStart(6, "0")}`;
const text = (at, words) => ({ id: id(at), at, chat: CHAT, from: { kind: "person" }, kind: "text", text: words });
const step = (at, fields = {}) => ({
  id: id(at),
  at,
  chat: CHAT,
  from: { kind: "system" },
  kind: "step",
  step: { name: "decide", of: "waiting", ok: true, ms: 812, input: { style: "direct", candidates: ["1-000001"], newest: "1-000001", running: false, waitingAsks: 0, transcriptChars: 120 }, output: { act: "react", emoji: "👍", covers: [], why: "pure_ack" } },
  ...fields,
});
const refusedAt = (events) => {
  try {
    checkEvents(CHAT, events);
    return null;
  } catch (error) {
    if (!(error instanceof EventRefusal)) throw error;
    return error.field;
  }
};

test("a step event is checked at the door: from the system, a known step, no words, a bounded input and output", () => {
  const now = Date.now();
  const [kept] = checkEvents(CHAT, [step(now - 1_000)]);
  assert.equal(kept.kind, STEP_KIND);
  assert.deepEqual(kept.from, { kind: "system" });
  assert.equal(kept.step.name, "decide");
  assert.equal(kept.step.output.act, "react");
  assert.equal(refusedAt([step(now, { text: "the chat's words" })]), "events[0].event", "a step carries no words");
  assert.equal(refusedAt([step(now, { from: { kind: "person", who: "a".repeat(64) } })]), "events[0].from", "never a person's");
  assert.equal(refusedAt([step(now, { step: { name: "router", ok: true } })]), "events[0].step", "only the Worker's own steps");
  assert.equal(refusedAt([step(now, { step: { name: "react", ok: "yes" } })]), "events[0].step");
  assert.equal(refusedAt([step(now, { step: { name: "react", ok: true, extra: 1 } })]), "events[0].step");
  assert.equal(refusedAt([step(now, { step: { name: "react", ok: true, cause: "a line\nbreak" } })]), "events[0].step.cause");
  assert.equal(refusedAt([step(now, { step: { name: "react", ok: true, input: { words: "x".repeat(5_000) } } })]), "events[0].step.input");
  assert.equal(refusedAt([step(now, { step: { name: "react", ok: true, output: ["👍"] } })]), "events[0].step.output");
  assert.equal(refusedAt([step(now, { step: { name: "react", ok: true, ms: -1 } })]), "events[0].step.ms");
  // A step is no kind of the chat's lines: the check every reader of the chat uses refuses it.
  assert.throws(() => checkEvent(step(now), { chat: CHAT, now }), EventRefusal);
});

test("a step becomes a step entry with its input, output, time and outcome, kept once by its event id", () => {
  const now = Date.now();
  const event = checkEvents(CHAT, [step(now, { turn: "turn-step-0001" })])[0];
  const entry = eventEntry(event);
  assert.equal(entry.kind, "step");
  assert.equal(entry.step, "decide");
  assert.equal(entry.name, "waiting");
  assert.equal(entry.ok, true);
  assert.equal(entry.ms, 812);
  assert.equal(entry.turn, "turn-step-0001");
  assert.equal(entry.at, now);
  assert.equal(entry.input.style, "direct");
  assert.deepEqual(entry.output, event.step.output);
  assert.equal(entry.id, eventEntry(event).id, "the same step posted twice is one entry");
  assert.equal(entry.eid, event.id);
  const failed = eventEntry(checkEvents(CHAT, [step(now, { step: { name: "react", of: "classifier", ok: false, ms: 30, output: { emoji: "👍" }, cause: "TypeError" } })])[0]);
  assert.deepEqual([failed.step, failed.name, failed.ok, failed.reason], ["react", "classifier", false, "TypeError"]);
});

test("the Worker's posted steps reach a person's ledger as steps, once each, and never as a line of their chat", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const hi = text(now - 3_000, "thanks!");
    const judged = step(now - 2_000);
    const tapped = step(now - 1_000, { step: { name: "react", of: "decide", ok: true, ms: 140, input: { by: "decide", asked: "👍", on: hi.id }, output: { emoji: "👍" } } });
    for (let i = 0; i < 2; i += 1) {
      const posted = await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [hi, judged, tapped] });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
      assert.deepEqual(posted.body.written, [hi.id, judged.id, tapped.id], "the Worker forgets every one it posted");
    }
    const ledger = ledgerFor(world.env, { person: "ws_egress" });
    const { entries } = await ledger.read(ONE_TO_ONE_CHAT);
    const steps = entries.filter((entry) => entry.kind === "step");
    assert.deepEqual(steps.map((entry) => [entry.step, entry.name, entry.ok]), [["decide", "waiting", true], ["react", "decide", true]]);
    assert.equal(steps[1].input.on, hi.id, "the tapback names the text it was on");
    const texts = (await ledger.read(ONE_TO_ONE_CHAT, { kinds: ["text"] })).entries;
    assert.deepEqual(texts.map((entry) => entry.text), ["thanks!"], "the chat's lines hold the text alone");
    const day = dayFromLedger(entries, CHAT, []) ?? [];
    assert.ok(day.every((event) => event.kind !== "step"), "the day a turn and the judge read holds no step");
  } finally {
    world.restore();
  }
});

test("a step never reaches the old log or a turn's merged day", async () => {
  const now = Date.now();
  const written = [];
  const bucket = { get: async () => null, put: async (key) => written.push(key) };
  const hi = text(now - 2_000, "hi");
  const judged = step(now - 1_000);
  assert.deepEqual(await appendEvents(bucket, CHAT, [hi, judged], { now }), [hi.id, judged.id], "taken, so the Worker forgets it");
  assert.equal(written.length, 1, "only the text is written to the old log");
  const merged = mergeEvents([], [hi, judged], { chat: CHAT, now });
  assert.deepEqual(merged.map((event) => event.id), [hi.id]);
});
