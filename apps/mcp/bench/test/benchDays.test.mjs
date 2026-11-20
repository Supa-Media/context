/**
 * The bench's day summaries: one `day` ledger entry for each day of an earlier chat older than the Front door's
 * word-for-word window, as production's nightly summary would leave it (`benchDays.mjs`).
 *
 * Sabotage: drop the `days` filter in `benchDaySummaries` and a day inside the window gets a summary; drop the clip and
 * a long day runs past 700 characters; drop the group naming and a group's lines read as "They".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { benchDaySummaries } from "../benchDays.mjs";
import { MAX_SUMMARY_CHARS } from "../../../../packages/tex/gateway/agent/daySummaries.js";

const at = (iso) => Date.parse(iso);
// Sunday 18 October 2026, noon UTC: a 7-day window starts at midnight on Monday 12 October.
const NOW = at("2026-10-18T12:00:00Z");
const base = { now: NOW, timeZone: "UTC", days: 7 };

test("one day entry per older day, none for a day inside the window", () => {
  const lines = [
    { at: at("2026-10-01T09:00:00Z"), from: "person", text: "book the dentist" },
    { at: at("2026-10-01T09:05:00Z"), from: "tex", text: "Booked Tuesday." },
    { at: at("2026-10-11T23:00:00Z"), from: "person", text: "the day before the window" },
    { at: at("2026-10-12T08:00:00Z"), from: "person", text: "inside the window" },
    { at: at("2026-10-17T08:00:00Z"), from: "tex", text: "inside too" },
  ];
  const entries = benchDaySummaries({ ...base, lines });
  assert.deepEqual(entries.map((e) => e.day), ["2026-10-01", "2026-10-11"]);
  const [first] = entries;
  assert.equal(first.id, "day-2026-10-01");
  assert.equal(first.kind, "day");
  assert.equal(first.v, 1);
  assert.equal(first.model, "bench");
  assert.equal(first.at, at("2026-10-01T09:05:00Z"), "a day's `at` is its last line's time");
  assert.equal(first.text, 'They texted: "book the dentist". You answered: "Booked Tuesday.".');
});

test("a day summary is at most the production cap, and keeps the newest lines when it must cut", () => {
  const lines = Array.from({ length: 40 }, (_, k) => ({ at: at("2026-10-02T08:00:00Z") + k * 60_000, from: k % 2 ? "tex" : "person", text: `line ${k} ${"x".repeat(60)}` }));
  const [entry] = benchDaySummaries({ ...base, lines });
  assert.ok(entry.text.length <= MAX_SUMMARY_CHARS, `${entry.text.length} characters`);
  assert.ok(entry.text.endsWith('"line 39 ' + "x".repeat(60) + '".'), "the newest line is kept");
  assert.ok(!entry.text.includes("line 0 "), "the oldest lines are the ones cut");
});

test("a group's lines name who said them, and Tex's answers are its own", () => {
  const lines = [
    { at: at("2026-10-03T10:00:00Z"), from: "person", who: "priya", text: "who has the van?" },
    { at: at("2026-10-03T10:01:00Z"), from: "tex", text: "Maya has it until Friday." },
  ];
  const [entry] = benchDaySummaries({ ...base, lines, group: true });
  assert.equal(entry.text, '@priya texted: "who has the van?". You answered: "Maya has it until Friday.".');
});

test("nothing older than the window, and no window at all, writes no day entries", () => {
  const lines = [{ at: at("2026-10-15T10:00:00Z"), from: "person", text: "recent" }];
  assert.deepEqual(benchDaySummaries({ ...base, lines }), []);
  assert.deepEqual(benchDaySummaries({ ...base, days: null, lines: [{ at: at("2026-09-01T10:00:00Z"), from: "person", text: "old" }] }), [], "every day is word for word when the window is the whole chat");
});

// A check-in, a routine or a job's report is a turn nobody texted, and Tex's answer to it is what a later turn reads of
// that day (the loose-ends routine's Chase and Glazeco answers, weeks back). Sabotage: drop the trigger push in
// `worldChat.mjs` `keepTriggerThen`, or the trigger sentence in `sentence()`, and the day loses them.
test("a trigger and Tex's answer to it are sentences of their day, in the order they came", () => {
  const lines = [
    { at: at("2026-10-01T09:00:00Z"), from: "trigger", via: "checkin", text: "Chase has not answered about the deposit" },
    { at: at("2026-10-01T09:00:00Z"), from: "tex", text: "Asked Chase again." },
    { at: at("2026-10-01T10:00:00Z"), from: "trigger", via: "routine", text: "Loose ends" },
    { at: at("2026-10-01T10:00:00Z"), from: "tex", text: "Nothing new." },
    { at: at("2026-10-01T11:00:00Z"), from: "trigger", via: "job", text: "Venues compared" },
  ];
  const [entry] = benchDaySummaries({ ...base, lines });
  assert.equal(
    entry.text,
    'A check-in found: "Chase has not answered about the deposit". You answered: "Asked Chase again.". A routine ran: "Loose ends". You answered: "Nothing new.". A job reported: "Venues compared".',
  );
});
