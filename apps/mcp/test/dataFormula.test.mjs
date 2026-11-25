/**
 * Workspace metrics: the pure formula engine (`src/data/formula/`).
 *
 * A metric is a formula over dataset sheets, worked out on read at the
 * viewer's clearance. These checks hold the grammar, the caps and name
 * refusals that keep a hostile formula harmless, the windows a period means,
 * and the one rule that matters most for privacy: an input the viewer cannot
 * see reads exactly like one that does not exist.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. `evaluate` naming hidden inputs differently ("can't see …"): "a missing
 *    input and a hidden one read the same" fails.
 * 2. `windowFor` starting the week on Sunday: "a week starts on Monday, UTC" fails.
 * 3. Dropping the reserved-name check in `parse.js`: "__proto__, constructor
 *    and prototype are refused as names" fails.
 * 4. Removing the node cap: "a formula over 32 parts is refused" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { lex } from "../src/data/formula/lex.js";
import { columnKey, MAX_AGGREGATES, MAX_FORMULA_BYTES, MAX_NODES, parseFormula } from "../src/data/formula/parse.js";
import { formulaInputs, formulaRefs } from "../src/data/formula/refs.js";
import { parseEvery, previousWindows, windowFor } from "../src/data/formula/windows.js";
import { evaluate, series } from "../src/data/formula/evaluate.js";
import { formatValue } from "../src/data/formula/format.js";
import { plainReading, toText } from "../src/data/formula/render.js";
import * as barrel from "../src/data/formula/index.js";
import { parseSheet } from "../src/sheets/csv.js";

const ok = (text) => {
  const r = parseFormula(text);
  assert.equal(r.ok, true, `${text}: ${r.error?.message}`);
  return r.ast;
};
const bad = (text, pattern) => {
  const r = parseFormula(text);
  assert.equal(r.ok, false, `${text} should be refused`);
  assert.equal(typeof r.error.message, "string");
  assert.equal(typeof r.error.at, "number");
  if (pattern) assert.match(r.error.message, pattern);
  return r.error;
};
const roundTrips = (text) => {
  const ast = ok(text);
  const again = ok(toText(ast));
  assert.deepEqual(again, ast, `${text} → ${toText(ast)}`);
  assert.equal(toText(again), toText(ast));
};

/* --------------------------------- fixtures -------------------------------- */

const PRS = parseSheet([
  "opened:date,merged:date,deployed:date,lines added:number,removed:number,author",
  "2026-11-23T09:00Z,2026-11-23T09:30Z,2026-11-23T09:40Z,100,20,ana",
  "2026-11-24T10:00Z,2026-11-24T10:10Z,2026-11-24T10:22Z,300,50,bo",
  "2026-11-25T08:00Z,,2026-11-25T08:30Z,10,,ana",
  "2026-11-16T08:00Z,2026-11-16T09:00Z,2026-11-16T11:00Z,5000,0,cy",
  "",
].join("\n"));
const REVENUE = parseSheet([
  "date:date,usd:usd,plan:select",
  "2026-11-02,\"$1,000\",Team",
  "2026-11-10,$500,Solo",
  "2026-11-20,250,Team",
  "2026-10-15,900,Team",
  "",
].join("\n"));
const SPEND = parseSheet(["date:date,usd:usd", "2026-11-05,100", "2026-11-25,50", "2026-10-01,0", ""].join("\n"));
const BENCH = parseSheet(["date:date,errors:number,requests:number,ms:number", "2026-11-25,2,100,800", "2026-11-25,1,50,1200", "2026-11-25,,,1500", ""].join("\n"));

const SHEETS = new Map([
  ["github/pull-requests", PRS],
  ["stripe/revenue", REVENUE],
  ["cloudflare/ai-spend", SPEND],
  ["eval-ci/bench-runs", BENCH],
]);
const HIDDEN = new Set(["stripe/secret"]);
const rowsOf = (source, dataset) => {
  const key = `${source}/${dataset}`;
  if (HIDDEN.has(key)) return null; // what the gateway returns for a sheet above the viewer's clearance
  return SHEETS.get(key) ?? null;
};
const NOW = Date.parse("2026-11-25T12:00:00Z"); // a Wednesday
const ctx = (every, extra = {}) => ({ rowsOf, every, now: NOW, ...extra });

