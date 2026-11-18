// A check-in shown once in every reader of a one-to-one chat (Dev2, 2026-11-18: a check-in at 8:01 AM was missing from
// the chat's history, because `/routine-text` texted it and recorded no Tex text event, only the gateway's note). Now the
// Worker records the text too, with its `source` and its note's `turn` (`sentOnItsOwn.js`). The readers must show the
// check-in once, whichever of the two they read, and never a text that was not said.
//
// Sabotage record (to apply and run before merge): drop `withNoteReason` or the `isLinkedText` skip in
// `ledgerHistory.js` earlierFromLedger, and the "once" checks fail; drop `isUnsentText` in `dayFromLedger`, and the
// undelivered check-in shows; drop `notSaidOwn` from `loggedTurn.js`, and the record's copy of it shows.
import { test } from "node:test";
import assert from "node:assert/strict";

import { dayFromLedger, earlierFromLedger } from "../src/agent/ledgerHistory.js";
import { conversationFromLedger } from "../src/agent/ledgerConversation.js";
import { stretchSince, stretchTurns } from "../src/agent/stretch.js";
import { sentByItself } from "../src/agent/sentByItself.js";
import { notSaidOwn, linkedSends, saidTexts } from "../src/agent/sentOnItsOwn.js";
import { eventEntry, wordsEntry } from "../src/agent/ledger.js";
import { checkInAbout } from "../src/agent/checkInTexts.js";
import { momentView, loggedTurn } from "../src/agent/loggedTurn.js";
import { weekView } from "../src/agent/weekHistory.js";
import { threadLines } from "../src/http/texPage/conversations.js";

const CHAT = "sendblue:line:+15555550100";
const T = Date.UTC(2026, 10, 18, 7, 50, 0); // 7:50 AM, the person's text
const MIN = 60_000;
const CHECK_TEXT = "The Maple Street ticket was claimed by Dana at 7:58, so I left it alone.";
const ANSWER_TEXT = "Dana claimed it, I'd rather not poke around her side of the board.";
const CK = "ck0123456789abcdef0123";
const REPLY_TURN = "turnReply20260001";
const ASK = "Can't you just check for yourself who claimed it?";
let n = 0;
const id = (at) => `${at}-${String(++n).padStart(6, "0")}`;
const person = (at, text) => eventEntry({ id: id(at), at, chat: CHAT, from: { kind: "person" }, kind: "text", text });
const texFrom = (at, text, extra = {}) => eventEntry({ id: id(at), at, chat: CHAT, from: { kind: "tex" }, kind: "text", text, delivered: true, ...extra });
const checkNote = (at, turn = CK) => wordsEntry("note", CHECK_TEXT, { turn, at, about: checkInAbout({ reason: "the ticket board changed while I was looking" }) });
const count = (haystack, needle) => String(haystack).split(needle).length - 1;
const ids = (events) => events.map((event) => event.id);

// The chat: their 7:50 text, the check-in at 8:01 (its note, then its Worker text three seconds on), and their 10:30 reply
// with Tex's answer. Entries as the ledger holds them, newest first is not required.
function chat({ delivered = true, withText = true, withNote = true } = {}) {
  const at = T + 11 * MIN; // 8:01
  const entries = [person(T, "Did anyone take the Maple Street ticket?")];
  if (withNote) entries.push(checkNote(at));
  if (withText) entries.push(texFrom(at + 3_000, CHECK_TEXT, { turn: CK, source: "checkin", delivered }));
  const asked = T + 160 * MIN; // 10:30
  const askEntry = person(asked, ASK);
  entries.push(askEntry);
  entries.push(wordsEntry("reply", ANSWER_TEXT, { turn: REPLY_TURN, clean: true, at: asked + 1_000 }));
  entries.push(texFrom(asked + 2_000, ANSWER_TEXT, { turn: REPLY_TURN, covers: [askEntry.eid] }));
  return { entries, asked: askEntry, at };
}
const texts = (events) => events.filter((event) => event.kind === "text" || event.from?.kind === "tex").map((event) => event.text ?? "").join("\n");
const shownOf = (list) => list.filter((entry) => entry.kind === "text" && entry.text === CHECK_TEXT).length;

