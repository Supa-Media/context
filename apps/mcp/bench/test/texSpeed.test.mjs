// Tests for bench/texSpeed.mjs: the SQL names the right doubles and never the turn id, and the report reads the API's rows.
import { test } from "node:test";
import assert from "node:assert/strict";

import { query, report } from "../texSpeed.mjs";

test("the calls query reads ms, tokens and round from their doubles, and never blob4", () => {
  const first = query("calls", "tex_model_calls", 7, "first");
  assert.match(first, /double1 = 1/);
  assert.match(first, /quantileWeighted\(0\.5\)\(double2,/);
  assert.match(first, /SUM\(double4 \* _sample_interval\) AS cacheRead/);
  assert.doesNotMatch(first, /blob4/);
  assert.match(query("calls", "tex_model_calls", 7, "later"), /double1 > 1/);
  assert.match(query("turns", "tex_timing", 3), /quantileWeighted\(0\.5\)\(double14,/);
  assert.throws(() => query("calls", "tex_model_calls; DROP", 7), /dataset/);
  assert.throws(() => query("calls", "tex_model_calls", "7' DAY OR 1=1"), /days/);
  assert.throws(() => query("calls", "tex_model_calls", 7, "middle"), /first\|later/);
});

test("the report gives cache read share, first and later rounds and turn totals per day and kind", () => {
  const calls = [
    { day: "2026-11-10", kind: "group", round: "later", n: 4, input: 100, cacheRead: 300, cacheWrite: 0, p50: 2100.4, p95: 5000 },
    { day: "2026-11-10", kind: "group", round: "first", n: 2, input: 500, cacheRead: 0, cacheWrite: 500, p50: 3000, p95: 6000 },
    { day: "2026-11-10", kind: "one", round: "first", n: 0, input: 0, cacheRead: 0, cacheWrite: 0, p50: 0, p95: 0 },
  ];
  const text = report(calls, [{ day: "2026-11-10", kind: "one<script>", n: 3, p50: 8000, p95: 12000, rounds: 2.25 }]);
  const lines = text.split("\n");
  assert.equal(lines.find((l) => l.includes("| group | first |")), "| 2026-11-10 | group | first | 2 | 0% | 3000 | 6000 |");
  assert.equal(lines.find((l) => l.includes("| group | later |")), "| 2026-11-10 | group | later | 4 | 75% | 2100 | 5000 |");
  assert.ok(lines.find((l) => l.includes("| one | first |")).includes("| - |"), "no prompt, no share");
  assert.ok(lines.includes("| 2026-11-10 | onescript | 3 | 8000 | 12000 | 2.3 |"), "a kind is printed as a plain word");
  assert.ok(!report(calls).includes("### Turns"));
});
