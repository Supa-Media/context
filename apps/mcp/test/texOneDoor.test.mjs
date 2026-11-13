/**
 * ONE DOOR (Dev2, 2026-11-13: "fewer doors", the one-record design): a turn that answers no named text (a routine or
 * check-in, a job's report, a group turn the Worker named nothing for) reads its chat from the chat's ledger the same
 * way a reply does (`src/agent/loggedTurn.js` `momentView`). Before, a 1:1 routine read no chat at all and a group
 * check-in read the old group memory file, which takes a quiet text only at the next turn: the 6 pm check-in of
 * 2026-11-12 answered a text from the night before.
 *
 * Sabotage (2026-11-13, temporary local edits, reverted; each fails a test here):
 *  - `checkItMayRun` passing `moment: false`: "a routine reads the chat ..." and "a job's report reads the chat ...";
 *  - `momentView` returning null: every test below;
 *  - `readTheSetup` keeping today's `shown`: "a routine reads the chat ...".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEgressWorld, request, TOKEN_ROUTINE, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { MOMENT_PREFACE, momentView } from "../src/agent/loggedTurn.js";

const CHAT = "sendblue:line:+15555550100";
let seq = 0;
const event = (at, fields = {}) => ({ id: `${at}-${String(++seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields });

async function chatSoFar(world) {
  const now = Date.now();
  const asked = event(now - 60_000, { text: "the dentist moved to Thursday 4pm" });
  const posted = async (events) => assert.equal((await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events })).status, 200);
  await posted([asked]);
  world.model.install([{ text: "Got it, Thursday at 4." }]);
  const one = await request(world.env, TOKEN_TEXTS, "/agent", { question: asked.text, conversation: "texts", covers: [asked.id], chat: CHAT, recent: [asked], turn: "turn-door-0001" });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  await posted([event(Date.now(), { from: { kind: "tex" }, text: "Got it, Thursday at 4.", turn: "turn-door-0001", covers: [asked.id], delivered: true })]);
  return one;
}

test("a routine reads the chat from its ledger, the newest texts and Tex's own reply included", async () => {
  const world = await createEgressWorld();
  try {
    await chatSoFar(world);
    world.model.install([{ text: "Reminder: dentist Thursday at 4." }]);
    const run = await request(world.env, TOKEN_ROUTINE, "/agent", { routine: { path: "routines/daily/brief.md" } });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    const shown = JSON.stringify(world.model.requests.at(-1).messages);
    assert.ok(shown.includes(MOMENT_PREFACE.slice(1, 40)), "the routine is shown the chat, as a reply is");
    assert.match(shown, /the dentist moved to Thursday 4pm/, "their newest text");
    assert.match(shown, /Got it, Thursday at 4\./, "and Tex's own reply to it");
  } finally {
    world.restore();
  }
});

test("a job's report reads the chat from its ledger, as a reply does", async () => {
  const world = await createEgressWorld();
  try {
    const one = await chatSoFar(world);
    world.model.install([{ text: "Your application is drafted." }]);
    const report = await request(world.env, TOKEN_TEXTS, "/agent", { question: "", conversation: "texts", event: "job_report", jobReport: { title: "Application", state: "done", texts: ["Drafted every answer."] }, chat: CHAT, turn: "turn-door-0002", warm: one.body.warm });
    assert.equal(report.status, 200, JSON.stringify(report.body));
    const shown = JSON.stringify(world.model.requests.at(-1).messages);
    assert.ok(shown.includes(MOMENT_PREFACE.slice(1, 40)), "the report's turn is shown the chat from the ledger");
    assert.match(shown, /the dentist moved to Thursday 4pm/);
  } finally {
    world.restore();
  }
});

test("a group turn that names no text sees the chat's newest quiet text, never only what the old memory held", () => {
  const now = Date.UTC(2026, 10, 12, 23, 0);
  const key = "a".repeat(64);
  const entry = (at, from, text, n) => ({ v: 1, seq: n, kind: "text", eid: `${at}-${String(n).padStart(6, "0")}`, event: "text", at, from, text });
  // Newest first, as the ledger reads.
  const entries = [
    entry(now - 5 * 60_000, { kind: "person", who: "b".repeat(64), name: "Bo" }, "who's bringing the cake tonight?", 3),
    entry(now - 26 * 3_600_000, { kind: "tex" }, "Noted.", 2),
    entry(now - 26 * 3_600_000 - 60_000, { kind: "person", who: "c".repeat(64), name: "Ada" }, "this is testing grounds", 1),
  ];
  const view = momentView({ entries, chat: key }, { timeZone: "UTC", now, group: { key } });
  assert.ok(view !== null);
  const text = view.history[0].text;
  assert.ok(text.startsWith(MOMENT_PREFACE));
  assert.match(text, /who's bringing the cake tonight\?/, "the quiet text from five minutes ago is there");
  assert.ok(text.indexOf("testing grounds") < text.indexOf("cake tonight"), "oldest first, so the newest is last");
  assert.equal(momentView({ entries: [], chat: key }, { now }), null, "an empty ledger leaves the turn to today's history");
});