test("the day holds the check-in's Worker text once, with the reason of its note", () => {
  const { entries } = chat();
  const day = dayFromLedger(entries, CHAT, []);
  assert.ok(day, "the day reads");
  const checkins = day.filter((event) => event.text === CHECK_TEXT);
  assert.equal(checkins.length, 1, "shown once in the day");
  assert.equal(checkins[0].byItself, true, "as a text Tex sent on its own");
  assert.match(checkins[0].why, /^sent on your own: /, "with why it went out, from its note");
});

test("an earlier read shows the check-in once: its note, or its text when the day already has it", () => {
  const { entries, at } = chat();
  const whole = earlierFromLedger(entries, CHAT, { before: Number.MAX_SAFE_INTEGER, chars: Number.MAX_SAFE_INTEGER, fade: false });
  assert.equal(whole.events.filter((event) => event.text === CHECK_TEXT).length, 1, "a read of the whole chat shows it once");
  assert.equal(whole.events.find((event) => event.text === CHECK_TEXT).byItself, true, "the note's reason is kept");
  // The day and the earlier days together, as a turn reads them: once in all. Here the day starts after the check-in's
  // note (the person's 7:50 text is earlier), so the note is in the earlier days, and the Worker's text in the day.
  const day = dayFromLedger(entries.filter((entry) => entry.at > T), CHAT, []);
  assert.equal(day[0].text, CHECK_TEXT, "the day starts with the check-in's text");
  const earlier = earlierFromLedger(entries, CHAT, { before: day[0].at, known: new Set(day.map((event) => event.id)), chars: Number.MAX_SAFE_INTEGER, fade: false });
  assert.equal(earlier.events.filter((event) => event.text === CHECK_TEXT).length, 0, "the note is left out of the earlier days: the day shows the text");
  assert.equal(day.filter((event) => event.text === CHECK_TEXT).length + earlier.events.filter((event) => event.text === CHECK_TEXT).length, 1, "day and earlier together: once");
  assert.ok(at > 0);
});

test("conversationFromLedger shows the check-in's note once, and the Worker text adds nothing", () => {
  const { entries } = chat();
  const turns = conversationFromLedger(entries);
  assert.equal(turns.filter((turn) => turn.role === "assistant" && turn.text === CHECK_TEXT).length, 1, "one answer for the check-in");
  assert.equal(turns.filter((turn) => turn.role === "assistant" && turn.text === ANSWER_TEXT).length, 1, "and the answer to their 10:30 text");
});

test("the check-in's taint is its note's: a tainted note stays tainted, the Worker text does not change it", () => {
  const { entries } = chat();
  const tainted = entries.map((entry) => (entry.kind === "note" ? { ...entry, tainted: true } : entry));
  const turn = conversationFromLedger(tainted).find((entry) => entry.role === "assistant" && entry.text === CHECK_TEXT);
  assert.equal(turn.tainted, true, "tainted when the note was");
  const clean = conversationFromLedger(chat().entries).find((entry) => entry.role === "assistant" && entry.text === CHECK_TEXT);
  assert.equal(clean.tainted, undefined, "not tainted when the note was not");
  // A Tex text event on its own never marks a turn: the answer to the 10:30 text is clean.
  assert.equal(conversationFromLedger(chat().entries).find((entry) => entry.text === ANSWER_TEXT).tainted, undefined);
});

test("the stretch carries the check-in once when the stretch begins before it", () => {
  const { entries } = chat();
  const turns = stretchTurns(entries, [], { since: T, covered: new Set(), group: false });
  assert.equal(turns.filter((turn) => turn.role === "assistant" && turn.text === CHECK_TEXT).length, 1, "once, from its note");
});

test("the stretch of a reply an hour after the check-in starts after it: it is shown from the day, not twice", () => {
  const { entries, asked } = chat();
  const since = stretchSince(entries);
  assert.ok(since > T + 11 * MIN, "the 10:30 text starts a new stretch: the check-in is more than an hour before");
  const turns = stretchTurns(entries, [], { since, covered: new Set([asked.eid]), group: false });
  assert.equal(turns.filter((turn) => turn.text === CHECK_TEXT).length, 0, "not in this stretch");
});

