/**
 * WHAT A CHECK-IN READS OF THE CHAT, AND WHAT THE CHAT KEEPS OF A CHECK-IN
 * (`src/agent/checkInTexts.js`; Dev2, 2026-11-10).
 *
 * 2026-11-09: a Monday 10 am look was shown Sunday's "the tournament is today" with no day, took it for a
 * mistake and texted "Correction to my last text" under it; asked why at 10:33, the chat had only the
 * check-in's words.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-10): `recentTexts` ignoring its zone
 * fails the first test; `heartbeatQuestion` without the day-words line fails it too; `recentTexts` comparing
 * the check-in line by equality fails the second.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CHECK_IN_QUESTION, checkInAbout, isCheckInLine, lastThinking, recentTextLines } from "../src/agent/checkInTexts.js";
import { heartbeatQuestion } from "../src/agent/heartbeat.js";

const SUNDAY = Date.UTC(2026, 10, 8, 17, 46); // Sun 12:46 pm New York
const MONDAY = Date.UTC(2026, 10, 9, 14, 25); // Mon 9:25 am

test("a look sees when each of the last texts was sent, in their time, and is told a text's today is its own day", () => {
  const dated = recentTextLines([
    { role: "user", text: "how many brackets for 13 players?", at: SUNDAY },
    { role: "assistant", text: "The tournament is today: with 13 players, want byes or a group stage?" },
    { role: "user", text: "remind me again at 3pm", at: MONDAY },
    { role: "assistant", text: "Will do. Reminder set for 3pm today." },
  ], "America/New_York");
  assert.equal(dated[0], "[1] Them (Sun 2026-11-08 12:46): how many brackets for 13 players?");
  assert.equal(dated[1], "[2] You (Sun 2026-11-08 12:46): The tournament is today: with 13 players, want byes or a group stage?");
  assert.equal(dated[3], "[4] You (Mon 2026-11-09 09:25): Will do. Reminder set for 3pm today.");
  const asked = heartbeatQuestion({ changed: [{ key: "todo.md", at: MONDAY - 60_000 }], now: MONDAY, texted: [], recent: dated });
  assert.ok(asked.includes("a text that was right on the day it was sent is never a mistake to correct"));
});

test("the chat keeps why a check-in texted, the text it went under and where its log is, and it still reads as a check-in", () => {
  const about = checkInAbout({
    continues: "The tournament is today: with 13 players, want byes or a group stage?",
    reason: "The FIFA project was archived,\n so the bracket question is moot.",
    log: "tex/heartbeat/2026-11-09.md",
  });
  assert.ok(isCheckInLine(about));
  assert.ok(about.includes('reply under your earlier text "The tournament is today'));
  assert.ok(about.includes('"The FIFA project was archived, so the bracket question is moot."'));
  assert.ok(about.includes("tex/heartbeat/2026-11-09.md"));
  const later = recentTextLines([{ role: "user", text: about, at: MONDAY }, { role: "assistant", text: "The bracket question is moot." }], "America/New_York");
  assert.equal(later.length, 1);
  assert.ok(later[0].startsWith("[1] You (a check-in) (Mon 2026-11-09 09:25)"));
  assert.equal(checkInAbout(), CHECK_IN_QUESTION);
  assert.ok(checkInAbout({ reason: "x".repeat(2_000) }).length < 1_000);
});

test("the reason is the look's last thinking before its answer", () => {
  assert.equal(lastThinking([{ kind: "thinking", text: "first" }, { kind: "tool", name: "read_note" }, { kind: "thinking", text: "last" }, { kind: "thinking", text: " " }]), "last");
  assert.equal(lastThinking([]), "");
});
