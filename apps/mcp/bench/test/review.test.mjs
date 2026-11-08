/**
 * THE REPLY REVIEWER'S LABELLED CASES AND THEIR SCORING (`bench/review.mjs`;
 * Dev2 2026-11-06: one Haiku reviewer in place of the ten gates).
 *
 * Sabotage record (2026-11-06), each applied, suite run, named test failing, reverted:
 *  1. `rates` counting a no-verdict as a send-back → "no verdict lets a reply go…".
 *  2. `passes` ignoring `MAX_FALSE_ALARMS` → "the bar is one budget for the whole reviewer".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { caseTurn, loadSets, MAX_FALSE_ALARMS, MIN_CATCH, passes, rates, reviewCommand, scoreCases } from "../review.mjs";

test("every set has faults and good replies with unique ids, and chat holds the roasts that must go", async () => {
  const sets = await loadSets();
  assert.ok(Object.keys(sets).length >= 13);
  const ids = new Set();
  for (const [name, cases] of Object.entries(sets)) {
    const faults = cases.filter((item) => item.fault).length;
    assert.ok(faults >= 3 && cases.length - faults >= 4, `${name} has both kinds`);
    for (const item of cases) {
      assert.ok(!ids.has(item.id), `${item.id} is unique`);
      ids.add(item.id);
      assert.equal(typeof item.q, "string");
      assert.equal(typeof item.reply, "string");
      assert.equal(typeof item.fault, "boolean");
    }
  }
  assert.ok(sets.chat.some((item) => item.id === "chat/roast-bullets" && item.fault === false));
});

test("a case reads as production's packet", () => {
  const state = caseTurn({ q: "where's the logo?", earlier: [["person", "hi"]], did: [["search_notes", { query: "logo" }, "No notes matched."], ["open_page", { url: "https://x.example" }, "timed out", "failed"]], reply: "Not found." });
  assert.ok(state.includes("Their text now: where's the logo?"));
  assert.ok(state.includes("The reply about to be sent: Not found."));
  assert.ok(state.includes('- called search_notes {"query":"logo"}'));
  assert.ok(state.includes("  failed: timed out"));
  assert.ok(state.includes("Person: hi"));
});

test("no verdict lets a reply go: it is never counted as a catch", async () => {
  const scored = await scoreCases([{ id: "a", fault: true, q: "q", reply: "r" }, { id: "b", fault: false, q: "q", reply: "r" }], async () => null);
  assert.deepEqual(rates(scored), { caught: 0, faults: 1, alarms: 0, good: 1, catch: 0, falseAlarms: 0 });
});

test("the bar is one budget for the whole reviewer", () => {
  assert.equal(passes({ catch: MIN_CATCH, falseAlarms: MAX_FALSE_ALARMS }), true);
  assert.equal(passes({ catch: 1, falseAlarms: MAX_FALSE_ALARMS + 0.01 }), false);
  assert.equal(passes({ catch: MIN_CATCH - 0.01, falseAlarms: 0 }), false);
});

test("a fake run scores every case and passes", async () => {
  const written = [];
  const all = await reviewCommand({ fake: true }, { write: (text) => written.push(text) });
  assert.equal(all.catch, 1);
  assert.equal(all.falseAlarms, 0);
  assert.match(written.join(""), /Reply reviewer ✅ passes/);
});
