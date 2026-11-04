/**
 * Dev2's 2026-11-04 morning chat with Tex, as a golden case for the harness
 * (`docs/decisions/texting-assistant/do-the-read.md`). Each test is one thing
 * that went wrong there, and fails if that harness gap comes back:
 *
 *  - a voice message's words were gone a turn later ("@seyi: (a file)"), so
 *    "email Joe" was lost and an older question answered instead;
 *  - a message Dev2's ChatGPT agent asked Tex to pass on was shown as Tex's
 *    own words, and Tex disowned it;
 *  - the 12 s nudge said "otherwise answer now", and Tex offered three reads
 *    and a draft it could have done, and never asked the advisor it was asked to.
 *
 * Sabotage record (2026-11-04), each fails a test here:
 *  - `heardEntry` keeping the event's own ledger id (the append drops it as a retry) → "a voice message's words reach the next turn";
 *  - `dayFromLedger` without its one-entry-per-event check → same test;
 *  - `noteEvent` without `sentOnItsOwn` → "a message another agent asked Tex to pass on is that agent's";
 *  - `doItChecks` without the advisor branch → "asking for the advisor makes the turn ask it";
 *  - "answer now" back in `SLOW_TURN_NOTE` → "the slow-turn nudge never says answer now".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { texLedger } from "../src/texStore/ledger.js";
import { durableSql } from "./texStoreFixture.mjs";
import { eventEntry } from "../src/agent/ledger.js";
import { heardEntry, heardEvents } from "../src/agent/heardWords.js";
import { dayFromLedger, earlierFromLedger, HELD_BACK } from "../src/agent/ledgerHistory.js";
import { renderEvents } from "../src/agent/logRender.js";
import { conversationFromLedger } from "../src/agent/ledgerConversation.js";
import { checkEvent } from "../src/agent/log.js";
import { ATTENTION_QUESTION } from "../src/agent/attention.js";
import { sentByItself } from "../src/agent/sentByItself.js";
import { ADVISOR_NOTICE, doItChecks, offersARead, READ_NOTICE } from "../src/agent/doItChecks.js";
import { SLOW_TURN_NOTE } from "../src/agent/background.js";
import { ADVISOR_TOOL } from "../src/agent/advisor.js";

const CHAT = "texts";
const AT = 1_793_804_525_376; // 15:02 UTC, the voice message
const VOICE_ID = `${AT}-000522`;
const SAID = "Email Joe that we submitted it and haven't heard back, and is the SLA in the documents?";
const voiceEvent = { id: VOICE_ID, at: AT, chat: CHAT, from: { kind: "person", name: "seyi" }, kind: "file" };

function ledgerWith(entries) {
  const ledger = texLedger(durableSql());
  ledger.append(CHAT, entries);
  return ledger;
}

test("a voice message's words are put on the person's own line once heard, and only on a wordless file of theirs", () => {
  const heard = [{ name: "voice.m4a", mediaType: "audio/mp4", text: SAID, heard: true }];
  assert.deepEqual(heardEvents(heard, [voiceEvent]), [{ ...voiceEvent, text: SAID, heard: "voice" }]);
  assert.deepEqual(heardEvents(heard, [{ ...voiceEvent, kind: "text", text: "hi" }]), [], "not a text");
  assert.deepEqual(heardEvents(heard, [{ ...voiceEvent, from: { kind: "tex" } }]), [], "not Tex's");
  assert.deepEqual(heardEvents([{ name: "a.pdf", mediaType: "application/pdf", text: "pdf words" }], [voiceEvent]), [], "only what was heard");
  const two = [voiceEvent, { ...voiceEvent, id: `${AT + 1}-000523`, at: AT + 1 }];
  const pair = heardEvents([heard[0], { ...heard[0], text: "second" }], two);
  assert.deepEqual(pair.map((event) => event.text), [SAID, "second"], "as many files as voices pair in order");
  assert.deepEqual(heardEvents([heard[0], heard[0], heard[0]], two), [], "an uneven count is never guessed");
});

test("a voice message's words reach the next turn, the History file and the rebuilt chat, said by them", () => {
  const ledger = ledgerWith([eventEntry({ ...voiceEvent, text: "" })]);
  const [restated] = heardEvents([{ name: "voice.m4a", mediaType: "audio/mp4", text: SAID, heard: true }], [voiceEvent]);
  ledger.append(CHAT, [heardEntry(restated)]);
  assert.equal(ledger.read(CHAT).entries.length, 2, "the words are a newer entry beside the first, never a retry dropped");

  const newestFirst = ledger.read(CHAT, { before: Number.MAX_SAFE_INTEGER }).entries;
  const day = dayFromLedger(newestFirst, CHAT, [VOICE_ID]);
  assert.equal(day.length, 1, "one event, not two");
  const line = renderEvents(day, { timeZone: "America/New_York" });
  assert.match(line, /@seyi: \(a voice message\) Email Joe that we submitted it/);
  assert.doesNotMatch(line, /\(a file\)/);

  const earlier = earlierFromLedger(newestFirst, CHAT);
  assert.equal(earlier.events.length, 1);
  assert.match(renderEvents(earlier.events), /\(a voice message\) Email Joe/);

  // The rebuilt chat: their question carries the words once, and the voice line the reply noted is not repeated.
  const turn = "turnvoice01";
  ledger.append(CHAT, [
    { v: 1, id: "reply1", at: AT + 30_000, kind: "reply", turn, clean: true, attached: `[Sent with this text: voice.m4a.]\n[Voice message voice.m4a: "${SAID}"]` },
    eventEntry({ id: `${AT + 31_000}-000524`, at: AT + 31_000, chat: CHAT, from: { kind: "tex" }, kind: "text", text: "Drafted it.", turn, covers: [VOICE_ID], delivered: true }),
  ]);
  const turns = conversationFromLedger(ledger.read(CHAT).entries);
  const asked = turns.find((entry) => entry.role === "user");
  assert.equal(asked.text.split(SAID).length - 1, 1, asked.text);
  assert.match(asked.text, /^\(a voice message\) Email Joe/);
  assert.match(asked.text, /\[Sent with this text: voice\.m4a\.\]/);
});

test("only a person's file can carry heard words through the event check", () => {
  const now = AT;
  assert.equal(checkEvent({ ...voiceEvent, text: SAID, heard: "voice" }, { chat: CHAT, now }).heard, "voice");
  assert.throws(() => checkEvent({ ...voiceEvent, kind: "text", text: SAID, heard: "voice" }, { chat: CHAT, now }));
  assert.throws(() => checkEvent({ ...voiceEvent, from: { kind: "tex" }, heard: "voice" }, { chat: CHAT, now }));
  assert.throws(() => checkEvent({ ...voiceEvent, heard: "yes" }, { chat: CHAT, now }));
});

test("a message another agent asked Tex to pass on is that agent's, never Tex's or theirs", () => {
  const relayed = "ChatGPT: Both connector submissions are started; neither sent.";
  const note = { v: 1, id: "relay1", at: AT - 400_000, kind: "note", text: relayed, about: ATTENTION_QUESTION, seq: 7 };
  const clean = earlierFromLedger([note], CHAT);
  const shown = renderEvents(clean.events, { timeZone: "America/New_York" });
  assert.match(shown, /Their other agent, passed on by you: ChatGPT: Both connector/);
  assert.match(shown, /another of their agents asked you to pass this on; it is that agent's message, not yours and not theirs/);
  assert.doesNotMatch(shown, /You: ChatGPT/);

  // Kept tainted (an agent chose its words): its words are held back, still never as Tex's own.
  const held = renderEvents(earlierFromLedger([{ ...note, tainted: true }], CHAT).events);
  assert.match(held, /Their other agent, passed on by you: /);
  assert.ok(held.includes(HELD_BACK));

  // The same from the person's record, for the day the log holds.
  const fromRecord = sentByItself([{ role: "user", text: ATTENTION_QUESTION, at: AT - 400_000 }, { role: "assistant", text: relayed }], [], { chat: CHAT, newest: AT });
  assert.equal(fromRecord.shown[0].from.kind, "agent");

  // A check-in Tex sent on its own stays Tex's, with why it went out.
  const checkIn = earlierFromLedger([{ ...note, id: "checkin1", text: "Did the dentist call back?", about: "(Not a text from them. You checked in on what they asked you to follow up on.)" }], CHAT);
  assert.match(renderEvents(checkIn.events), /You: Did the dentist call back\?\n\s+\(sent on your own: You checked in on what they asked you to follow up on\.\)/);
});

test("an answer that offers a read, search, check or draft goes back once to do it; a send still waits", async () => {
  for (const offered of [
    "I haven't searched your inbox. Want me to check?",
    "Mostly them. Want me to read that thread?",
    "Want me to search it for their last message?",
    "Want me to draft the email to Jo for your yes?",
  ]) assert.equal(offersARead(offered), true, offered);
  for (const fine of ["Want me to send it?", "Should I book the 7pm?", "Done. The SLA is three business days.", "Want me to email Jo?", "Can I check one thing: is it the 14th?"]) assert.equal(offersARead(fine), false, fine);

  const checks = doItChecks({ question: "how long is the CASA review taking" });
  checks.wrapLocal([]);
  assert.equal(await checks.check("Want me to read that thread?"), READ_NOTICE);
  assert.equal(await checks.check("Want me to read that thread?"), null, "once");
});

test("asking for the advisor makes the turn ask it, decided from their words by the gateway", async () => {
  const local = [{ tool: { name: ADVISOR_TOOL }, call: async () => ({ content: [{ type: "text", text: "advice" }] }) }];
  const skipped = doItChecks({ question: "is this blocked by me or them? ask the advisor" });
  skipped.wrapLocal(local);
  assert.equal(await skipped.check("Mostly them."), ADVISOR_NOTICE);

  const asked = doItChecks({ question: "is this blocked by me or them? ask the advisor" });
  const [advisor] = asked.wrapLocal(local);
  await advisor.call({});
  assert.equal(await asked.check("Mostly them, per your advisor."), null);

  const theirs = doItChecks({ question: "my advisor said to file by Friday" });
  theirs.wrapLocal(local);
  assert.equal(await theirs.check("Got it."), null, "their own advisor is a person, not this one");
  const said = doItChecks({ question: "what does your advisor think?" });
  said.wrapLocal(local);
  assert.equal(await said.check("I think so."), ADVISOR_NOTICE);

  const none = doItChecks({ question: "is this blocked by me or them? ask the advisor" });
  none.wrapLocal([]);
  assert.equal(await none.check("Mostly them."), null, "a turn with no advisor is never sent back for one");

  const inner = doItChecks({ question: "hi", inner: { check: async () => "inner notice" } });
  assert.equal(await inner.check("Hello."), "inner notice", "the turn's other checks still run");
});

test("the slow-turn nudge never says answer now, and never stops a read", () => {
  assert.doesNotMatch(SLOW_TURN_NOTE, /answer now/i);
  assert.match(SLOW_TURN_NOTE, /never stop early to offer a read, search, check or draft/);
});
