/**
 * A metric says nothing rather than a 0 nobody measured (Dev2, 2026-11-25: "these metrics look fake"):
 * `evalAggregate` in `src/data/formula/evaluate.js`.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. Dropping the never-filled check: "picking rows by a column nobody has filled in is no data, never 0" fails.
 * 2. Dropping the first-row check: "a period from before a sheet's first row is no data, ..." fails, and so does
 *    dataFormula's "a period with no rows is no data; so is a count over a sheet with no rows at all".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFormula } from "../src/data/formula/parse.js";
import { evaluate, series } from "../src/data/formula/evaluate.js";
import { parseSheet } from "../src/sheets/csv.js";

const NOW = Date.parse("2026-11-25T12:00:00Z");
function ok(text) {
  const parsed = parseFormula(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return parsed.ast;
}

test("picking rows by a column nobody has filled in is no data, never 0", () => {
  // Sign-ups before their channel was recorded (2026-11-25): "Search actives 0" read as a real count.
  const signups = parseSheet(["person:text,day:date,channel:text,day1_active:number", "a,2026-11-24,,1", "b,2026-11-24,,1", ""].join("\n"));
  const ctx = { rowsOf: () => signups, every: "7 days", now: NOW };
  const none = evaluate(ok("count(usage/sign-ups.person where day1_active = 1 and channel = search)"), ctx);
  assert.equal(none.value, null);
  assert.notEqual(none.status, "ok");
  // Once any sign-up has a channel, a window with none from search is a real 0.
  const filled = parseSheet(["person:text,day:date,channel:text,day1_active:number", "a,2026-11-24,ai,1", "b,2026-11-24,,1", ""].join("\n"));
  assert.deepEqual(evaluate(ok("count(usage/sign-ups.person where day1_active = 1 and channel = search)"), { ...ctx, rowsOf: () => filled }), { value: 0, status: "ok" });
  // A != filter on an empty column passes every row, as before.
  assert.equal(evaluate(ok("count(usage/sign-ups.person where channel != search)"), ctx).value, 2);
});

test("a period from before a sheet's first row is no data, so a trend starts where the records do", () => {
  const deploys = parseSheet(["sha:text,started:date", "s1,2026-11-24T08:00:00Z", "s2,2026-11-25T08:00:00Z", ""].join("\n"));
  const ctx = { rowsOf: () => deploys, every: "day", now: NOW };
  const back = series(ok("count(distinct x/deploys.sha)"), ctx, 4);
  assert.deepEqual(back.map((p) => p.value), [null, null, 1, 1]);
  // A period after the first row with nothing in it is a real 0.
  const gap = parseSheet(["sha:text,started:date", "s1,2026-11-22T08:00:00Z", "s2,2026-11-25T08:00:00Z", ""].join("\n"));
  assert.deepEqual(series(ok("count(x/deploys.sha)"), { ...ctx, rowsOf: () => gap }, 4).map((p) => p.value), [1, 0, 0, 1]);
});