/* ---------------------------------- lexing --------------------------------- */

test("the lexer splits names, numbers, operators and quoted text", () => {
  const r = lex('sum(github/pull-requests.lines added) ÷ 2.5 where plan ≠ "a b"');
  assert.equal(r.ok, true);
  assert.deepEqual(r.tokens.map((t) => t.type), ["word", "op", "word", "op", "word", "op", "word", "word", "op", "op", "num", "word", "word", "op", "str"]);
  assert.equal(r.tokens[4].raw, "pull-requests");
  assert.equal(r.tokens[10].value, 2.5);
  assert.equal(r.tokens[13].value, "!=");
});

test("a hyphen inside a name is part of it, and with a space around it is a minus", () => {
  assert.deepEqual(lex("ai-spend").tokens.map((t) => t.raw), ["ai-spend"]);
  assert.deepEqual(lex("a - b").tokens.map((t) => t.value ?? t.raw), ["a", "-", "b"]);
  assert.deepEqual(lex("a − b").tokens.map((t) => t.value ?? t.raw), ["a", "-", "b"]);
  assert.deepEqual(lex("5-3").tokens.map((t) => t.type), ["num", "op", "num"]);
  assert.deepEqual(lex("2026-runs").tokens.map((t) => t.raw), ["2026-runs"]);
});

test("the lexer refuses a stray character and an unclosed quote, with where", () => {
  assert.deepEqual(lex("sum(a) # b").error, { message: 'There is a "#" the formula does not use.', at: 7 });
  assert.equal(lex('x = "open').error.at, 4);
});

/* --------------------------------- grammar --------------------------------- */

test("every formula drawn in the artboards parses", () => {
  const drawn = [
    "median(github/pull-requests.deployed - opened)",
    "median(github/pull-requests.deployed − opened)",
    "count(github/pull-requests.merged)",
    "sum(github/pull-requests.lines added + removed)",
    "sum(stripe/revenue.usd) ÷ sum(cloudflare/ai-spend.usd)",
    "sum(stripe/revenue.usd where plan = Team) ÷ sum(cloudflare/ai-spend.usd)",
    "sum(eval-ci/bench-runs.errors) ÷ sum(requests)",
    "p95(eval-ci/bench-runs.ms)",
  ];
  for (const text of drawn) roundTrips(text);
});

test("the AST is plain objects with full refs", () => {
  assert.deepEqual(ok("sum(stripe/revenue.usd where plan = Team) ÷ 2"), {
    type: "binary",
    op: "/",
    left: {
      type: "agg",
      fn: "sum",
      source: "stripe",
      dataset: "revenue",
      expr: { type: "ref", source: "stripe", dataset: "revenue", column: "usd" },
      where: [{ column: "plan", op: "=", value: "Team" }],
    },
    right: { type: "number", value: 2 },
  });
});

test("a bare column takes the dataset of the aggregate, or of the formula's last ref", () => {
  const ast = ok("sum(github/pull-requests.lines added + removed)");
  assert.deepEqual(ast.expr.right, { type: "ref", source: "github", dataset: "pull-requests", column: "removed" });
  const two = ok("sum(eval-ci/bench-runs.errors) ÷ sum(requests)");
  assert.equal(two.right.source, "eval-ci");
  assert.equal(two.right.dataset, "bench-runs");
  bad("sum(usd)", /source\/dataset/);
});

test("precedence, brackets and every operator spelling", () => {
  const a = ok("1 + 2 * 3");
  assert.equal(a.op, "+");
  assert.equal(a.right.op, "*");
  const b = ok("(1 + 2) × 3");
  assert.equal(b.op, "*");
  assert.equal(b.left.op, "+");
  assert.equal(ok("6 / 3").op, "/");
  assert.equal(ok("6 ÷ 3").op, "/");
  assert.equal(ok("6 - 3").op, "-");
  assert.equal(ok("6 − 3").op, "-");
  assert.equal(ok("6 * 3").op, "*");
  for (const t of ["1 + 2 * 3", "(1 + 2) × 3", "1 - (2 - 3)", "(1 - 2) - 3", "8 ÷ (4 ÷ 2)", "sum(a/b.x × (y - 2) ÷ z) - 1"]) roundTrips(t);
});