test("the week view shows the check-in once, even an hour after it", () => {
  const { entries } = chat();
  const week = weekView({ entries, chat: CHAT, start: T - 86_400_000, chars: 1_000_000, days: 7 });
  assert.equal(count(week.text, CHECK_TEXT), 1, "the week's text holds the check-in once");
  assert.equal(count(week.text, ANSWER_TEXT), 1, "and Tex's answer once");
});

test("the turn's view (momentView) and a logged turn show the check-in exactly once, with its record copy", async () => {
  const { entries, asked, at } = chat();
  const record = [
    { role: "user", text: `${checkInAbout({ reason: "the ticket board changed while I was looking" })}`, at },
    { role: "assistant", text: CHECK_TEXT, at: at + 3_000 },
    { role: "user", text: ASK, at: asked.at },
    { role: "assistant", text: ANSWER_TEXT, at: asked.at + 2_000 },
  ];
  const moment = momentView({ entries, chat: CHAT }, { chat: CHAT, timeZone: "UTC", now: asked.at + 2_000, record, group: null });
  assert.equal(count(moment.history[0].text, CHECK_TEXT), 1, "momentView: once");
  // A logged turn answering their 10:30 text: the day holds both, the record repeats the check-in, and it is shown once.
  const logged = await loggedTurn({}, { chat: CHAT, covers: [asked.eid], question: ASK }, { ledger: Promise.resolve({ entries, chat: CHAT, ledger: { read: async () => ({ entries: [] }) } }), record: Promise.resolve(record), timeZone: "UTC" });
  assert.ok(logged, "the turn reads");
  assert.equal(count(logged.history.map((turn) => turn.text).join("\n"), CHECK_TEXT), 1, "loggedTurn: once, from the ledger, not again from the record");
  assert.equal(logged.question, ASK, "the question it answers is the question, not history");
  assert.equal(count(logged.history.map((turn) => turn.text).join("\n"), ASK), 0, "so the history leaves it out");
});

test("a check-in the ledger never kept shows from the person's record, once", () => {
  const { entries, asked, at } = chat({ withText: false, withNote: false });
  const record = [
    { role: "user", text: checkInAbout({ reason: "the ticket board changed while I was looking" }), at },
    { role: "assistant", text: CHECK_TEXT, at: at + 3_000 },
  ];
  const own = sentByItself(record, [...earlierFromLedger(entries, CHAT, { before: Number.MAX_SAFE_INTEGER, chars: Number.MAX_SAFE_INTEGER, fade: false }).events], { chat: CHAT, newest: asked.at });
  assert.equal(own.shown.filter((event) => event.text === CHECK_TEXT).length, 1, "the record's copy is added, once");
});

test("an old ledger with only the note (no Worker text) still shows the check-in once", () => {
  const { entries } = chat({ withText: false });
  const day = dayFromLedger(entries, CHAT, []);
  assert.equal(day.filter((event) => event.text === CHECK_TEXT).length, 0, "the day has no text event for it");
  const earlier = earlierFromLedger(entries, CHAT, { before: Number.MAX_SAFE_INTEGER, chars: Number.MAX_SAFE_INTEGER, fade: false });
  assert.equal(earlier.events.filter((event) => event.text === CHECK_TEXT).length, 1, "the note shows it, once");
});

