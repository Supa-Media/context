// The routine file format (`packages/shared/src/routines.cjs`): which notes
// run, how often, and when next. The control plane, the gateway and the app
// all read it, so its answers are pinned here once.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  cadenceFromFolder,
  routineFromPath,
  frontMatter,
  parseTime,
  parseWeekdays,
  routineSettings,
  nextRunAt,
  describeSchedule,
  routineRunsKey,
} = require("../../../packages/shared/src/routines.cjs");

const NY = "America/New_York";
const iso = (ms) => new Date(ms).toISOString();

test("a folder name says how often", () => {
  assert.deepEqual(cadenceFromFolder("hourly"), { unit: "hour", every: 1 });
  assert.deepEqual(cadenceFromFolder("Daily"), { unit: "day", every: 1 });
  assert.deepEqual(cadenceFromFolder("weekly"), { unit: "week", every: 1 });
  assert.deepEqual(cadenceFromFolder("bi-weekly"), { unit: "week", every: 2 });
  assert.deepEqual(cadenceFromFolder("every-2-weeks"), { unit: "week", every: 2 });
  assert.deepEqual(cadenceFromFolder("monthly"), { unit: "month", every: 1 });
  assert.deepEqual(cadenceFromFolder("every-5-minutes"), { unit: "minute", every: 5 });
  assert.deepEqual(cadenceFromFolder("every-3-hours"), { unit: "hour", every: 3 });
  assert.deepEqual(cadenceFromFolder("every-day"), { unit: "day", every: 1 });
  assert.equal(cadenceFromFolder("every-2-minutes"), null, "faster than five minutes is refused");
  assert.equal(cadenceFromFolder("every-minute"), null);
  assert.equal(cadenceFromFolder("someday"), null);
  assert.equal(cadenceFromFolder("every-0-days"), null);
});

