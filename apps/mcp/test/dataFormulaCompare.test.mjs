/**
 * Metric formulas: p90 and comparisons in a where (2026-11-26), split from `dataFormula.test.mjs`, which is at
 * its size limit. Open to live's headline is p90 and leaves out forgotten pull requests over a day:
 * `p90(github/pull-requests.deployed - opened where deployed - opened < 1440)`.
 *
 * Sabotage record (temporary local edits, reverted; the named case failed each time):
 * 1. `compares` answering true for every row: "a where can compare a per-row expression ..." fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFormula } from "../src/data/formula/parse.js";
import { formulaRefs } from "../src/data/formula/refs.js";
import { evaluate } from "../src/data/formula/evaluate.js";
import { plainReading, toText } from "../src/data/formula/render.js";
import { parseSheet } from "../src/sheets/csv.js";

const ok = (text) => {
  const r = parseFormula(text);
  assert.equal(r.ok, true, `${text}: ${r.error?.message}`);
  return r.ast;
};
const bad = (text, pattern) => {
  const r = parseFormula(text);
  assert.equal(r.ok, false, `${text} should be refused`);
  assert.match(r.error.message, pattern);
};
const roundTrips = (text) => {
  const ast = ok(text);
  assert.deepEqual(ok(toText(ast)), ast, `${text} → ${toText(ast)}`);
};

const PRS = parseSheet([
  "opened:date,merged:date,deployed:date,lines added:number,removed:number,author",
  "2026-11-23T09:00Z,2026-11-23T09:30Z,2026-11-23T09:40Z,100,20,ana",
  "2026-11-24T10:00Z,2026-11-24T10:10Z,2026-11-24T10:22Z,300,50,bo",
  "2026-11-25T08:00Z,,2026-11-25T08:30Z,10,,ana",
  "2026-11-16T08:00Z,2026-11-16T09:00Z,2026-11-16T11:00Z,5000,0,cy",
  "",
].join("\n"));
const NOW = Date.parse("2026-11-25T12:00:00Z");
const rowsOfPrs = (source, dataset) => (`${source}/${dataset}` === "github/pull-requests" ? PRS : null);
const ctx = (every, extra = {}) => ({ rowsOf: rowsOfPrs, every, now: NOW, ...extra });
const value = (text, every) => evaluate(ok(text), ctx(every));

test("p90 is the nearest-rank 90th percentile: the slowest tenth's floor, below p95 and above the median", () => {
  // Open to live's headline (2026-11-26): 40, 22 and 30 minutes this week, so the slowest of three.
  assert.deepEqual(value("p90(github/pull-requests.deployed − opened)", "7 days"), { value: 40, status: "ok" });
  const twenty = parseSheet(["date:date,ms:number", ...Array.from({ length: 20 }, (_, i) => `2026-11-25,${i + 1}`), ""].join("\n"));
  const rowsOf = (source, dataset) => (`${source}/${dataset}` === "eval-ci/twenty" ? twenty : null);
  assert.deepEqual(evaluate(ok("p90(eval-ci/twenty.ms)"), ctx("day", { rowsOf })), { value: 18, status: "ok" });
  assert.deepEqual(evaluate(ok("p95(eval-ci/twenty.ms)"), ctx("day", { rowsOf })), { value: 19, status: "ok" });
  assert.deepEqual(evaluate(ok("median(eval-ci/twenty.ms)"), ctx("day", { rowsOf })), { value: 10.5, status: "ok" });
  assert.equal(plainReading(ok("p90(eval-ci/twenty.ms)")), "90th percentile of ms in eval-ci/twenty");
});


test("a where can compare a per-row expression with a number: open to live without the PRs over a day", () => {
  // Dev, 2026-11-26: a forgotten pull request read 29 days and set a whole week's p90.
  const text = "p90(github/pull-requests.deployed - opened where deployed - opened < 1440)";
  const ast = ok(text);
  assert.deepEqual(ast.where.map((c) => [c.column, c.op, c.value]), [["deployed − opened", "<", 1440]]);
  roundTrips(text);
  assert.equal(toText(ast), "p90(github/pull-requests.deployed − opened where deployed − opened < 1440)");
  assert.equal(plainReading(ast), "90th percentile of deployed − opened in github/pull-requests where deployed − opened under 1440");
  // 40, 22 and 30 minutes this week; under 35 leaves 22 and 30.
  assert.deepEqual(value("p90(github/pull-requests.deployed − opened where deployed − opened < 35)", "7 days"), { value: 30, status: "ok" });
  assert.deepEqual(value("count(github/pull-requests.deployed − opened where deployed − opened >= 30)", "7 days"), { value: 2, status: "ok" });
  assert.deepEqual(value("count(github/pull-requests.deployed − opened where deployed − opened ≤ 30)", "7 days"), { value: 2, status: "ok" });
  assert.deepEqual(value("count(github/pull-requests.deployed − opened where deployed − opened > 30 and author = ana)", "7 days"), { value: 1, status: "ok" });
  assert.deepEqual(value("sum(github/pull-requests.lines added where removed > -1)", "week"), { value: 400, status: "ok" });
  for (const t of ["sum(a/b.c where d >= 2)", "sum(a/b.c where d - e <= -3 and f = g)", "count(a/b.c where (d + e) * 2 > 0.5)"]) roundTrips(t);
  assert.deepEqual(formulaRefs(ok("p90(github/pull-requests.deployed - opened where merged - opened < 60)")).map((r) => r.column), ["deployed", "opened", "merged"]);
  bad("sum(a/b.c where d < x)", /give a number/);
  bad("sum(a/b.c where d)", /expected =, ≠, <, ≤, > or ≥ after d/i);
  bad("sum(a/b.c where d + e = 3)", /expected =, ≠, <, ≤, > or ≥/i);
  bad("sum(a/b.c where x/y.d < 3)", /One aggregate reads one dataset/);
  assert.deepEqual(value("sum(github/pull-requests.lines added where opened < 3)", "week"), { value: null, status: "error", note: "opened is a date: subtract another date from it to get minutes" });
});
