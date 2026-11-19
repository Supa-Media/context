/**
 * The router's margin and cutoff sweep (`bench/routeMargins.mjs`): hand-made router rows, so each count is checked by hand.
 *
 * Sabotage record: `scored` keeping `ran: false` rows -> the "not run is not scored" case fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cutSweep, marginSweep, sweepLines } from "../routeMargins.mjs";

const row = (chat, at, want, pick, sure, probs, ran = true) => ({ chat, at, want, ran, route: { pick, sure, probs } });
const rows = [
  row("a", 0, "read", "read", 0.8, { quick: 0.1, read: 0.8, act: 0.05, job: 0.05 }),
  row("a", 1, "quick", "read", 0.7, { quick: 0.35, read: 0.4, act: 0.15, job: 0.1 }),
  row("b", 0, "act", "act", 0.5, { quick: 0.2, read: 0.2, act: 0.5, job: 0.1 }),
  row("b", 1, "job", "quick", 0.9, { quick: 0.4, read: 0.4, act: 0.1, job: 0.1 }),
  row("b", 2, "read", null, null, null),
  row("c", 0, "read", "read", 0.9, { quick: 0.1, read: 0.9 }, false),
  { chat: "c", at: 1, route: { pick: "read", sure: 0.9, probs: null } },
];

test("the cutoff sweep counts the rows a flat cutoff routes, and how many of them were right", () => {
  const points = cutSweep(rows, [0.6, 0.4]);
  assert.deepEqual(points[0], { cut: 0.6, total: 5, routed: 3, right: 1, coverage: 0.6, accuracy: 1 / 3 }, "0.8, 0.7 and 0.9 route; the 0.5 row and the null do not");
  assert.deepEqual(points[1], { cut: 0.4, total: 5, routed: 4, right: 2, coverage: 0.8, accuracy: 0.5 });
});

test("the margin sweep at margin 0.15 routes the clear gaps only, and a tie never routes", () => {
  const point = marginSweep(rows, { margins: [0.15], floors: [0] })[0];
  // 0.8 leads by 0.7 (right); 0.4 vs 0.35 leads by 0.05 (no); 0.5 leads by 0.3 (right); tie (no); null (no).
  assert.deepEqual(point, { margin: 0.15, floor: 0, total: 5, routed: 2, right: 2, coverage: 0.4, accuracy: 1 });
});

test("a floor takes out the low picks, and a point with nothing routed has no accuracy", () => {
  assert.equal(marginSweep(rows, { margins: [0.15], floors: [0.6] })[0].routed, 1, "only the 0.8 pick is 0.6 likely");
  // The best gap is 0.7 (the 0.8 row), so a margin of 0.75 routes nothing.
  const none = marginSweep(rows, { margins: [0.75], floors: [0] })[0];
  assert.deepEqual(none, { margin: 0.75, floor: 0, total: 5, routed: 0, right: 0, coverage: 0, accuracy: null });
});

test("the sweep lines: a line a row, then each cutoff, then each margin point", () => {
  const lines = sweepLines(rows);
  assert.equal(lines[0], "route row a#0 want=read pick=read sure=0.800 probs=quick:0.100,read:0.800,act:0.050,job:0.050");
  assert.equal(lines[4], "route row b#2 want=read pick=none sure=- probs=-", "a row with no route reads none");
  assert.equal(lines[5], "route cut 0.40: routed 4/5 (80.0%), right 2/4 (50.0%)");
  assert.equal(lines[6], "route cut 0.50: routed 4/5 (80.0%), right 2/4 (50.0%)");
  assert.equal(lines[7], "route cut 0.60: routed 3/5 (60.0%), right 1/3 (33.3%)");
  assert.ok(lines.some((line) => /^route margin 0\.15 floor 0\.00: routed 2\/5 \(40\.0%\), right 2\/2 \(100\.0%\)$/.test(line)));
  assert.ok(lines.every((line) => !line.includes("c#")), "a row that did not run is not written");
});
