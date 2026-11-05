/**
 * THE REPLY GATES' LABELLED SETS AND THEIR SCORING (`bench/gates.mjs`, Dev2
 * 2026-11-05: "make sure each of these judges are also well tuned").
 *
 * Sabotage record (2026-11-05), each applied, suite run, named test failing, reverted:
 *  1. `casesFor` dropping the other gates' good replies → "a gate is also scored on every other gate's good replies".
 *  2. `tune` ignoring `MAX_FALSE_ALARMS` → "tuning never buys catches with false alarms over the cap".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { casesFor, caseTurn, loadSets, MAX_FALSE_ALARMS, rates, tune } from "../gates.mjs";
import { GATES } from "../../src/agent/replyGates.js";

test("every gate has a labelled set with faults and good replies, and no case is one of the gate's own examples", async () => {
  const sets = await loadSets();
  assert.deepEqual(Object.keys(sets).sort(), Object.keys(GATES).sort());
  for (const [gate, cases] of Object.entries(sets)) {
    assert.ok(cases.length >= 10, `${gate} has at least ten cases`);
    const faults = cases.filter((item) => item.fault).length;
    assert.ok(faults >= 4 && cases.length - faults >= 4, `${gate} has both kinds`);
    assert.equal(new Set(cases.map((item) => item.id)).size, cases.length, `${gate} ids are unique`);
    for (const item of cases) {
      assert.equal(typeof item.q, "string");
      assert.equal(typeof item.reply, "string");
      assert.equal(typeof item.fault, "boolean");
      assert.ok(!GATES[gate].ask.includes(item.reply), `${gate}/${item.id} is scored, so it is never shown as an example`);
    }
  }
});

test("a case reads as production's packet", () => {
  const state = caseTurn({ q: "where's the logo?", earlier: [["person", "hi"]], did: [["search_notes", { query: "logo" }, "No notes matched."], ["open_page", { url: "https://x.example" }, "timed out", "failed"]], reply: "Not found." });
  assert.ok(state.includes("Their text now: where's the logo?"));
  assert.ok(state.includes("The reply about to be sent: Not found."));
  assert.ok(state.includes('- called search_notes {"query":"logo"}'));
  assert.ok(state.includes("  failed: timed out"));
  assert.ok(state.includes("Person: hi"));
});

test("a gate is also scored on every other gate's good replies", async () => {
  const sets = await loadSets();
  const cases = casesFor("sourced", sets);
  const cross = cases.filter((item) => item.cross);
  assert.ok(cross.length > 0 && cross.every((item) => !item.fault));
  assert.ok(cross.some((item) => item.id.startsWith("does_it/")));
  assert.ok(!cross.some((item) => item.id.startsWith("sourced/")));
});

test("tuning never buys catches with false alarms over the cap", () => {
  const scored = [
    { fault: true, yes: 0.9 },
    { fault: true, yes: 0.3 },
    ...Array.from({ length: 10 }, (_, i) => ({ fault: false, yes: i < 3 ? 0.35 : 0.05 })),
  ];
  const { best, passes } = tune(scored);
  assert.ok(best.falseAlarms <= MAX_FALSE_ALARMS);
  assert.ok(best.at > 0.35 && best.at <= 0.9);
  assert.equal(best.caught, 1);
  assert.equal(passes, false, "half the faults is below the bar");
  assert.deepEqual(rates([{ fault: true, yes: null }], 0.5).faults, 0, "an unanswered case counts for neither side");
});
