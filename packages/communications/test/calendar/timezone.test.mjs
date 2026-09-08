// Timezone rendering, including the DST boundary: two fixture instants either
// side of America/New_York's real 2026 transitions, so the test is pinned to
// an actual transition the IANA database carries rather than an assumption
// about how DST works.
//
//   spring forward: 2026-03-08 02:00 EST -> 03:00 EDT (transition at 07:00Z)
//   fall back:       2026-11-01 02:00 EDT -> 01:00 EST (transition at 06:00Z)

import {
  addCalendarDays,
  dateRange,
  isValidTimeZone,
  normalizeTimeZone,
  occursOn,
  zoneAbbreviation,
  zonedClock,
  zonedDateKey,
  zonedDayStartInstant,
} from "../../src/calendar/timezone.js";

export function runCalendarTimezoneChecks(check) {
  check("a real IANA zone validates", isValidTimeZone("America/New_York"));
  check("a made-up zone does not", !isValidTimeZone("Mars/Olympus_Mons"));
  check("an empty or non-string zone does not", !isValidTimeZone("") && !isValidTimeZone(undefined) && !isValidTimeZone(null));
  check("a bad zone normalizes to UTC rather than throwing", normalizeTimeZone("nonsense") === "UTC");
  check("a good zone normalizes to itself", normalizeTimeZone("America/New_York") === "America/New_York");

  check("zonedDateKey is YYYY-MM-DD", zonedDateKey("2026-09-07T14:00:00.000Z", "UTC") === "2026-09-07");
  check(
    "a date near midnight moves to the local day, not the UTC day",
    zonedDateKey("2026-09-08T02:00:00.000Z", "America/New_York") === "2026-09-07"
  );
  check("an unparseable instant returns null rather than throwing", zonedDateKey("not a date", "UTC") === null);

  check("zonedClock is 24-hour and zero-padded", zonedClock("2026-09-07T05:03:00.000Z", "UTC") === "05:03");
  check("midnight is 00:00, never 24:00", zonedClock("2026-09-07T00:00:00.000Z", "UTC") === "00:00");
  check("an unparseable instant clocks as --:--, never as midnight", zonedClock("garbage", "UTC") === "--:--");

  // -- the DST boundary itself --------------------------------------------
  check(
    "before spring-forward, the wall clock and the abbreviation both say EST",
    zonedClock("2026-03-08T06:00:00.000Z", "America/New_York") === "01:00" &&
      zoneAbbreviation("2026-03-08T06:00:00.000Z", "America/New_York") === "EST"
  );
  check(
    "one hour of UTC time later, past the spring transition, the same zone reads EDT",
    zonedClock("2026-03-08T08:00:00.000Z", "America/New_York") === "04:00" &&
      zoneAbbreviation("2026-03-08T08:00:00.000Z", "America/New_York") === "EDT"
  );
  check(
    "before fall-back, still EDT",
    zonedClock("2026-11-01T05:00:00.000Z", "America/New_York") === "01:00" &&
      zoneAbbreviation("2026-11-01T05:00:00.000Z", "America/New_York") === "EDT"
  );
  check(
    "after fall-back, the same calendar date reads EST",
    zonedClock("2026-11-01T07:00:00.000Z", "America/New_York") === "02:00" &&
      zoneAbbreviation("2026-11-01T07:00:00.000Z", "America/New_York") === "EST"
  );
  check(
    "the calendar date itself never moves for a DST transition",
    zonedDateKey("2026-03-08T06:00:00.000Z", "America/New_York") === "2026-03-08" &&
      zonedDateKey("2026-03-08T08:00:00.000Z", "America/New_York") === "2026-03-08"
  );

  // -- date arithmetic ------------------------------------------------------
  check("addCalendarDays adds plain calendar days", addCalendarDays("2026-09-07", 1) === "2026-09-08");
  check("...crossing a month boundary", addCalendarDays("2026-09-30", 1) === "2026-10-01");
  check("...crossing the DST spring-forward day itself, unaffected — dates have no clock", addCalendarDays("2026-03-07", 1) === "2026-03-08");
  check("negative days subtract", addCalendarDays("2026-09-07", -1) === "2026-09-06");
  check(
    "dateRange is half-open: [start, end)",
    JSON.stringify(dateRange("2026-09-07", "2026-09-10")) === JSON.stringify(["2026-09-07", "2026-09-08", "2026-09-09"])
  );
  check("dateRange of an empty span is empty", dateRange("2026-09-07", "2026-09-07").length === 0);

  // -- occursOn: the expansion `sync.js` and `render.js` both depend on ----
  check(
    "a same-day timed event occurs on one day",
    JSON.stringify(occursOn({ start: { dateTime: "2026-09-07T14:00:00.000Z" }, end: { dateTime: "2026-09-07T15:00:00.000Z" } }, "UTC")) ===
      JSON.stringify(["2026-09-07"])
  );
  check(
    "a one-day all-day event (Google's exclusive end) occurs on exactly that day",
    JSON.stringify(occursOn({ start: { date: "2026-09-07" }, end: { date: "2026-09-08" } }, "UTC")) === JSON.stringify(["2026-09-07"])
  );
  check(
    "a three-day all-day event occurs on all three days",
    JSON.stringify(occursOn({ start: { date: "2026-09-07" }, end: { date: "2026-09-10" } }, "UTC")) ===
      JSON.stringify(["2026-09-07", "2026-09-08", "2026-09-09"])
  );
  check(
    "an overnight event crossing local midnight occurs on both days",
    JSON.stringify(
      occursOn({ start: { dateTime: "2026-09-07T23:00:00.000Z" }, end: { dateTime: "2026-09-08T01:00:00.000Z" } }, "UTC")
    ) === JSON.stringify(["2026-09-07", "2026-09-08"])
  );
  check(
    "an event ending exactly at local midnight does not spill onto the next day",
    JSON.stringify(
      occursOn({ start: { dateTime: "2026-09-07T22:00:00.000Z" }, end: { dateTime: "2026-09-08T00:00:00.000Z" } }, "UTC")
    ) === JSON.stringify(["2026-09-07"])
  );
  check(
    "the local timezone decides the day, not UTC",
    JSON.stringify(
      occursOn(
        { start: { dateTime: "2026-09-08T02:00:00.000Z" }, end: { dateTime: "2026-09-08T03:00:00.000Z" } },
        "America/New_York"
      )
    ) === JSON.stringify(["2026-09-07"])
  );
  check(
    "occursOn is capped so a corrupt multi-year all-day event cannot run away",
    occursOn({ start: { date: "2026-01-01" }, end: { date: "2030-01-01" } }, "UTC").length <= 60
  );

  // -- when a day actually begins (adversarial review of PR #344) ----------
  //
  // The horizon is a set of dates on the OWNER'S wall clock, and a provider
  // query is a pair of instants. Converting one to the other by pasting
  // `T00:00:00.000Z` on the end is correct for exactly one zone, and wrong
  // silently everywhere else — see `apps/mcp/src/communications/calendar-google.js`.
  check(
    "a UTC day starts at its own midnight — the case the naive conversion got right",
    zonedDayStartInstant("2026-09-07", "UTC") === "2026-09-07T00:00:00.000Z"
  );
  check(
    "a Tokyo day starts NINE HOURS BEFORE UTC midnight, not nine hours after it",
    zonedDayStartInstant("2026-09-07", "Asia/Tokyo") === "2026-09-06T15:00:00.000Z"
  );
  check(
    "a New York day in summer starts four hours after UTC midnight",
    zonedDayStartInstant("2026-09-07", "America/New_York") === "2026-09-07T04:00:00.000Z"
  );
  check(
    "...and five in winter, because the offset is read for the instant, never fixed once",
    zonedDayStartInstant("2026-01-07", "America/New_York") === "2026-01-07T05:00:00.000Z"
  );
  check(
    "the day a zone springs forward still starts at its own midnight, an hour before the transition",
    zonedDayStartInstant("2026-03-08", "America/New_York") === "2026-03-08T05:00:00.000Z"
  );
  check(
    "the day a zone falls back starts at its own midnight too",
    zonedDayStartInstant("2026-11-01", "America/New_York") === "2026-11-01T04:00:00.000Z"
  );
  check(
    "a half-hour zone is not rounded to an hour",
    zonedDayStartInstant("2026-09-07", "Asia/Kolkata") === "2026-09-06T18:30:00.000Z"
  );
  check(
    "the instant it returns really is that date's first moment there, and the moment before is the day before",
    zonedDateKey(zonedDayStartInstant("2026-09-07", "Asia/Tokyo"), "Asia/Tokyo") === "2026-09-07" &&
      zonedDateKey(Date.parse(zonedDayStartInstant("2026-09-07", "Asia/Tokyo")) - 1, "Asia/Tokyo") === "2026-09-06"
  );
  check(
    "...and the same holds on the spring-forward day, where a one-pass conversion is off by the hour that moved",
    zonedDateKey(zonedDayStartInstant("2026-03-08", "America/New_York"), "America/New_York") === "2026-03-08" &&
      zonedDateKey(Date.parse(zonedDayStartInstant("2026-03-08", "America/New_York")) - 1, "America/New_York") ===
        "2026-03-07"
  );
  check(
    "a bad zone falls back to UTC rather than throwing, same rule as every other function here",
    zonedDayStartInstant("2026-09-07", "Mars/Olympus_Mons") === "2026-09-07T00:00:00.000Z"
  );
  check("a non-date returns null rather than an invalid instant", zonedDayStartInstant("not-a-date", "UTC") === null);

  // -- sabotage record --------------------------------------------------
  //
  // Broke `zoneAbbreviation` to always return the raw zone name (a plausible
  // "simplify" that drops the DST distinction) — measured, not assumed: **4**
  // checks failed, all four of the DST-boundary checks above (each asserts
  // both a clock and an abbreviation, so both transitions failed on their
  // abbreviation half). Every other check — the plain clock, the date key,
  // the arithmetic, `occursOn` — kept passing, which is exactly the failure
  // mode this fixture exists to catch: a note that shows the right *time* and
  // the wrong *zone label* reads as correct to anyone not doing the
  // arithmetic by hand.
}
