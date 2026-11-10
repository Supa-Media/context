/**
 * THE REPLY-OR-QUIET CASES AND THEIR SCORING (`bench/respond.mjs`; Dev2 2026-11-10: the classifier says "no response").
 *
 * Sabotage record (2026-11-10), each applied, suite run, named test failing, reverted:
 *  1. `hushed` skipping `mayHush` → "code's floor is applied as in production".
 *  2. `passes` ignoring `MAX_DROPPED` → "a dropped ask is the tight bar".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { hushed, loadCases, MAX_DROPPED, MIN_HUSHED, passes, rates, respondCommand } from "../respond.mjs";

test("the cases have unique ids, both labels in both kinds of chat, and lines and words on each", async () => {
  const cases = await loadCases();
  const ids = new Set(cases.map((item) => item.id));
  assert.equal(ids.size, cases.length);
  for (const chat of ["group", "one"]) for (const want of ["hush", "reply"]) assert.ok(cases.filter((item) => item.chat === chat && item.want === want).length >= 5, `${chat} ${want}`);
  for (const item of cases) assert.ok(Array.isArray(item.lines) && typeof item.text === "string");
});

test("code's floor is applied as in production: a quiet verdict on a question to Tex is not a hush", () => {
  assert.equal(hushed({ chat: "one", lines: [], text: "is it at 5?" }, { respond: "quiet" }), false);
  assert.equal(hushed({ chat: "one", lines: ["You: Want it? 👍 or 👎"], text: "ok" }, { respond: "quiet" }), false);
  assert.equal(hushed({ chat: "one", lines: ["You: Done."], text: "ok" }, { respond: "react" }), true);
});

test("a dropped ask is the tight bar", () => {
  const row = (hushedRate, droppedRate) => ({ hushedRate, droppedRate });
  assert.equal(passes(row(MIN_HUSHED, MAX_DROPPED)), true);
  assert.equal(passes(row(1, MAX_DROPPED + 0.01)), false);
  assert.equal(passes(row(MIN_HUSHED - 0.01, 0)), false);
  assert.deepEqual(rates([{ want: "hush", hushed: true }, { want: "reply", hushed: true }]).dropped, 1);
});

test("the fake run passes and writes its report", async () => {
  const written = [];
  const all = await respondCommand({ fake: true }, { write: (text) => written.push(text) });
  assert.ok(passes(all));
  assert.match(written.join(""), /Reply or quiet ✅ passes/);
});
