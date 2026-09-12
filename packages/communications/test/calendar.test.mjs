// The calendar suite: same house style as `test/test.mjs` — one `check`
// counter, one `runXChecks(check)` per sibling file, a self-check that the
// contract is frozen and that no source here does I/O or knows what Google
// is, and a public-surface check against the calendar barrel.
//
// Run standalone with `node test/calendar.test.mjs`, or through the package's
// `npm test`, which runs this file as part of `test/test.mjs`.

import { readFileSync } from "node:fs";

import { runCalendarAnchorChecks } from "./calendar/anchors.test.mjs";
import { runCalendarContactChecks } from "./calendar/contacts.test.mjs";
import { runCalendarMeetingLinkChecks } from "./calendar/meetingLink.test.mjs";
import { runCalendarPathChecks } from "./calendar/paths.test.mjs";
import { runCalendarRenderChecks } from "./calendar/render.test.mjs";
import { runCalendarSyncChecks } from "./calendar/sync.test.mjs";
import { runCalendarTimezoneChecks } from "./calendar/timezone.test.mjs";

import * as calendar from "../src/calendar/index.js";
import {
  CALENDAR_DATE_PATTERN,
  CALENDAR_DAY_TYPE,
  CALENDAR_FOLDER,
  CALENDAR_FRONTMATTER_KEYS,
  DEFAULT_HORIZON_DAYS,
  EVENT_ANCHOR_HEX_LENGTH,
  EVENT_ANCHOR_PREFIX,
  EVENT_STATUSES,
} from "../src/calendar/protocol.js";

export function runCalendarChecks(check) {
  // -- the contract ---------------------------------------------------------
  check("the calendar folder is a fixed string under the one inbox root", CALENDAR_FOLDER === "0-inbox/calendar");
  check("the default horizon is a positive number of days", Number.isInteger(DEFAULT_HORIZON_DAYS) && DEFAULT_HORIZON_DAYS > 0);
  check("the frontmatter key list is frozen", Object.isFrozen(CALENDAR_FRONTMATTER_KEYS));
  check("...and the status list", Object.isFrozen(EVENT_STATUSES));
  check(
    "every frontmatter key is a plain lowercase word, never derived from an event",
    CALENDAR_FRONTMATTER_KEYS.every((key) => /^[a-z][a-z-]*$/.test(key))
  );
  check("...and there are no duplicates", new Set(CALENDAR_FRONTMATTER_KEYS).size === CALENDAR_FRONTMATTER_KEYS.length);
  check("a calendar-day note says what it is", CALENDAR_DAY_TYPE === "calendar-day");
  check("the anchor prefix and length match what anchors.js produces", EVENT_ANCHOR_PREFIX === "evt-" && EVENT_ANCHOR_HEX_LENGTH === 16);
  check("the date pattern is the ordinary YYYY-MM-DD shape", CALENDAR_DATE_PATTERN.test("2026-09-07") && !CALENDAR_DATE_PATTERN.test("09/07/2026"));
  check("cancelled is a real status, but never one this package writes to a note", EVENT_STATUSES.includes("cancelled"));

  // -- source-level self-checks, the same way test/test.mjs holds the rest of
  // the package to it -------------------------------------------------------
  const SOURCES = ["protocol.js", "anchors.js", "paths.js", "timezone.js", "render.js", "sync.js", "meetingLink.js", "contacts.js", "index.js"].map(
    (name) => readFileSync(new URL(`../src/calendar/${name}`, import.meta.url), "utf8")
  );
  check(
    "no calendar source knows what a tenant, a workspace or a user is",
    !SOURCES.some((source) => /tenants\/|workspaces\/|workspaceId|userId/.test(source))
  );
  check(
    "...and none of them does I/O or imports a provider SDK — the gateway's adapter owns that",
    !SOURCES.some((source) => /\bfetch\(|node:(?!fs)|require\(|googleapis|google-auth/i.test(source))
  );
  // A raw invisible character in source is exactly the bug this package's own
  // fencing exists to catch in *rendered* text -- one slipped into this
  // package's own source once, undetected until a byte-level diff, which is
  // why this checks codepoints rather than trusting the file to look right.
  const INVISIBLE_CODEPOINTS = new RegExp(
    "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]"
  );
  check(
    "no calendar source contains a raw control character or bidi/zero-width override",
    !SOURCES.some((source) => INVISIBLE_CODEPOINTS.test(source))
  );

  // -- the public surface -----------------------------------------------
  for (const name of [
    "CALENDAR_FOLDER",
    "DEFAULT_HORIZON_DAYS",
    "CALENDAR_FRONTMATTER_KEYS",
    "calendarDayNotePath",
    "isCalendarDayNotePath",
    "parseCalendarDayPath",
    "eventAnchor",
    "isEventAnchor",
    "renderCalendarDay",
    "planSyncRequest",
    "applyIncremental",
    "rebuildCache",
    "projectDay",
    "mergeEventCaches",
    "occursOn",
    "zonedClock",
    "zoneAbbreviation",
    "matchMeetingToEvent",
    "calendarEventLink",
    "attachEventLink",
    "readEventLink",
    "candidatesFromDay",
    "contactDraftsFromEvent",
  ]) {
    check(`the calendar barrel exports ${name}`, calendar[name] !== undefined);
  }
  check(
    "the calendar barrel exports no per-account folder helper — a calendar day is never nested under an account",
    !Object.keys(calendar).some((name) => /mailboxSlug|chooseAccount|accountFolder/i.test(name))
  );

  // -- the modules ------------------------------------------------------
  runCalendarPathChecks(check);
  runCalendarAnchorChecks(check);
  runCalendarTimezoneChecks(check);
  runCalendarRenderChecks(check);
  runCalendarSyncChecks(check);
  runCalendarMeetingLinkChecks(check);
  runCalendarContactChecks(check);
}

// Runnable standalone: `node test/calendar.test.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  let failures = 0;
  runCalendarChecks((label, cond) => {
    if (!cond) failures++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  });
  console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
