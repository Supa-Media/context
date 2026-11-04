import test from "node:test";
import assert from "node:assert/strict";

import { BUDGETS, MIN_SAMPLES, judge, query, report } from "./mcp-speed-budgets.mjs";

const row = (call, n, p50, p95 = p50 * 2) => ({ call, n, p50_ms: p50, p95_ms: p95 });

test("a call over its bar is over, one under is ok, and the bar itself is ok", () => {
  const verdicts = judge([row("a", 50, 151), row("b", 50, 99), row("c", 50, 100)], { a: 150, b: 100, c: 100 });
  assert.deepEqual(verdicts.map((v) => v.verdict), ["over", "ok", "ok"]);
});

test("too few requests is shown, not judged, and a call with none is too few", () => {
  const verdicts = judge([row("a", MIN_SAMPLES - 1, 9_999)], { a: 100, b: 100 });
  assert.deepEqual(verdicts.map((v) => [v.verdict, v.p50]), [["too few", 9_999], ["too few", null]]);
});

test("the default bars cover reads, saves, archive, folder moves, search and orient", () => {
  for (const call of ["tools/call:fetch", "tools/call:write", "tools/call:manage:archive", "tools/call:manage:move_folder", "tools/call:search", "tools/call:orient"]) {
    assert.ok(Number.isInteger(BUDGETS[call]) && BUDGETS[call] > 0, call);
  }
});

test("the query asks only for whole successful requests of the budgeted calls, and refuses odd input", () => {
  const sql = query("mcp_entry", 60);
  assert.match(sql, /blob3 = 'to_response'/);
  assert.match(sql, /blob4 = 'ok'/);
  assert.match(sql, /'tools\/call:manage:archive'/);
  assert.match(sql, /INTERVAL '60' MINUTE/);
  assert.throws(() => query("mcp_entry; DROP", 60));
  assert.throws(() => query("mcp_entry", 2));
  assert.throws(() => query("mcp_entry", 60, ["tools/call:x' OR 1=1"]));
});

test("the report names every call and marks the one over", () => {
  const text = report(judge([row("tools/call:fetch", 40, 500)]), "60 min");
  assert.match(text, /tools\/call:fetch \| 150 \| 500 .*❌ over/);
  assert.match(text, /tools\/call:orient .*too few/);
});