test("a check-in whose send was not delivered shows nowhere", () => {
  const { entries, asked, at } = chat({ delivered: false });
  assert.equal(dayFromLedger(entries, CHAT, []).filter((event) => event.text === CHECK_TEXT).length, 0, "the day");
  assert.equal(earlierFromLedger(entries, CHAT, { before: Number.MAX_SAFE_INTEGER, chars: Number.MAX_SAFE_INTEGER, fade: false }).events.filter((event) => event.text === CHECK_TEXT).length, 0, "an earlier read");
  assert.equal(conversationFromLedger(entries).filter((turn) => turn.text === CHECK_TEXT).length, 0, "the conversation");
  assert.equal(stretchTurns(entries, [], { since: T, covered: new Set(), group: false }).filter((turn) => turn.text === CHECK_TEXT).length, 0, "the stretch");
  assert.equal(weekView({ entries, chat: CHAT, start: T - 86_400_000, chars: 1_000_000, days: 7 }).text.includes(CHECK_TEXT), false, "the week");
  assert.equal(saidTexts(entries).filter((entry) => entry.text === CHECK_TEXT).length, 0, "the Lab's rows");
  const record = [{ role: "user", text: checkInAbout({ reason: "x" }), at }, { role: "assistant", text: CHECK_TEXT, at: at + 3_000 }, { role: "user", text: ASK, at: asked.at }];
  assert.equal(sentByItself(record, notSaidOwn(entries), { chat: CHAT, newest: asked.at }).shown.length, 0, "the record's copy of an unsaid text is not shown");
  const moment = momentView({ entries, chat: CHAT }, { chat: CHAT, timeZone: "UTC", now: asked.at + 2_000, record, group: null });
  assert.equal(moment ? count(moment.history[0].text, CHECK_TEXT) : 0, 0, "momentView: nowhere");
});

test("a routine's note kept and not texted (send: note) is never shown as a sent text", () => {
  const at = T + 11 * MIN;
  const kept = wordsEntry("note", "Your brief: nothing new today.", { turn: "routineKept20260001", at, routine: "routines/daily/brief.md", send: "note" });
  const entries = [person(T, "morning"), kept];
  assert.equal(conversationFromLedger(entries).filter((turn) => turn.text === "Your brief: nothing new today.").length, 0, "the conversation");
  assert.equal(dayFromLedger(entries, CHAT, []).length, 1, "the day holds only the person's text");
  assert.equal(earlierFromLedger(entries, CHAT, { before: Number.MAX_SAFE_INTEGER, chars: Number.MAX_SAFE_INTEGER, fade: false }).events.filter((event) => event.text.includes("nothing new")).length, 0, "an earlier read");
  assert.equal(notSaidOwn(entries).length, 1, "and the record's copy of it is kept out");
});

test("a text Tex sent with a turn but no note (a reply's own text) is not taken as a linked send", () => {
  const at = T + 11 * MIN;
  const entries = [texFrom(at, "Just a reply.", { turn: REPLY_TURN, source: "reply" })];
  assert.deepEqual(linkedSends(entries).noted.size, 0);
  assert.equal(dayFromLedger(entries, CHAT, []).length, 1, "shown as before");
});

test("the Lab's rows hold the check-in's text once, and the Tex page's thread shows it once", () => {
  const { entries, asked } = chat();
  assert.equal(saidTexts(entries).filter((entry) => entry.text === CHECK_TEXT).length, 1, "one Lab row for the check-in");
  const thread = { id: "t1", texts: [entries[0].eid, asked.eid] };
  const lines = threadLines(thread, entries.filter((entry) => entry.kind === "text").sort((a, b) => a.at - b.at));
  assert.equal(lines.filter((line) => line.text === CHECK_TEXT).length <= 1, true, "the thread shows it at most once");
  assert.ok(ids(lines).length >= 1);
});

test("a logged turn leaves out an unsaid check-in, even though the record holds its exchange", async () => {
  const { entries, asked, at } = chat({ delivered: false });
  const record = [
    { role: "user", text: checkInAbout({ reason: "the ticket board changed while I was looking" }), at },
    { role: "assistant", text: CHECK_TEXT, at: at + 3_000 },
    { role: "user", text: ASK, at: asked.at },
    { role: "assistant", text: ANSWER_TEXT, at: asked.at + 2_000 },
  ];
  const logged = await loggedTurn({}, { chat: CHAT, covers: [asked.eid], question: ASK }, { ledger: Promise.resolve({ entries, chat: CHAT, ledger: { read: async () => ({ entries: [] }) } }), record: Promise.resolve(record), timeZone: "UTC" });
  assert.equal(count(logged.history.map((turn) => turn.text).join("\n"), CHECK_TEXT), 0, "not shown anywhere in the turn's history");
});
