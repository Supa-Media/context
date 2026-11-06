/**
 * EACH FINISHED DAY SUMMED UP INTO THE CHAT'S LEDGER, AND SHOWN PAST WHAT A TURN READS (`src/agent/daySummaries.js`,
 * `ledgerHistory.js`; Dev2, 2026-11-06: a daily summary inside the chat's history).
 *
 * The night after, a day with a text from them and no summary gets one `day` entry; a turn whose chat runs past what
 * it reads is shown the summaries of the days before every text it holds, and never one of a day it shows.
 *
 * Sabotage record (local edits, reverted): dropping the `kinds: ["day"]` read from `readLedger` fails "a long chat
 * reads the summaries past its pages"; dropping `summaryLines` from `loggedTurn.js` fails "a 1:1 turn opens its
 * history with the summaries".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_DAYS_PER_NIGHT, finishedDays, readSummary, writeDaySummaries } from "../src/agent/daySummaries.js";
import { earlierFromLedger, readLedger, summaryLines } from "../src/agent/ledgerHistory.js";
import { eventEntry } from "../src/agent/ledger.js";
import { texLedger } from "../src/texStore/ledger.js";
import { durableSql } from "./texStoreFixture.mjs";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 15);
let n = 0;
const said = (at, who, text) => {
  n += 1;
  return eventEntry({ id: `${at}-${String(n).padStart(6, "0")}`, at, chat: "texts", from: who === "tex" ? { kind: "tex" } : { kind: "person", name: "maya" }, kind: "text", text, ...(who === "tex" ? { delivered: true } : {}) });
};
const summary = (day, at, text) => ({ v: 1, id: `day-${day}`, at, kind: "day", day, text });
const session = { workspaceKind: "personal", workspaceId: "ws_maya" };

test("a summary is one paragraph, cut; the finished days are never today nor the first day read", () => {
  assert.equal(readSummary("  They asked\n\nyou things. "), "They asked you things.");
  assert.equal(readSummary(""), null);
  assert.equal(readSummary("x".repeat(2_000)).length, 700);
  const entries = [
    said(NOW - 4 * DAY, "them", "part of a day"),
    said(NOW - 3 * DAY, "them", "book the dentist"),
    said(NOW - 3 * DAY + 1000, "tex", "Booked."),
    said(NOW - 2 * DAY, "tex", "a check-in nobody answered"),
    said(NOW - 1000, "them", "today"),
  ];
  const days = finishedDays(entries, { now: NOW, timeZone: "UTC" });
  assert.deepEqual(days.map((day) => day.day), ["2026-11-03"]);
  assert.equal(days[0].at, NOW - 3 * DAY + 1000, "a summary is placed at its day's last entry");
});

test("the night after, each finished day with no summary gets one, and a kept one is never redone", async () => {
  const ledger = texLedger(durableSql());
  ledger.append("texts", [
    said(NOW - 6 * DAY, "them", "start of the read"),
    said(NOW - 5 * DAY, "them", "DAY-A plan the trip"),
    said(NOW - 4 * DAY, "them", "DAY-B find a dentist"),
    said(NOW - 3 * DAY, "them", "DAY-C"),
    said(NOW - 1000, "them", "today"),
    summary("2026-11-02", NOW - 4 * DAY, "already summed up"),
  ]);
  const asked = [];
  const request = async (call) => {
    asked.push(call.messages[0].text);
    return { text: `Summary of ${call.messages[0].text.match(/DAY-[A-C]/)[0]}.` };
  };
  const lines = [];
  const store = { texLedger: () => ledger };
  const done = await writeDaySummaries({ store, session, now: NOW, timeZone: "UTC", config: {}, request, metadata: { workspace: "ws_maya" }, log: (line) => lines.push(line) });
  assert.deepEqual(done, { written: 2, missing: 2 });
  assert.equal(asked.length, 2);
  assert.ok(asked.every((text) => !/today|start of the read/.test(text)), "neither today nor the part-day the read began in");
  const kept = ledger.read("texts", { kinds: ["day"] }).entries;
  assert.deepEqual(kept.map((entry) => [entry.id, entry.text]).sort(), [["day-2026-11-01", "Summary of DAY-A."], ["day-2026-11-02", "already summed up"], ["day-2026-11-03", "Summary of DAY-C."]]);
  assert.doesNotMatch(lines.join("\n"), /Summary of/, "the log counts, never words");

  const again = await writeDaySummaries({ store, session, now: NOW, timeZone: "UTC", config: {}, request, log: () => {} });
  assert.deepEqual(again, { written: 0, missing: 0 });
  assert.equal(await writeDaySummaries({ store, session: { workspaceKind: "shared", workspaceId: "ws" }, now: NOW, timeZone: "UTC", config: {}, request }), null, "only a person's own chat");
  assert.ok(MAX_DAYS_PER_NIGHT >= 1);
});

test("a turn is shown the summaries of days before every text it shows, never of one it shows", () => {
  const newestFirst = [
    said(NOW - 2 * DAY, "them", "shown text"),
    summary("2026-11-04", NOW - 2 * DAY + 5, "SHOWN-DAY summary"),
    summary("2026-11-01", NOW - 5 * DAY, "OLD-DAY summary"),
    summary("2026-10-31", NOW - 6 * DAY, "OLDER-DAY summary"),
  ];
  const { events, summaries } = earlierFromLedger(newestFirst, "texts", { before: NOW, fade: true, fadeFrom: NOW });
  assert.equal(events.length, 1);
  assert.deepEqual(summaries.map((s) => s.day), ["2026-10-31", "2026-11-01"], "oldest first, the shown day left out");
  assert.match(summaryLines(summaries), /^Earlier days[^\n]*\n- 2026-10-31: OLDER-DAY summary\n- 2026-11-01: OLD-DAY summary$/);
  assert.deepEqual(earlierFromLedger(newestFirst, "texts", { before: NOW }).summaries, [], "the History page shows texts, not summaries");
  assert.equal(summaryLines([]), "");
});

test("a long chat reads the summaries past its pages; a short one makes no extra read", async () => {
  const calls = [];
  const long = {
    read: async (_chat, options) => {
      calls.push(options.kinds);
      if (options.kinds.length === 1) return { entries: [summary("2026-09-01", NOW - 60 * DAY, "way back")] };
      return { entries: [said(NOW - DAY, "them", "x".repeat(200))], before: 7 };
    },
  };
  const entries = await readLedger(long, "texts", { chars: 100 });
  assert.deepEqual(calls.at(-1), ["day"]);
  assert.ok(entries.some((entry) => entry.kind === "day"));
  calls.length = 0;
  await readLedger({ read: async (_chat, options) => (calls.push(options.kinds), { entries: [] }) }, "texts");
  assert.equal(calls.length, 1, "a chat read to its start reads no summaries apart");
});

test("a 1:1 turn opens its history with the summaries of days it no longer shows", async () => {
  const { loggedTurn } = await import("../src/agent/loggedTurn.js");
  const ledger = texLedger(durableSql());
  const ask = `${NOW}-000990`;
  ledger.append("texts", [
    summary("2026-10-20", NOW - 17 * DAY, "You booked their flight to Lisbon for Nov 20."),
    said(NOW - 5000, "tex", "Morning."),
    eventEntry({ id: ask, at: NOW, chat: "texts", from: { kind: "person", name: "maya" }, kind: "text", text: "when do I fly?" }),
  ]);
  const read = { entries: ledger.read("texts", { before: Number.MAX_SAFE_INTEGER }).entries, chat: "texts" };
  const turn = await loggedTurn({}, { chat: "texts", covers: [ask] }, { ledger: Promise.resolve(read) });
  assert.match(turn.history[0].text, /Earlier days[^\n]*\n- 2026-10-20: You booked their flight to Lisbon for Nov 20\.\n\n[\s\S]*Morning\./);
});