test("every aggregate is known, in any case, and an unknown one is named", () => {
  for (const fn of ["sum", "count", "average", "median", "p95", "min", "max"]) {
    assert.equal(ok(`${fn}(a/b.c)`).fn, fn);
    assert.equal(ok(`${fn.toUpperCase()}(a/b.c)`).fn, fn);
  }
  bad("mean(a/b.c)", /unknown function "mean"/);
  bad("a/b.c", /aggregate/);
  bad("sum(a/b.c", /\)/);
  bad("sum()", /column/);
  bad("sum(5)", /column/);
  bad("sum(count(a/b.c))", /inside another/);
  bad("", /formula/);
  bad("   ", /formula/);
  bad("sum(a/b.c) sum(a/b.c)", /sum/);
  bad("1 +", /expected/);
});

test("one aggregate reads one dataset", () => {
  bad("sum(a/b.x + c/d.y)", /one dataset/);
  ok("sum(a/b.x + a/b.y)");
});

test("where: =, ≠ and !=, joined by and; bare words, numbers and quoted text", () => {
  const ast = ok('count(a/b.x where plan = Team and seats != 5 and note ≠ "two words" and region = north east)');
  assert.deepEqual(ast.where, [
    { column: "plan", op: "=", value: "Team" },
    { column: "seats", op: "!=", value: "5" },
    { column: "note", op: "!=", value: "two words" },
    { column: "region", op: "=", value: "north east" },
  ]);
  roundTrips('count(a/b.x where plan = Team and seats != 5 and note ≠ "two words" and region = north east)');
  roundTrips('count(a/b.x where note = "and" and q = "it\'s" and r = \'say "hi"\' and s = "")');
  bad("count(a/b.x where)", /column/);
  bad("count(a/b.x where plan)", /=/);
  bad("count(a/b.x where plan =)", /value/);
  bad("count(a/b.x where plan > 3)", /">"/);
});

test("column names with spaces, underscores, case and quotes", () => {
  assert.equal(columnKey("Lines_Added"), columnKey("lines added"));
  assert.equal(columnKey("  lines   added "), "lines added");
  assert.equal(ok("sum(a/b.lines added)").expr.column, "lines added");
  assert.equal(ok("sum(a/b.lines_added)").expr.column, "lines_added");
  assert.equal(ok('sum(a/b."time (ms)")').expr.column, "time (ms)");
  roundTrips('sum(a/b."time (ms)" + "x where y")');
  roundTrips("sum(a/b.2026 + c)");
  assert.equal(ok("sum(a/2026-runs.ms)").dataset, "2026-runs");
});

