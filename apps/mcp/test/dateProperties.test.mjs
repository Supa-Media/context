/**
 * Date properties a note asked for (`notes/dateProperties.js`): `date created` and `date modified` and their usual
 * spellings, filled by Context itself (Dev2, 2026-11-10). Only keys the note already has; a filled `created` is never
 * overwritten; `modified` follows content saves only; the note's or the workspace's format is copied, else ISO 8601,
 * in the owner's zone.
 *
 * ## Sabotage record
 *
 * Counting a date-only change as content failed "a save that only moves date modified is not content". Filling a
 * `created` that already has a value failed "a filled date created is never overwritten" (and two more).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { contentChanged, dateKeysOf, formatDate, hasDateKeys, stampDates, styleOf } from "../src/notes/dateProperties.js";

const ZONE = "America/New_York";
// Monday, November 9th 2026, 9:34:00 pm in New York (02:34:00 UTC on the 10th).
const NOV9 = Date.UTC(2026, 10, 10, 2, 34, 0);
// Saturday, March 14th 2026, 10:05:09 am in New York (daylight time: -04:00).
const MAR14 = Date.UTC(2026, 2, 14, 14, 5, 9);

test("the Linter format is recognised and written the way Linter writes it", () => {
  assert.equal(styleOf("Monday, November 9th 2026, 9:34:00 pm")?.name, "linter");
  assert.equal(formatDate(NOV9, ZONE, styleOf("Monday, November 9th 2026, 9:34:00 pm")), "Monday, November 9th 2026, 9:34:00 pm");
  assert.equal(formatDate(MAR14, ZONE, styleOf("Sunday, March 1st 2026, 12:00:00 AM")), "Saturday, March 14th 2026, 10:05:09 AM");
  for (const [day, suffix] of [[1, "st"], [2, "nd"], [3, "rd"], [4, "th"], [11, "th"], [12, "th"], [13, "th"], [21, "st"], [22, "nd"], [23, "rd"], [31, "st"]]) {
    const at = Date.UTC(2026, 0, day, 17, 0, 0);
    assert.match(formatDate(at, ZONE, styleOf("Monday, November 9th 2026, 9:34:00 pm")), new RegExp(`January ${day}${suffix} 2026, 12:00:00 pm$`));
  }
});

test("ISO 8601 shapes are copied, always in the owner's zone, never UTC", () => {
  assert.equal(formatDate(NOV9, ZONE, null), "2026-11-09T21:34:00-05:00");
  assert.equal(formatDate(MAR14, ZONE, null), "2026-03-14T10:05:09-04:00");
  assert.equal(formatDate(NOV9, ZONE, styleOf("2026-01-02T03:04:05Z")), "2026-11-09T21:34:00-05:00");
  assert.equal(formatDate(NOV9, ZONE, styleOf("2026-01-02T03:04:05.123+01:00")), "2026-11-09T21:34:00.000-05:00");
  assert.equal(formatDate(NOV9, ZONE, styleOf("2026-01-02T03:04")), "2026-11-09T21:34");
  assert.equal(formatDate(NOV9, ZONE, styleOf("2026-01-02 03:04:05")), "2026-11-09 21:34:00");
  assert.equal(formatDate(NOV9, ZONE, styleOf("2026-01-02")), "2026-11-09");
  assert.equal(formatDate(NOV9, "Asia/Kolkata", null), "2026-11-10T08:04:00+05:30");
  assert.equal(styleOf("next tuesday"), null);
  assert.equal(styleOf(""), null);
});

test("every usual spelling is a date key, in any case; nothing else is", () => {
  const text = [
    "---",
    "date created:",
    "Date Modified:",
    "created:",
    "modified:",
    "updated:",
    "date_created:",
    "date_modified:",
    "created_at:",
    "updated_at:",
    "createdby:",
    "date:",
    "---",
    "",
  ].join("\n");
  const keys = dateKeysOf(text).map((key) => `${key.key}=${key.role}`);
  assert.deepEqual(keys, [
    "date created=created",
    "Date Modified=modified",
    "created=created",
    "modified=modified",
    "updated=modified",
    "date_created=created",
    "date_modified=modified",
    "created_at=created",
    "updated_at=modified",
  ]);
});

test("a note without the keys is left exactly as it is", () => {
  for (const text of ["# Plain\n\nno front matter\n", "---\ntitle: x\nstatus: open\n---\nbody\n", "---\ncreated: [a, b]\n---\n", "", "---\ndate created:\n"]) {
    assert.equal(stampDates(text, { previous: null, modifiedAt: NOV9, createdAt: NOV9, timeZone: ZONE }), text);
  }
  assert.equal(hasDateKeys("---\ntitle: x\n---\n"), false);
  assert.equal(hasDateKeys("---\nupdated: \n---\n"), true);
  // A key in the body, not the front matter, is not a date key.
  assert.equal(hasDateKeys("# Notes\n\ndate created:\n"), false);
});

test("empty keys are filled: created from its first save, modified from this save", () => {
  const text = "---\ntitle: Plan\ndate created:\ndate modified:\n---\n\nBody\n";
  const out = stampDates(text, { previous: null, modifiedAt: NOV9, createdAt: MAR14, timeZone: ZONE });
  assert.equal(out, "---\ntitle: Plan\ndate created: 2026-03-14T10:05:09-04:00\ndate modified: 2026-11-09T21:34:00-05:00\n---\n\nBody\n");
});

test("a filled date created is never overwritten, and modified follows a content save", () => {
  const previous = "---\ndate created: Monday, November 9th 2026, 9:34:00 pm\ndate modified: Monday, November 9th 2026, 9:34:00 pm\n---\n\nOld\n";
  const next = previous.replace("Old", "New");
  const later = NOV9 + 3_600_000;
  const out = stampDates(next, { previous, modifiedAt: later, createdAt: MAR14, timeZone: ZONE });
  assert.equal(out, "---\ndate created: Monday, November 9th 2026, 9:34:00 pm\ndate modified: Monday, November 9th 2026, 10:34:00 pm\n---\n\nNew\n");
});

test("a save that only moves date modified is not content, so nothing changes", () => {
  const previous = "---\ndate modified: 2026-11-09T21:34:00-05:00\n---\n\nSame\n";
  const next = "---\ndate modified: 2026-11-09T21:35:00-05:00\n---\n\nSame\n";
  assert.equal(contentChanged(previous, next), false);
  assert.equal(stampDates(next, { previous, modifiedAt: NOV9 + 600_000, createdAt: NOV9, timeZone: ZONE }), next);
  assert.equal(contentChanged(previous, previous.replace("Same", "Other")), true);
  assert.equal(contentChanged(null, next), true);
});

test("an empty key copies the note's own format first, then the workspace's", () => {
  const text = "---\ndate created: Monday, November 9th 2026, 9:34:00 pm\ndate modified:\n---\n";
  const out = stampDates(text, { previous: text, modifiedAt: NOV9 + 60_000, createdAt: MAR14, timeZone: ZONE, workspaceStyle: "date" });
  assert.equal(out, "---\ndate created: Monday, November 9th 2026, 9:34:00 pm\ndate modified: Monday, November 9th 2026, 9:35:00 pm\n---\n");
  const bare = "---\ncreated:\n---\n";
  assert.equal(stampDates(bare, { previous: null, modifiedAt: NOV9, createdAt: NOV9, timeZone: ZONE, workspaceStyle: "linter" }), "---\ncreated: Monday, November 9th 2026, 9:34:00 pm\n---\n");
  assert.equal(stampDates(bare, { previous: null, modifiedAt: NOV9, createdAt: NOV9, timeZone: ZONE, workspaceStyle: "nonsense" }), "---\ncreated: 2026-11-09T21:34:00-05:00\n---\n");
});

test("quotes, spacing, CRLF and a byte-order mark are kept", () => {
  const text = "\uFEFF---\r\nupdated_at: \"\"\r\ncreated:   ''\r\n---\r\nBody\r\n";
  const out = stampDates(text, { previous: null, modifiedAt: NOV9, createdAt: NOV9, timeZone: ZONE });
  assert.equal(out, "\uFEFF---\r\nupdated_at: \"2026-11-09T21:34:00-05:00\"\r\ncreated:   '2026-11-09T21:34:00-05:00'\r\n---\r\nBody\r\n");
});

test("a value that is not a date, a block list, or an unknown created time is left alone", () => {
  const text = "---\nmodified: by hand\ncreated:\n  - 2026-01-01\nupdated:\n---\nBody\n";
  const out = stampDates(text, { previous: "---\nmodified: by hand\n---\nOld\n", modifiedAt: NOV9, createdAt: null, timeZone: ZONE });
  assert.equal(out, "---\nmodified: by hand\ncreated:\n  - 2026-01-01\nupdated: 2026-11-09T21:34:00-05:00\n---\nBody\n");
  const unknownCreated = "---\ndate created:\n---\n";
  assert.equal(stampDates(unknownCreated, { previous: null, modifiedAt: NOV9, createdAt: null, timeZone: ZONE }), unknownCreated);
});

test("an unknown zone falls back to the routines' default, never UTC", () => {
  assert.equal(formatDate(NOV9, "Not/AZone", null), "2026-11-09T21:34:00-05:00");
  assert.equal(formatDate(NOV9, null, null), "2026-11-09T21:34:00-05:00");
});

test("an encrypted note is never touched", () => {
  const sealed = "---\ncontext_encryption: v1\ndate modified:\n---\nCIPHERTEXT\n";
  assert.equal(stampDates(sealed, { previous: null, modifiedAt: NOV9, createdAt: NOV9, timeZone: ZONE }), sealed);
});
