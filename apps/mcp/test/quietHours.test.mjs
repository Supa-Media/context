/**
 * QUIET HOURS (`src/agent/quietHours.js`; Dev2, 2026-11-08): the words a
 * person or the Tex page writes as `quiet-hours:` in `tex/heartbeat.md`, and
 * whether a moment is inside them. Delivery is `attention.test.mjs`'s and the
 * look's `agentHeartbeat.test.mjs`'s.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { quietHoursLine, quietUntil, readQuietHours, readSettings } from "../src/agent/quietHours.js";

const at = (iso) => Date.parse(iso);

test("the ways people write a window are read; anything unsure is no window", () => {
  assert.deepEqual(readQuietHours("11 pm to 7 am"), { from: 23 * 60, until: 7 * 60 });
  assert.deepEqual(readQuietHours("22:00-07:30"), { from: 22 * 60, until: 7 * 60 + 30 });
  assert.deepEqual(readQuietHours("10pm–8am"), { from: 22 * 60, until: 8 * 60 });
  assert.deepEqual(readQuietHours("1 pm until 2 pm"), { from: 13 * 60, until: 14 * 60 });
  for (const unsure of ["", "night", "11 to 7", "25:00-07:00", "13 pm to 7 am", "7 am to 7 am", null, 5]) {
    assert.equal(readQuietHours(unsure), null, String(unsure));
  }
});

test("the line is read from the front matter only", () => {
  assert.equal(quietHoursLine("---\npaused: no\nquiet-hours: 11 pm to 7 am\n---\nBody"), "11 pm to 7 am");
  assert.equal(quietHoursLine("---\nquiet_hours: 22:00-07:00\n---\n"), "22:00-07:00");
  assert.equal(quietHoursLine("quiet-hours: 11 pm to 7 am\n"), null);
  assert.equal(quietHoursLine("---\npaused: no\n---\nquiet-hours: 11 pm to 7 am\n"), null);
});

test("a window past midnight holds the night and ends at its end, in their zone", () => {
  const night = readQuietHours("11 pm to 7 am");
  assert.equal(quietUntil(night, at("2026-11-09T02:15:30Z"), "UTC"), at("2026-11-09T07:00:00Z"));
  assert.equal(quietUntil(night, at("2026-11-08T23:00:00Z"), "UTC"), at("2026-11-09T07:00:00Z"));
  assert.equal(quietUntil(night, at("2026-11-09T07:00:00Z"), "UTC"), null, "its end is not inside it");
  assert.equal(quietUntil(night, at("2026-11-09T14:00:00Z"), "UTC"), null);
  // 3 am in New York is 08:00 UTC in November.
  assert.equal(quietUntil(night, at("2026-11-09T08:00:00Z"), "America/New_York"), at("2026-11-09T12:00:00Z"));
  assert.equal(quietUntil(null, Date.now(), "UTC"), null);
});

test("a window within a day holds only its hours", () => {
  const lunch = readQuietHours("12:00-13:00");
  assert.equal(quietUntil(lunch, at("2026-11-09T12:30:00Z"), "UTC"), at("2026-11-09T13:00:00Z"));
  assert.equal(quietUntil(lunch, at("2026-11-09T13:30:00Z"), "UTC"), null);
});

import { switchedOff } from "../src/agent/texSwitches.js";

test("an off switch is paused: yes in the front matter, and nothing else", () => {
  assert.equal(switchedOff("---\npaused: true\n---\n"), true);
  assert.equal(switchedOff("---\npaused: \"yes\"\n---\nWhy."), true);
  assert.equal(switchedOff("---\npaused: no\n---\n"), false);
  assert.equal(switchedOff("paused: true\n"), false, "not front matter");
  assert.equal(switchedOff("---\ntitle: x\n---\npaused: true\n"), false, "the body says nothing");
  assert.equal(switchedOff(""), false);
});

test("tex/heartbeat.md pauses check-ins in its front matter, and its body is their instructions", () => {
  const paused = readSettings("---\npaused: true\n---\nOnly deadlines, please.\n");
  const open = readSettings("Only text me about deadlines.");
  assert.deepEqual(paused, { paused: true, instructions: "Only deadlines, please." });
  assert.deepEqual(open, { paused: false, instructions: "Only text me about deadlines." });
  assert.equal(readSettings("---\npaused: no\n---\n").paused, false);
});
