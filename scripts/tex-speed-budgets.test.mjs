import assert from "node:assert/strict";
import { test } from "node:test";
import { judge, LIMITS, query, report } from "./tex-speed-budgets.mjs";

const limits = {
  paths: { "1:1": { p50Ms: 17500, p95Ms: 28000 }, group: { p50Ms: 18500, p95Ms: 45000 } },
  targets: { "1:1": { p50Ms: 5000, p95Ms: 10000 }, group: { p50Ms: 5000, p95Ms: 10000 } },
};

test("a wait over its bar is a regression, even when it is also short of target", () => {
  const [one] = judge([{ kind: "one", n: "30", p50: 19000, p95: 20000 }], limits);
  assert.equal(one.verdict, "regressed");
  assert.ok(one.misses.some((miss) => miss.includes("over its bar")));
});

test("a p95 over its bar alone is a regression", () => {
  const [, group] = judge([{ kind: "group", n: 50, p50: 4000, p95: 46000 }], limits);
  assert.equal(group.verdict, "regressed");
});

test("under the bars but over the target is red as work still to do, not a regression", () => {
  const [one] = judge([{ kind: "one", n: 30, p50: 14000, p95: 22000 }], limits);
  assert.equal(one.verdict, "short of target");
});

test("at target is ok, and a quiet window is shown, not judged", () => {
  const verdicts = judge([{ kind: "one", n: 30, p50: 4000, p95: 9000 }, { kind: "group", n: 3, p50: 60000, p95: 90000 }], limits);
  assert.deepEqual(verdicts.map((v) => v.verdict), ["ok", "too few"]);
});

test("a kind with no rows is too few, never ok by absence", () => {
  assert.deepEqual(judge([], limits).map((v) => v.verdict), ["too few", "too few"]);
});

test("the report names the bars, the targets and every miss", () => {
  const out = report(judge([{ kind: "group", n: 50, p50: 20000, p95: 30000 }], limits), "24 h");
  assert.match(out, /\| group \| 20\.0 s \| 30\.0 s \| 18\.5 s \/ 45\.0 s \| 5\.0 s \/ 10\.0 s \| 50 \| ❌ slower than its bar \|/);
  assert.match(out, /group: median 20\.0 s is over its bar/);
});

test("the shipped limits budget both kinds, each bar at or above its target", () => {
  assert.deepEqual(Object.keys(LIMITS.paths).sort(), ["1:1", "group"]);
  for (const [name, bar] of Object.entries(LIMITS.paths)) {
    assert.ok(bar.p50Ms >= LIMITS.targets[name].p50Ms && bar.p95Ms >= LIMITS.targets[name].p95Ms, name);
  }
});

test("the query takes only a safe dataset name and window", () => {
  assert.match(query("tex_text_timing", 1440), /FROM tex_text_timing/);
  assert.throws(() => query("tex; DROP", 60));
  assert.throws(() => query("tex_text_timing", 2));
});
