/**
 * A text still in the Worker's outbox does not cost the turn its day (`loggedTurn.js` `day`; 2026-11-15).
 *
 * The Worker posts a text to the ledger (`/agent/events`) and hands its outbox to the turn beside it (`recent`,
 * `warmCopy.js` `mergeEvents`). A turn whose ledger did not yet hold the covered text was given no day at all, only the
 * outbox, so a quick second text was shown a different chat from the text before: in production 12 of a day's 48
 * one-to-one turns, and their transcripts flipped 523, 476, 523 lines from text to text, each writing the history to
 * the cache again.
 *
 * Sabotage (a temporary local edit, reverted): `day` calling `dayFromLedger(read?.entries, body.chat, covers)` again
 * fails "the same chat either way".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { texLedger } from "../../../packages/tex/gateway/texStore/ledger.js";
import { eventEntry, wordsEntry } from "../src/agent/ledger.js";
import { readLedger } from "../src/agent/ledgerHistory.js";
import { loggedTurn } from "../src/agent/loggedTurn.js";
import { durableSql } from "./texStoreFixture.mjs";

const NOW = Date.UTC(2026, 10, 15, 0, 40, 0);
const id = (at, n) => `${at}-${String(n).padStart(6, "0")}`;
const person = (at, n, text) => ({ id: id(at, n), at, chat: "c", from: { kind: "person", name: "ada" }, kind: "text", text });
const tex = (at, n, text, covers) => ({ id: id(at, n), at, chat: "c", from: { kind: "tex" }, kind: "text", text, turn: `turn${n}abcd`, covers, delivered: true });

function chat() {
  const ledger = texLedger(durableSql());
  let n = 0;
  for (let hour = 30; hour >= 1; hour -= 1) {
    const asked = person(NOW - hour * 3_600_000, (n += 1), `question ${hour}`);
    ledger.append("texts", [eventEntry(asked), eventEntry(tex(asked.at + 5_000, (n += 1), `answer ${hour}`, [asked.id]))]);
  }
  ledger.append("texts", [wordsEntry("note", "Morning check-in.", { at: NOW - 20 * 3_600_000, about: "(Not a text from them. Your routine ran.)" })]);
  return { ledger, next: () => (n += 1) };
}

async function shown(ledger, posted, { inLedger }) {
  if (inLedger) ledger.append("texts", [eventEntry(posted)]);
  const read = readLedger({ read: async (name, options) => ledger.read(name, options) }, "texts").then((entries) => ({ entries, chat: "texts" }));
  // The outbox on top of the ledger's day, as `warmCopy.js` hands it.
  const warm = { events: async (_chat, day) => { const events = await day(); return events.some((event) => event.id === posted.id) ? events : [...events, posted]; } };
  const logged = await loggedTurn({}, { covers: [posted.id], chat: "c" }, { warm, timeZone: "America/New_York", ledger: read, record: Promise.resolve([]) });
  return logged.history.map((message) => message.text).join("\n");
}

test("the same chat either way: a covered text only in the outbox, or already in the ledger", async () => {
  const outbox = chat();
  const posted = person(NOW, outbox.next(), "and one more thing");
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  let before, after;
  try {
    before = await shown(outbox.ledger, posted, { inLedger: false });
    const held = chat();
    held.next();
    after = await shown(held.ledger, posted, { inLedger: true });
  } finally {
    console.log = log;
  }
  assert.match(before, /answer 2\b/, "the day is shown though the ledger had not taken the text yet");
  assert.equal(before, after, "the same chat either way");
  assert.ok(!lines.some((line) => line.includes("tex_turn_day_missed")), "and it is no miss");
});