test("__proto__, constructor and prototype are refused as names", () => {
  for (const name of ["__proto__", "constructor", "prototype", "Constructor", "__PROTO__"]) {
    bad(`sum(${name}/b.c)`, /can't be used as a name/);
    bad(`sum(a/${name}.c)`, /can't be used as a name/);
    bad(`sum(a/b.${name})`, /can't be used as a name/);
    bad(`sum(a/b.c where ${name} = 1)`, /can't be used as a name/);
    bad(`sum(a/b."${name}")`, /can't be used as a name/);
  }
  bad("sum(a/b.___)", /name/);
});

test("a formula over 2 KB is refused", () => {
  assert.equal(MAX_FORMULA_BYTES, 2048);
  const long = `sum(a/b.${"x".repeat(MAX_FORMULA_BYTES)})`;
  bad(long, /2 KB/);
  // Bytes, not characters: 700 three-byte minus signs are over the cap.
  bad(`sum(a/b."${"−".repeat(700)}")`, /2 KB/);
});

test("a formula with more than 8 aggregates is refused", () => {
  assert.equal(MAX_AGGREGATES, 8);
  ok(Array.from({ length: 8 }, () => "sum(a/b.c)").join(" + "));
  bad(Array.from({ length: 9 }, () => "sum(a/b.c)").join(" + "), /8 aggregates/);
});

test("a formula over 32 parts is refused", () => {
  assert.equal(MAX_NODES, 32);
  ok(Array.from({ length: 16 }, (_, i) => String(i)).join(" + ")); // 31 nodes
  bad(Array.from({ length: 17 }, (_, i) => String(i)).join(" + "), /32 parts/);
  bad(`${"(".repeat(40)}1${")".repeat(40)}`, /brackets/);
});

test("parsing never evaluates text: no globals reached, nothing thrown", () => {
  for (const text of ["sum(globalThis/process.env)", "constructor(a/b.c)", "sum(a/b.c) ; process.exit(1)", "`${1}`", "sum(a/b.c where x = ${x})"]) {
    const r = parseFormula(text);
    if (r.ok) assert.equal(typeof r.ast, "object");
  }
  assert.equal(parseFormula(null).ok, false);
  assert.equal(parseFormula(42).ok, false);
});

test("a few hundred random strings never throw", () => {
  const alphabet = ["sum", "count", "p95", "(", ")", "/", ".", "-", "−", "+", "×", "÷", "*", " ", "a", "b", "where", "and", "=", "≠", "!=", "'", '"', "1", "2.5", "_", "__proto__", "\n", "é", "#", "[", "{"];
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let parsed = 0;
  for (let i = 0; i < 400; i += 1) {
    const n = 1 + Math.floor(rand() * 24);
    let text = "";
    for (let j = 0; j < n; j += 1) text += alphabet[Math.floor(rand() * alphabet.length)];
    const r = parseFormula(text);
    assert.equal(typeof r.ok, "boolean");
    if (r.ok) {
      parsed += 1;
      assert.deepEqual(parseFormula(toText(r.ast)).ast, r.ast, text);
      const v = evaluate(r.ast, ctx("week"));
      assert.ok(["ok", "no_data", "error"].includes(v.status));
      formulaRefs(r.ast);
      plainReading(r.ast, "week");
    } else {
      assert.ok(r.error.at >= 0 && r.error.at <= text.length, text);
    }
  }
  assert.ok(parsed > 0);
});

/* ----------------------------------- refs ---------------------------------- */

test("refs: each column once, where columns included; inputs: each dataset once", () => {
  const ast = ok("sum(stripe/revenue.usd where plan = Team) ÷ sum(cloudflare/ai-spend.usd) + count(stripe/revenue.USD)");
  assert.deepEqual(formulaRefs(ast), [
    { source: "stripe", dataset: "revenue", column: "usd" },
    { source: "stripe", dataset: "revenue", column: "plan" },
    { source: "cloudflare", dataset: "ai-spend", column: "usd" },
  ]);
  assert.deepEqual(formulaInputs(ast), [{ source: "stripe", dataset: "revenue" }, { source: "cloudflare", dataset: "ai-spend" }]);
  assert.deepEqual(formulaRefs(ok("1 + 2")), []);
});

/* --------------------------------- windows --------------------------------- */

const iso = (w) => ({ from: w.from, to: w.to });

test("periods: day, week, month, and N days", () => {
  assert.deepEqual(parseEvery("day"), { unit: "day" });
  assert.deepEqual(parseEvery("Week"), { unit: "week" });
  assert.deepEqual(parseEvery("7 days"), { unit: "days", days: 7 });
  assert.deepEqual(parseEvery("1 day"), { unit: "days", days: 1 });
  for (const no of ["", "fortnight", "0 days", "-3 days", "400 days", "7days", "1.5 days", null, 7]) assert.equal(parseEvery(no), null, String(no));
  assert.equal(windowFor("year", NOW), null);
});

test("a day is its UTC calendar day to date", () => {
  assert.deepEqual(iso(windowFor("day", NOW)), { from: "2026-11-25T00:00:00.000Z", to: "2026-11-25T12:00:00.000Z" });
  assert.deepEqual(iso(windowFor("day", "2026-11-25T23:59:59.999Z")), { from: "2026-11-25T00:00:00.000Z", to: "2026-11-25T23:59:59.999Z" });
});

test("a week starts on Monday, UTC", () => {
  assert.equal(windowFor("week", NOW).from, "2026-11-23T00:00:00.000Z"); // Wednesday → Monday
  assert.equal(windowFor("week", "2026-11-23T00:00:00.000Z").from, "2026-11-23T00:00:00.000Z"); // Monday midnight
  assert.equal(windowFor("week", "2026-11-22T23:59:59.999Z").from, "2026-11-16T00:00:00.000Z"); // Sunday night
  assert.equal(windowFor("week", "2026-01-01T12:00:00Z").from, "2025-12-29T00:00:00.000Z"); // across a year
});

test("a month is its UTC calendar month to date", () => {
  assert.equal(windowFor("month", NOW).from, "2026-11-01T00:00:00.000Z");
  assert.equal(windowFor("month", "2026-12-01T00:00:00.000Z").from, "2026-12-01T00:00:00.000Z");
  assert.equal(windowFor("month", "2026-11-30T23:59:59.999Z").from, "2026-11-01T00:00:00.000Z");
  assert.equal(windowFor("month", "2027-01-15T00:00:00Z").from, "2027-01-01T00:00:00.000Z");
});

test("N days is rolling", () => {
  assert.deepEqual(iso(windowFor("7 days", NOW)), { from: "2026-11-18T12:00:00.000Z", to: "2026-11-25T12:00:00.000Z" });
});

test("previous windows: oldest first, whole periods, the last one to date", () => {
  const months = previousWindows("month", "2026-03-10T00:00:00Z", 6).map(iso);
  assert.deepEqual(months.map((w) => w.from.slice(0, 10)), ["2025-10-01", "2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01"]);
  assert.equal(months[4].to, "2026-03-01T00:00:00.000Z");
  assert.equal(months[5].to, "2026-03-10T00:00:00.000Z");
  const weeks = previousWindows("week", NOW, 2);
  assert.deepEqual(weeks.map(iso), [{ from: "2026-11-16T00:00:00.000Z", to: "2026-11-23T00:00:00.000Z" }, { from: "2026-11-23T00:00:00.000Z", to: "2026-11-25T12:00:00.000Z" }]);
  const rolling = previousWindows("7 days", NOW, 2);
  assert.deepEqual(rolling[0].to, rolling[1].from);
  assert.deepEqual(previousWindows("day", NOW, 0), []);
  assert.deepEqual(previousWindows("nope", NOW, 3), []);
});

/* -------------------------------- evaluating ------------------------------- */

const value = (text, every, extra) => evaluate(ok(text), ctx(every, extra));

test("artboard: median deployed − opened over 7 days, in minutes", () => {
  // 40, 22 and 30 minutes in the last 7 days; the PR on the 16th is older.
  assert.deepEqual(value("median(github/pull-requests.deployed − opened)", "7 days"), { value: 30, status: "ok" });
});

test("artboard: count of merged this week counts the filled cells only", () => {
  assert.deepEqual(value("count(github/pull-requests.merged)", "week"), { value: 2, status: "ok" });
  assert.deepEqual(value("count(github/pull-requests.merged)", "month"), { value: 3, status: "ok" });
});

test("artboard: sum of lines added + removed this week; a row with an empty cell is left out", () => {
  assert.deepEqual(value("sum(github/pull-requests.lines added + removed)", "week"), { value: 470, status: "ok" });
  assert.deepEqual(value("sum(github/pull-requests.lines_added)", "week"), { value: 410, status: "ok" });
});

test("artboard: revenue per AI dollar this month, and where plan = Team", () => {
  assert.deepEqual(value("sum(stripe/revenue.usd) ÷ sum(cloudflare/ai-spend.usd)", "month"), { value: 1750 / 150, status: "ok" });
  assert.deepEqual(value("sum(stripe/revenue.usd where plan = Team) ÷ sum(cloudflare/ai-spend.usd)", "month"), { value: 1250 / 150, status: "ok" });
  assert.deepEqual(value("sum(stripe/revenue.usd where plan ≠ team)", "month"), { value: 500, status: "ok" });
});

test("artboard: error rate and p95", () => {
  assert.deepEqual(value("sum(eval-ci/bench-runs.errors) ÷ sum(requests)", "day"), { value: 3 / 150, status: "ok" });
  assert.deepEqual(value("p95(eval-ci/bench-runs.ms)", "day"), { value: 1500, status: "ok" });
});

test("average, min, max and arithmetic between aggregates", () => {
  assert.deepEqual(value("average(eval-ci/bench-runs.ms)", "day"), { value: 3500 / 3, status: "ok" });
  assert.deepEqual(value("min(eval-ci/bench-runs.ms) + max(eval-ci/bench-runs.ms) * 2", "day"), { value: 3800, status: "ok" });
  assert.deepEqual(value("median(eval-ci/bench-runs.requests)", "day"), { value: 75, status: "ok" });
  assert.deepEqual(value("(1 + 2) * 3", "day"), { value: 9, status: "ok" });
});

test("a period with no rows is no data; count of none is 0", () => {
  const empty = { rowsOf: () => ({ columns: [{ name: "date", type: "date" }, { name: "usd", type: "usd" }], rows: [] }), every: "month", now: NOW };
  assert.equal(evaluate(ok("sum(a/b.usd)"), empty).status, "no_data");
  assert.equal(evaluate(ok("sum(a/b.usd)"), empty).value, null);
  assert.deepEqual(evaluate(ok("count(a/b.usd)"), empty), { value: 0, status: "ok" });
});

test("dividing by 0 is an error that says so, between aggregates and inside one", () => {
  const zero = { ...ctx("month"), now: Date.parse("2026-10-20T00:00:00Z") };
  assert.deepEqual(evaluate(ok("sum(stripe/revenue.usd) ÷ sum(cloudflare/ai-spend.usd)"), zero), { value: null, status: "error", note: "divides by 0" });
  assert.deepEqual(value("sum(stripe/revenue.usd ÷ 0)", "month"), { value: null, status: "error", note: "divides by 0" });
  assert.deepEqual(value("1 / 0", "month"), { value: null, status: "error", note: "divides by 0" });
});

test("a number too large to show is an error, never Infinity", () => {
  // A literal that large is refused at parse; data can still overflow.
  assert.equal(parseFormula(`${"9".repeat(300)} * 2`).ok, false);
  const huge = { columns: [{ name: "date", type: "date" }, { name: "x", type: "number" }], rows: [{ date: "2026-11-20", x: "9".repeat(300) }, { date: "2026-11-21", x: "9".repeat(300) }] };
  const r = evaluate(ok("sum(big/data.x) * sum(big/data.x)"), { ...ctx("month"), rowsOf: () => huge });
  assert.equal(r.status, "error");
  assert.equal(r.value, null);
});

test("a missing input and a hidden one read the same", () => {
  const hidden = value("sum(stripe/secret.usd)", "month");
  const missing = value("sum(stripe/nothing-here.usd)", "month");
  assert.deepEqual(hidden, { value: null, status: "error", note: "can't read stripe/secret" });
  assert.deepEqual(missing, { value: null, status: "error", note: "can't read stripe/nothing-here" });
  assert.deepEqual(Object.keys(hidden), Object.keys(missing));
  // Behind a divide, next to a readable input, and a rowsOf that throws: still the same words.
  assert.equal(value("sum(stripe/revenue.usd) ÷ sum(stripe/secret.usd)", "month").note, "can't read stripe/secret");
  const throws = evaluate(ok("sum(stripe/secret.usd)"), { ...ctx("month"), rowsOf: () => { throw new Error("denied: clearance team"); } });
  assert.deepEqual(throws, hidden);
  const junk = evaluate(ok("sum(stripe/secret.usd)"), { ...ctx("month"), rowsOf: () => "not a sheet" });
  assert.deepEqual(junk, hidden);
});

test("a column the sheet lacks, a date summed alone, and no date column are errors in words", () => {
  assert.deepEqual(value("sum(stripe/revenue.seats)", "month"), { value: null, status: "error", note: 'no column "seats" in stripe/revenue' });
  assert.deepEqual(value("sum(stripe/revenue.usd where tier = x)", "month"), { value: null, status: "error", note: 'no column "tier" in stripe/revenue' });
  assert.match(value("sum(github/pull-requests.merged)", "month").note, /date/);
  assert.match(value("sum(github/pull-requests.merged + 1)", "month").note, /date/);
  const undated = { rowsOf: () => parseSheet("usd:usd\n5\n"), every: "month", now: NOW };
  assert.match(evaluate(ok("sum(a/b.usd)"), undated).note, /no date column/);
  assert.equal(value("sum(stripe/revenue.usd)", "fortnight").status, "error");
  assert.equal(evaluate(ok("sum(stripe/revenue.usd)"), { ...ctx("month"), now: "not a time" }).status, "error");
});

test("rows are placed by the `on` column when given, else the first date column", () => {
  // By opened (the first date column) the PR merged on the 16th opened on the 16th: last week.
  assert.deepEqual(value("count(github/pull-requests.merged)", "week", { on: "merged" }), { value: 2, status: "ok" });
  const late = parseSheet(["opened:date,merged:date", "2026-11-20,2026-11-24", ""].join("\n"));
  const lateCtx = { rowsOf: () => late, every: "week", now: NOW };
  assert.equal(evaluate(ok("count(a/b.merged)"), lateCtx).value, 0);
  assert.equal(evaluate(ok("count(a/b.merged)"), { ...lateCtx, on: "merged" }).value, 1);
  assert.match(evaluate(ok("count(a/b.merged)"), { ...lateCtx, on: "closed" }).note, /no column "closed"/);
});

test("date − date is minutes, and a cell that isn't a number is left out", () => {
  const sheet = parseSheet(["at:date,a:date,b:date,n", "2026-11-25,2026-11-25T10:00Z,2026-11-24T10:00Z,x", "2026-11-25,2026-11-25,2026-11-25T00:00:30Z,\"$1,200\"", ""].join("\n"));
  const c = { rowsOf: () => sheet, every: "day", now: NOW };
  assert.deepEqual(evaluate(ok("max(a/b.a - b)"), c), { value: 1440, status: "ok" });
  assert.deepEqual(evaluate(ok("min(a/b.a - b)"), c), { value: -0.5, status: "ok" });
  assert.deepEqual(evaluate(ok("count(a/b.n)"), c), { value: 2, status: "ok" });
  assert.equal(evaluate(ok("sum(a/b.n)"), c).status, "ok");
});

test("the current window includes now, a past one ends before its next start", () => {
  const sheet = parseSheet(["at:date,v:number", "2026-11-25T12:00Z,1", "2026-11-23T00:00Z,10", "2026-11-22T23:59:59.999Z,100", ""].join("\n"));
  const c = { rowsOf: () => sheet, every: "week", now: NOW };
  assert.equal(evaluate(ok("sum(a/b.v)"), c).value, 11);
  const s = series(ok("sum(a/b.v)"), c, 2);
  assert.deepEqual(s.map((p) => p.value), [100, 11]);
});

test("series: one reading per window, rowsOf asked once per dataset", () => {
  let asked = 0;
  const c = { ...ctx("month"), rowsOf: (s, d) => { asked += 1; return rowsOf(s, d); } };
  const points = series(ok("sum(stripe/revenue.usd) ÷ sum(cloudflare/ai-spend.usd)"), c, 3);
  assert.equal(asked, 2);
  assert.deepEqual(points.map((p) => [p.from.slice(0, 10), p.status, p.value]), [
    ["2026-09-01", "no_data", null],
    ["2026-10-01", "error", null],
    ["2026-11-01", "ok", 1750 / 150],
  ]);
  assert.equal(points[1].note, "divides by 0");
  assert.deepEqual(series(ok("1"), ctx("nope"), 3), []);
});

test("evaluate takes formula text too, and a bad one is an error, not a throw", () => {
  assert.deepEqual(evaluate("sum(stripe/revenue.usd)", ctx("month")), { value: 1750, status: "ok" });
  assert.equal(evaluate("sum(", ctx("month")).status, "error");
  assert.equal(evaluate({ type: "nonsense" }, ctx("month")).status, "error");
});

/* --------------------------------- formats --------------------------------- */

test("display formats", () => {
  assert.equal(formatValue(7, "0"), "7");
  assert.equal(formatValue(1436.4, "0"), "1,436");
  assert.equal(formatValue(2.25, "0.0"), "2.3");
  assert.equal(formatValue(0.022, "0%"), "2%");
  assert.equal(formatValue(0.022, "0.0%"), "2.2%");
  assert.equal(formatValue(9.4, "$0"), "$9");
  assert.equal(formatValue(9.4, "$0.00"), "$9.40");
  assert.equal(formatValue(-1234.5, "$0.00"), "-$1,234.50");
  assert.equal(formatValue(22, "duration"), "22 min");
  assert.equal(formatValue(59.6, "duration"), "1 h");
  assert.equal(formatValue(144, "duration"), "2.4 h");
  assert.equal(formatValue(4320, "duration"), "3 d");
  assert.equal(formatValue(18200, "0.0k"), "18.2k");
  assert.equal(formatValue(null, "0"), "—");
  assert.equal(formatValue(Number.NaN, "0"), "—");
  assert.equal(formatValue(Infinity, "$0"), "—");
  assert.equal(formatValue(1.23456, "nonsense"), "1.23");
  assert.equal(formatValue(-0.2, "0"), "0");
});

/* --------------------------------- rendering ------------------------------- */

test("toText writes the canonical form", () => {
  assert.equal(toText(ok("SUM( stripe/revenue.usd   where plan=Team )/sum(cloudflare/ai-spend.usd)")), "sum(stripe/revenue.usd where plan = Team) ÷ sum(cloudflare/ai-spend.usd)");
  assert.equal(toText(ok("median(github/pull-requests.deployed-opened)")), "median(github/pull-requests.deployed-opened)");
  assert.equal(toText(ok("median(github/pull-requests.deployed - opened)")), "median(github/pull-requests.deployed − opened)");
  assert.equal(toText(ok("sum(a/b.x where y != 1)")), "sum(a/b.x where y ≠ 1)");
});

test("plain reading", () => {
  assert.equal(plainReading(ok("sum(stripe/revenue.usd) ÷ sum(cloudflare/ai-spend.usd)"), "month"), "Sum of usd in stripe/revenue ÷ sum of usd in cloudflare/ai-spend, each month");
  assert.equal(plainReading(ok("median(github/pull-requests.deployed − opened)"), "7 days"), "Median of deployed − opened in github/pull-requests, over the last 7 days");
  assert.equal(plainReading(ok("count(github/pull-requests.merged)"), "week"), "Count of merged in github/pull-requests, each week");
  assert.equal(plainReading(ok("sum(stripe/revenue.usd where plan = Team and seats ≠ 1)"), "day"), "Sum of usd in stripe/revenue where plan is Team and seats is not 1, each day");
  assert.equal(plainReading(ok("p95(eval-ci/bench-runs.ms)")), "95th percentile of ms in eval-ci/bench-runs");
});

test("the index re-exports the engine", () => {
  for (const name of ["parseFormula", "toText", "plainReading", "evaluate", "series", "formatValue", "formulaRefs", "formulaInputs", "windowFor", "previousWindows", "parseEvery", "columnKey"]) {
    assert.equal(typeof barrel[name], "function", name);
  }
});

test("bug sweep: numbers, percents, UTC strings and the canonical size stay sound", async () => {
  const { parseFormula, toText } = await import("../src/data/formula/index.js");
  const { formatValue } = await import("../src/data/formula/format.js");
  const { toMs } = await import("../src/data/formula/windows.js");
  assert.equal(parseFormula("sum(s/d.x) * 0.000000000000000000000001").ok, false);
  assert.equal(parseFormula(`sum(s/d.x) * 1${"0".repeat(400)}`).ok, false);
  const fine = parseFormula("sum(s/d.x) * 0.25");
  assert.equal(fine.ok, true);
  assert.deepEqual(parseFormula(toText(fine.ast)).ast.type, fine.ast.type);
  assert.equal(formatValue(0.285, "0%"), "29%");
  assert.equal(formatValue(0.145, "0%"), "15%");
  assert.equal(toMs("2026-03-15T10:00:00"), Date.UTC(2026, 2, 15, 10));
  const n = 164;
  const big = Array.from({ length: 4 }, (_, i) => `sum(s/d${i}.${"a".repeat(n)}*${"b".repeat(n)}/${"c".repeat(n)})`).join("+");
  const parsed = parseFormula(big);
  if (parsed.ok) assert.ok(new TextEncoder().encode(toText(parsed.ast)).byteLength <= 2048);
});