test("only notes directly inside a schedule folder run", () => {
  assert.deepEqual(routineFromPath("routines/daily/morning-brief.md"), {
    kind: "routine",
    cadence: { unit: "day", every: 1 },
    folder: "daily",
    name: "morning-brief",
  });
  assert.equal(routineFromPath("1-projects/daily/x.md"), null);
  assert.equal(routineFromPath("routines/daily/picture.png"), null);
  assert.equal(routineFromPath("my-routines/daily/x.md"), null);
  assert.equal(routineFromPath("routines/brief.md").kind, "unscheduled");
  assert.equal(routineFromPath("routines/daily/old/brief.md").kind, "unscheduled");
  assert.match(routineFromPath("routines/someday/brief.md").reason, /isn't a schedule/);
  assert.match(routineFromPath("routines/every-1-minute/brief.md").reason, /every 5 minutes/);
});

test("front matter is read only when it is closed", () => {
  assert.deepEqual(frontMatter("---\nat: 7:30 am\nOn: Friday\n---\nbody"), { at: "7:30 am", on: "Friday" });
  assert.deepEqual(frontMatter("---\nat: 7:30 am\nbody without a close"), {});
  assert.deepEqual(frontMatter("at: 7:30 am\n"), {});
  assert.deepEqual(frontMatter('---\nat: "9:00"\n---\n'), { at: "9:00" });
});

test("times and days are read the way people write them", () => {
  assert.deepEqual(parseTime("7:30 am"), { hour: 7, minute: 30 });
  assert.deepEqual(parseTime("7am"), { hour: 7, minute: 0 });
  assert.deepEqual(parseTime("12 pm"), { hour: 12, minute: 0 });
  assert.deepEqual(parseTime("12am"), { hour: 0, minute: 0 });
  assert.deepEqual(parseTime("19:00"), { hour: 19, minute: 0 });
  assert.deepEqual(parseTime("4:15 P.M."), { hour: 16, minute: 15 });
  assert.deepEqual(parseTime("noon"), { hour: 12, minute: 0 });
  assert.equal(parseTime("7"), null, "a bare number could be a minute; ask for words");
  assert.equal(parseTime("25:00"), null);
  assert.equal(parseTime("13pm"), null);
  assert.deepEqual(parseWeekdays("weekdays"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseWeekdays("Fridays"), [5]);
  assert.deepEqual(parseWeekdays("mon, wed and fri"), [1, 3, 5]);
  assert.equal(parseWeekdays("frydays"), null);
});

test("a line it can't read is a problem in words, never a silent default", () => {
  const daily = { unit: "day", every: 1 };
  const { settings, problems } = routineSettings("---\nat: half seven\non: frydays\nsend: email\n---\n", daily);
  assert.equal(settings.at, null);
  assert.equal(settings.days, null);
  assert.equal(settings.send, "text");
  assert.equal(problems.length, 3);
  assert.match(problems[0], /isn't a time/);
  assert.match(problems[1], /isn't a day/);
  assert.match(problems[2], /text, note or both/);

  const ok = routineSettings(
    "---\nat: 7:30 am\non: weekdays\nsend: both\nto: @sayo, @Seyi\npaused: yes\ntimezone: Europe/London\nuntil: it lands\n---\nDo it.",
    daily,
  );
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.settings, {
    at: { hour: 7, minute: 30 },
    days: [1, 2, 3, 4, 5],
    monthDay: null,
    send: "both",
    to: ["sayo", "seyi"],
    until: "it lands",
    paused: true,
    timeZone: "Europe/London",
  });

  assert.match(routineSettings("---\ntimezone: Mars/Base\n---\n", daily).problems[0], /isn't a time zone/);
  assert.equal(routineSettings("---\non: last\n---\n", { unit: "month", every: 1 }).settings.monthDay, -1);
  assert.match(routineSettings("---\nat: 9am\n---\n", { unit: "minute", every: 5 }).problems[0], /every few minutes/);
});

test("every N minutes falls on fixed marks, so a re-save doesn't move it", () => {
  const cadence = { unit: "minute", every: 5 };
  assert.equal(iso(nextRunAt(cadence, null, NY, Date.parse("2026-10-07T12:03:10Z"))), "2026-10-07T12:05:00.000Z");
  assert.equal(iso(nextRunAt(cadence, null, NY, Date.parse("2026-10-07T12:05:00Z"))), "2026-10-07T12:10:00.000Z");
});

test("daily runs at the local time in the routine's time zone", () => {
  const daily = { unit: "day", every: 1 };
  const at730 = { at: { hour: 7, minute: 30 } };
  // 07:30 in New York in October is 11:30 UTC.
  assert.equal(iso(nextRunAt(daily, at730, NY, Date.parse("2026-10-07T04:00:00Z"))), "2026-10-07T11:30:00.000Z");
  assert.equal(iso(nextRunAt(daily, at730, NY, Date.parse("2026-10-07T11:30:00Z"))), "2026-10-08T11:30:00.000Z");
  // No time written: 8 am.
  assert.equal(iso(nextRunAt(daily, null, NY, Date.parse("2026-10-07T04:00:00Z"))), "2026-10-07T12:00:00.000Z");
  // After the clocks change (1 Nov 2026), 7:30 am is 12:30 UTC.
  assert.equal(iso(nextRunAt(daily, at730, NY, Date.parse("2026-11-02T00:00:00Z"))), "2026-11-02T12:30:00.000Z");
  // The file's own time zone wins over the account's.
  const london = { at: { hour: 7, minute: 30 }, timeZone: "Europe/London" };
  assert.equal(iso(nextRunAt(daily, london, NY, Date.parse("2026-10-07T04:00:00Z"))), "2026-10-07T06:30:00.000Z");
});

test("weekdays skip the weekend", () => {
  const daily = { unit: "day", every: 1 };
  const settings = { at: { hour: 9, minute: 0 }, days: [1, 2, 3, 4, 5] };
  // Friday 2026-10-09 after 9 am → Monday 2026-10-12, 13:00 UTC.
  assert.equal(iso(nextRunAt(daily, settings, NY, Date.parse("2026-10-09T15:00:00Z"))), "2026-10-12T13:00:00.000Z");
});

test("weekly defaults to Monday; every 2 weeks keeps a fixed parity", () => {
  const weekly = { unit: "week", every: 1 };
  assert.equal(iso(nextRunAt(weekly, null, NY, Date.parse("2026-10-07T12:00:00Z"))), "2026-10-12T12:00:00.000Z");
  const friday4 = { at: { hour: 16, minute: 0 }, days: [5] };
  assert.equal(iso(nextRunAt(weekly, friday4, NY, Date.parse("2026-10-07T12:00:00Z"))), "2026-10-09T20:00:00.000Z");

  const fortnightly = { unit: "week", every: 2 };
  const a = nextRunAt(fortnightly, friday4, NY, Date.parse("2026-10-07T12:00:00Z"));
  const b = nextRunAt(fortnightly, friday4, NY, a);
  assert.equal((b - a) / 86400000, 14, "two weeks apart");
  // The same answer from any starting point inside the fortnight.
  assert.equal(nextRunAt(fortnightly, friday4, NY, a - 3 * 86400000), a);
});

test("monthly runs on the day named, and on the last day when the month is short", () => {
  const monthly = { unit: "month", every: 1 };
  assert.equal(iso(nextRunAt(monthly, null, NY, Date.parse("2026-10-07T12:00:00Z"))), "2026-11-01T13:00:00.000Z", "8 am on 1 Nov 2026 is after the clocks go back");
  const the31st = { monthDay: 31, at: { hour: 9, minute: 0 } };
  assert.equal(iso(nextRunAt(monthly, the31st, NY, Date.parse("2026-11-01T00:00:00Z"))), "2026-11-30T14:00:00.000Z");
  const last = { monthDay: -1, at: { hour: 9, minute: 0 } };
  assert.equal(iso(nextRunAt(monthly, last, NY, Date.parse("2027-02-01T00:00:00Z"))), "2027-02-28T14:00:00.000Z");
});

test("hourly runs on the hour, every 3 hours on hours divisible by 3", () => {
  const hourly = { unit: "hour", every: 1 };
  assert.equal(iso(nextRunAt(hourly, null, NY, Date.parse("2026-10-07T12:10:00Z"))), "2026-10-07T13:00:00.000Z");
  const every3 = { unit: "hour", every: 3 };
  // 12:10 UTC is 8:10 in New York; next local hour divisible by 3 is 9:00 = 13:00 UTC.
  assert.equal(iso(nextRunAt(every3, null, NY, Date.parse("2026-10-07T12:10:00Z"))), "2026-10-07T13:00:00.000Z");
  assert.equal(iso(nextRunAt(every3, null, NY, Date.parse("2026-10-07T13:00:00Z"))), "2026-10-07T16:00:00.000Z");
});

test("the schedule is said in words", () => {
  assert.equal(describeSchedule({ unit: "day", every: 1 }, { at: { hour: 7, minute: 30 } }), "Every day at 7:30 am");
  assert.equal(describeSchedule({ unit: "day", every: 1 }, { at: { hour: 9, minute: 0 }, days: [1, 2, 3, 4, 5] }), "Weekdays at 9 am");
  assert.equal(describeSchedule({ unit: "week", every: 1 }, { at: { hour: 16, minute: 0 }, days: [5] }), "Fridays at 4 pm");
  assert.equal(describeSchedule({ unit: "minute", every: 5 }, null), "Every 5 minutes");
  assert.equal(describeSchedule({ unit: "hour", every: 1 }, null), "Every hour");
  assert.equal(describeSchedule({ unit: "month", every: 1 }, { monthDay: -1 }), "Monthly on the last day at 8 am");
  assert.equal(describeSchedule({ unit: "week", every: 2 }, null), "Every 2 weeks on Mondays at 8 am");
});

test("run history lives in Context's own space, named after the routine", () => {
  assert.equal(routineRunsKey("routines/daily/morning-brief.md"), ".context/agent/routines/daily/morning-brief.json");
});
