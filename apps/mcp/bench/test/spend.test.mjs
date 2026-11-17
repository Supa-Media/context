/**
 * The monthly testing budget (`bench/spend.mjs`). Invented rows and amounts.
 * The legacy all-time note stays covered in promote.test.mjs.
 *
 * Sabotage: making `exceeds` ignore the replay-gate line fails
 * "a replay-gate round stops at its sub-cap, and another test can use the rest of the month".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { budgetAt, calendarDay, monthBudget, noteRound, parseSpend, roundAllowed, spendCheck, withRow } from "../spend.mjs";

const FRONT = ["monthly_cap_usd: 40", "rollover_max_usd: 20", "daily_cap_usd: 15", "replay_gate_monthly_cap_usd: 10"];

function note(front, rows, intro = "The budget.") {
  return [
    "---",
    "role: benchmark-spend",
    ...front,
    "---",
    "",
    "# AI Benchmark spend",
    "",
    intro,
    "",
    "| date | run | test | setups | answers | usd |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.date} | ${row.run ?? "r"} | ${row.test} | ${row.setups ?? "production"} | ${row.answers ?? 1} | $${row.usd.toFixed(2)} |`),
    "",
    "Total: placeholder.",
    "",
  ].join("\n");
}

const row = (date, usd, test = "core") => ({ date, usd, test, setups: ["production"], answers: 1, run: "r" });
const at = (raw, iso) => budgetAt(parseSpend(raw), iso);
const allow = (raw, iso, expected, testName) => roundAllowed(at(raw, iso), expected, testName);

test("a new month drops last month's spend, and the rollover is last month's unused limit", () => {
  const raw = note(FRONT, [
    { date: "2026-10-15", test: "core", usd: 40 },
    { date: "2026-11-30", test: "tasks", usd: 10 },
  ]);
  // 04:30Z on 1 Dec is still 30 Nov in New York (EST, UTC-5). 05:00Z is 1 Dec.
  const before = at(raw, "2026-11-30");
  assert.equal(before.monthSpend, 10);
  assert.equal(before.monthLimit, 40, "October used its whole limit, so November carries nothing");
  assert.equal(allow(raw, "2026-11-29", 5, "fresh").ok, true, "the month still has room on a day that has not spent");
  const night = spendCheck({ raw, test: "fresh", setups: 6, now: new Date("2026-12-01T04:30:00.000Z") });
  assert.equal(night.ok, false);
  assert.match(night.reason, /daily cap/);
  assert.doesNotMatch(night.reason, /limit/);
  const december = spendCheck({ raw, test: "fresh", setups: 6, now: new Date("2026-12-01T05:00:00.000Z") });
  assert.equal(december.ok, true, "midnight on the 1st opens the new month");
  assert.equal(at(raw, "2026-12-01").monthSpend, 0);
  assert.equal(at(raw, "2026-12-01").monthLimit, 60, "November left $30, of which $20 carries");
  // The same boundary in summer, when New York is UTC-4.
  const summer = note(FRONT, [
    { date: "2026-05-15", test: "core", usd: 40 },
    { date: "2026-06-30", test: "tasks", usd: 10 },
  ]);
  assert.equal(spendCheck({ raw: summer, test: "fresh", setups: 6, now: new Date("2026-07-01T03:30:00.000Z") }).ok, false);
  assert.equal(at(summer, "2026-07-01").monthLimit, 60);
  assert.equal(calendarDay(new Date("2026-07-01T03:30:00.000Z")).iso, "2026-06-30");
  assert.equal(calendarDay(new Date("2026-07-01T04:00:00.000Z")).iso, "2026-07-01");
});

test("a day resets at midnight in America/New_York, including the daylight-saving change", () => {
  const raw = note(FRONT, [{ date: "2026-03-07", test: "core", usd: 15 }]);
  const still = spendCheck({ raw, test: "fresh", setups: 1, now: new Date("2026-03-08T04:30:00.000Z") });
  assert.equal(still.ok, false);
  assert.match(still.reason, /daily cap stops rounds until the next America\/New_York day/);
  const opened = spendCheck({ raw, test: "fresh", setups: 1, now: new Date("2026-03-08T05:00:00.000Z") });
  assert.equal(opened.ok, true, "00:00 EST is a new day, and the month still has room");
  assert.equal(calendarDay(new Date("2026-03-08T04:30:00.000Z")).iso, "2026-03-07");
  assert.equal(calendarDay(new Date("2026-03-08T05:00:00.000Z")).iso, "2026-03-08");
  // The spring-forward gap does not skip 8 Mar or invent a second day.
  assert.equal(calendarDay(new Date("2026-03-08T06:59:00.000Z")).iso, "2026-03-08");
  assert.equal(calendarDay(new Date("2026-03-08T07:00:00.000Z")).iso, "2026-03-08");
  // The fall-back hour repeats 01:30 and stays 1 Nov. A full day on 31 Oct does not fill 1 Nov.
  const fallen = note(FRONT, [{ date: "2026-10-31", test: "core", usd: 15 }]);
  assert.equal(calendarDay(new Date("2026-11-01T03:30:00.000Z")).iso, "2026-10-31");
  assert.equal(calendarDay(new Date("2026-11-01T04:00:00.000Z")).iso, "2026-11-01");
  assert.equal(calendarDay(new Date("2026-11-01T05:30:00.000Z")).iso, calendarDay(new Date("2026-11-01T06:30:00.000Z")).iso);
  assert.equal(spendCheck({ raw: fallen, test: "fresh", setups: 1, now: new Date("2026-11-01T05:30:00.000Z") }).ok, true);
  assert.equal(allow(raw, "2026-03-07", 0, "fresh").ok, true, "a round that lands on the daily cap is allowed");
  assert.equal(allow(raw, "2026-03-07", 0.01, "fresh").ok, false);
});

test("rollover reaches back one month, caps at rollover_max, and does not stack", () => {
  const rows = (...pairs) => pairs.map(([date, usd]) => row(date, usd));
  assert.equal(monthBudget(rows(["2026-01-15", 20]), 2026, 1, 40, 20).limit, 40, "the first month has nothing to carry");
  assert.equal(monthBudget(rows(["2026-01-15", 20]), 2026, 2, 40, 20).limit, 60);
  assert.equal(monthBudget(rows(["2026-01-15", 0]), 2026, 2, 40, 20).limit, 60);
  assert.equal(monthBudget(rows(["2026-01-15", 0]), 2026, 3, 40, 20).limit, 60, "a second quiet month does not stack a second $20");
  assert.equal(monthBudget(rows(["2026-01-15", 100]), 2026, 2, 40, 20).limit, 40, "overspend does not borrow from next month");
  // February's limit was $60. Spending $45 leaves $15, not max(0, 40 - 45).
  assert.equal(monthBudget(rows(["2026-01-15", 0], ["2026-02-15", 45]), 2026, 3, 40, 20).limit, 55);
  // A month with no rows still counts as last month.
  assert.equal(monthBudget(rows(["2026-01-15", 20], ["2026-02-15", 50]), 2026, 4, 40, 20).limit, 60);
  assert.equal(monthBudget(rows(["2026-01-15", 20], ["2026-02-15", 50]), 2026, 3, 40, 20).limit, 50);
  assert.equal(monthBudget(rows(["2026-12-15", 20]), 2027, 1, 40, 20).limit, 60, "the year boundary is just another month");
  const typo = note(["monthly_cap_usd: 40", "rollover_max_usd: lots", "daily_cap_usd: 15"], [{ date: "2026-01-15", test: "core", usd: 0 }]);
  assert.equal(at(typo, "2026-02-01").monthLimit, 40, "an unreadable rollover carries nothing");
});

test("a replay-gate round stops at its sub-cap, and another test can use the rest of the month", () => {
  const raw = note(FRONT, [
    { date: "2026-11-10", test: "replay-gate", usd: 9 },
    { date: "2026-11-10", test: "core", usd: 1 },
  ]);
  const replay = allow(raw, "2026-11-10", 2, "replay-gate");
  assert.equal(replay.ok, false);
  assert.match(replay.reason, /replay-gate is at \$9\.00 of its \$10\.00 monthly sub-cap/);
  assert.doesNotMatch(replay.reason, /this month is at/);
  assert.equal(allow(raw, "2026-11-10", 1, "replay-gate").ok, true, "landing on the sub-cap is allowed");
  // A fresh day can take the daily cap out of the month's remainder, including the unused cent of the replay line.
  const opened = note(FRONT, [
    { date: "2026-11-01", test: "replay-gate", usd: 9 },
    { date: "2026-11-01", test: "core", usd: 1 },
  ]);
  assert.equal(allow(opened, "2026-11-02", 15, "core").ok, true);
  assert.match(allow(opened, "2026-11-02", 15.01, "core").reason, /daily cap/);
  const later = budgetAt({ ...at(opened, "2026-11-01"), rows: [...at(opened, "2026-11-01").rows, row("2026-11-02", 15, "core")] }, "2026-11-03");
  assert.equal(later.monthSpend, 25);
  assert.equal(roundAllowed(later, 15, "core").ok, true, "the rest of the month is there the next day");
  assert.match(roundAllowed(later, 15.01, "core").reason, /limit/);
  const quiet = note(FRONT, []);
  assert.equal(allow(quiet, "2026-11-10", 15, "tasks").ok, true, "an unused replay-gate line is not held back from other tests");
  assert.match(allow(quiet, "2026-11-10", 15.01, "tasks").reason, /daily cap/);
  // A near name is not the line.
  const cousin = note(FRONT, [{ date: "2026-11-10", test: "replay-gate-extra", usd: 9 }]);
  assert.equal(allow(cousin, "2026-11-10", 2, "replay-gate").ok, true);
  // The check the Action runs uses the dearest earlier replay as the expected cost.
  const priced = note(FRONT, [{ date: "2026-11-10", test: "replay-gate", setups: "production", usd: 6 }]);
  const verdict = spendCheck({ raw: priced, test: "replay-gate", setups: 1, now: new Date("2026-11-10T15:00:00.000Z") });
  assert.equal(verdict.expected, 6);
  assert.equal(verdict.ok, false);
  const night = noteRound(at(raw, "2026-11-10"), row("2026-11-10", 1, "nightly-core"));
  assert.equal(night.daySpend, 11);
  assert.equal(roundAllowed(night, 5, "nightly-tasks").ok, false, "later areas the same night see what the night already spent");
});

test("a replay-gate round still stops at the month limit and the daily cap", () => {
  const month = note(FRONT, [
    { date: "2026-11-02", test: "core", usd: 38 },
    { date: "2026-11-02", test: "replay-gate", usd: 1 },
  ]);
  const overMonth = allow(month, "2026-11-03", 2, "replay-gate");
  assert.equal(overMonth.ok, false);
  assert.match(overMonth.reason, /this month is at \$39\.00 of its \$40\.00 limit/);
  assert.doesNotMatch(overMonth.reason, /sub-cap/);
  const day = note(FRONT, [{ date: "2026-11-04", test: "replay-gate", usd: 14 }]);
  const overDay = allow(day, "2026-11-04", 2, "replay-gate");
  assert.equal(overDay.ok, false);
  assert.match(overDay.reason, /sub-cap/);
  assert.match(overDay.reason, /daily cap/);
});

test("the replay-gate sub-cap resets each month and does not grow when the month's limit does", () => {
  const raw = note(FRONT, [
    { date: "2026-10-20", test: "replay-gate", usd: 10 },
    { date: "2026-10-20", test: "core", usd: 0 },
  ]);
  assert.equal(at(raw, "2026-11-01").monthLimit, 60, "October spent nothing of its $40, so $20 carries");
  assert.equal(at(raw, "2026-11-01").replaySpend, 0);
  assert.equal(at(raw, "2026-11-01").replayCap, 10, "the line does not take a share of the rollover");
  assert.equal(allow(raw, "2026-11-01", 10, "replay-gate").ok, true);
  assert.equal(allow(raw, "2026-11-01", 10.01, "replay-gate").ok, false);
  assert.equal(allow(raw, "2026-10-20", 0.01, "replay-gate").ok, false, "October's line is already full");
});

test("a missing replay sub-cap is $10, and an unreadable one refuses replay-gate only", () => {
  const omitted = note(["monthly_cap_usd: 40", "rollover_max_usd: 20", "daily_cap_usd: 15"], [{ date: "2026-11-08", test: "replay-gate", usd: 9 }]);
  assert.equal(parseSpend(omitted).replayCap, 10);
  assert.equal(allow(omitted, "2026-11-08", 1, "replay-gate").ok, true);
  assert.equal(allow(omitted, "2026-11-08", 1.01, "replay-gate").ok, false);
  const typo = note(["monthly_cap_usd: 40", "daily_cap_usd: 15", "replay_gate_monthly_cap_usd: lots"], []);
  assert.equal(allow(typo, "2026-11-08", 1, "replay-gate").ok, false);
  assert.match(allow(typo, "2026-11-08", 1, "replay-gate").reason, /unreadable replay_gate_monthly_cap_usd/);
  assert.equal(allow(typo, "2026-11-08", 1, "core").ok, true);
  const monthly = note(["monthly_cap_usd: lots", "daily_cap_usd: 15"], []);
  assert.equal(spendCheck({ raw: monthly, test: "core", setups: 1, now: new Date("2026-11-08T15:00:00.000Z") }).ok, false);
  const daily = note(["monthly_cap_usd: 40", "daily_cap_usd: lots"], []);
  assert.equal(spendCheck({ raw: daily, test: "core", setups: 1, now: new Date("2026-11-08T15:00:00.000Z") }).ok, false);
  // The old all-time cap stays in force until the note names a month, and a named month ignores it.
  const legacy = note(["cap_usd: 20"], [{ date: "2026-11-08", test: "core", usd: 19 }]);
  assert.equal(spendCheck({ raw: legacy, test: "fresh", setups: 2, now: new Date("2026-11-08T15:00:00.000Z") }).ok, false);
  const migrated = note(["cap_usd: 1", ...FRONT], [{ date: "2026-11-08", test: "core", usd: 5 }]);
  assert.equal(spendCheck({ raw: migrated, test: "fresh", setups: 1, now: new Date("2026-11-08T15:00:00.000Z") }).ok, true);
});

test("recording a row rewrites the month's total line and keeps the history", () => {
  const intro = "The budget. Rows from before the month stay.";
  const raw = note(FRONT, [
    { date: "2026-10-17", test: "core", usd: 12 },
    { date: "2026-11-02", test: "replay-gate", usd: 1.5 },
  ], intro);
  const next = withRow(raw, row("2026-11-02", 0.5, "core"));
  assert.match(next, /The budget\. Rows from before the month stay\./);
  assert.match(next, /\| 2026-10-17 \| r \| core \| production \| 1 \| \$12\.00 \|/);
  assert.match(next, /\| 2026-11-02 \| r \| core \| production \| 1 \| \$0\.50 \|/);
  assert.match(next, /Total: \$2\.00 of November 2026's \$60\.00 limit \(\$20\.00 carried in; \$2\.00 of the \$15\.00 daily cap on 2026-11-02; replay-gate \$1\.50 of its \$10\.00\)\.\n$/);
  assert.equal(parseSpend(next).rows.length, 3);
});
