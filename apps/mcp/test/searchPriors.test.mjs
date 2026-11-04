/**
 * The path prior (`src/search/priors.js`): archived and log material ranks
 * below a live note with the same evidence, meetings and ordinary notes do
 * not, a workspace prefix is read through, and a search-probe note is never
 * an answer.
 *
 * Production, 2026-11-03: "2027 plan objectives owners" put an archived chat
 * log first and the plan's own overview eleventh; "gym weights" showed
 * archived iMessage months and a search-probe note.
 *
 * Sabotage record (temporary local edits, reverted):
 *   archive folders not demoted              → "an archived note is demoted, whatever its name" fails
 *   the inbox communication list ignored     → "an inbox communication folder is a log" fails
 *   the `@name/` prefix not stripped         → "a workspace prefix is read through" fails
 *   meetings demoted with the logs           → "meetings are not logs" fails
 *   `isSearchProbe` always false             → "a search-probe note is never an answer" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { LOG_PRIOR, isSearchProbe, notePrior } from "../src/search/priors.js";
import { mergeHits } from "../src/search/meaning/serve.js";

test("archived material ranks below an ordinary note", () => {
  assert.equal(notePrior("archive/chat-history/2026-10.md"), LOG_PRIOR);
  assert.equal(notePrior("4-archive/old-plan.md"), LOG_PRIOR);
  assert.equal(notePrior("Archive/notes/x.md"), LOG_PRIOR);
  assert.equal(notePrior("projects/plan/overview.md"), 1);
  assert.ok(LOG_PRIOR < 1);
});

test("an archive-like name that is not the archive is an ordinary note", () => {
  assert.equal(notePrior("old-archive/x.md"), 1);
  assert.equal(notePrior("resources/archive-2024/x.md"), 1);
});

test("the inbox's communication folders are logs; the rest of the inbox is not", () => {
  for (const folder of ["sessions", "imessage", "email", "google-chat", "calendar"]) {
    assert.equal(notePrior(`inbox/${folder}/2026-10.md`), LOG_PRIOR, folder);
  }
  // Case-insensitive, and the inbox may carry its sort number.
  assert.equal(notePrior("0-Inbox/Email/2026-10.md"), LOG_PRIOR);
  // A note the person wrote in the inbox, or another inbox folder, is not a log.
  assert.equal(notePrior("inbox/bench/single-4.md"), 1);
  assert.equal(notePrior("inbox/contacts/alice.md"), 1);
  assert.equal(notePrior("inbox/notes.md"), 1);
});

test("Tex's log folders are logs; Tex's living notes are not", () => {
  for (const folder of ["heartbeat", "dreams", "housekeeping", "handbacks", "attention", "transcripts"]) {
    assert.equal(notePrior(`tex/${folder}/2026-10-30.md`), LOG_PRIOR, folder);
  }
  assert.equal(notePrior("tex/about-me.md"), 1);
  assert.equal(notePrior("tex/routines/morning.md"), 1);
});

test("meetings are not logs", () => {
  assert.equal(notePrior("inbox/meetings/2026-10-30 standup.md"), 1);
  assert.equal(notePrior("projects/meetings/kickoff.md"), 1);
});

test("a workspace prefix is read through before deciding", () => {
  assert.equal(notePrior("@wedding/archive/old.md"), LOG_PRIOR);
  assert.equal(notePrior("@wedding/inbox/email/x.md"), LOG_PRIOR);
  assert.equal(notePrior("@wedding/tex/heartbeat/x.md"), LOG_PRIOR);
  assert.equal(notePrior("@wedding/vendors/caterer.md"), 1);
  // A note's own name starting with @ does not make a prefix.
  assert.equal(notePrior("projects/@ideas/x.md"), 1);
});

/**
 * The prior is also in the single-workspace fusion (`mergeHits`), so an
 * archived note with the same words and meaning as a live one places below it.
 */
test("mergeHits: an archived note places below a live one with the same evidence", () => {
  const words = [{ key: "archive/old-plan.md" }, { key: "projects/plan.md" }];
  const meaning = [{ path: "projects/plan.md", score: 0.6 }, { path: "archive/old-plan.md", score: 0.6 }];
  assert.deepEqual(mergeHits(words, meaning).map((entry) => entry.key), ["projects/plan.md", "archive/old-plan.md"]);
});

test("mergeHits: the prior reorders and never drops; a log with no other match still shows", () => {
  assert.deepEqual(mergeHits([{ key: "archive/only.md" }], []).map((entry) => entry.key), ["archive/only.md"]);
});

test("a non-path is an ordinary note, never a throw", () => {
  assert.equal(notePrior(undefined), 1);
  assert.equal(notePrior(null), 1);
  assert.equal(notePrior(""), 1);
});

test("a search-probe note is never an answer, whatever its workspace", () => {
  assert.equal(isSearchProbe("search-probes/gym-weights.md"), true);
  assert.equal(isSearchProbe("@bench/search-probes/gym-weights.md"), true);
  assert.equal(isSearchProbe("inbox/search-probes/x.md"), true);
  assert.equal(isSearchProbe("projects/search-probes-notes.md"), false);
  assert.equal(isSearchProbe("projects/gym/weights.md"), false);
  assert.equal(isSearchProbe(undefined), false);
});
