/**
 * The menu bar's next meeting and its one-minute ask (`core/calendar/upcoming.ts`).
 *
 * The list crosses from a page served from the network, so the checks that
 * matter are the ones about what the shell refuses: a link off the join-host
 * allowlist never becomes something Join opens, and a page that sends a bad
 * ask time does not switch the reminder off.
 *
 * ## Sabotage record
 *
 *   `upcomingFrom` keeping the page's conferenceUrl unchecked                 3
 *     (two here, one in `consoleBridge/ipcCensus.test.mjs`)
 *   an unknown askBeforeMs read as `null` (never ask)                         2
 *   `nudgeDue` ignoring `asked`                                               1
 *   presentation showing nextUp while recording                               1
 */

import {
  DEFAULT_ASK_BEFORE_MS,
  menuBarTitle,
  meetingDetail,
  nextUp,
  nudgeDue,
  nudgeWords,
  upcomingFrom,
} from "../src/core/calendar/upcoming.ts";
import { trayPresentation } from "../src/core/tray/presentation.ts";

const NOW = Date.parse("2026-10-28T15:56:00Z");
const at = (minutes) => new Date(NOW + minutes * 60_000).toISOString();

function meeting(overrides = {}) {
  return {
    id: "work@example.test:evt1",
    title: "Leadership Weekly",
    startsAt: at(4),
    endsAt: at(64),
    conferenceUrl: "https://meet.google.com/abc-defg-hij",
    attendees: [
      { name: "Ruth", email: "ruth@example.test" },
      { name: "Zay", email: "zay@example.test" },
      { name: "Ada", email: "ada@example.test" },
    ],
    ...overrides,
  };
}

export function runCalendarUpcomingChecks(check) {
  const read = upcomingFrom({ meetings: [meeting()], askBeforeMs: 60_000 });
  check("a well-formed push is kept", read.meetings.length === 1 && read.meetings[0].title === "Leadership Weekly");
  check("...with its call link", read.meetings[0].conferenceUrl === "https://meet.google.com/abc-defg-hij");

  const evil = upcomingFrom({
    meetings: [
      meeting({ conferenceUrl: "https://meet.google.com.evil.example/join" }),
      meeting({ id: "b", conferenceUrl: "javascript:alert(1)" }),
    ],
  });
  check("A LINK OFF THE ALLOWLIST IS NEVER SOMETHING JOIN OPENS", evil.meetings[0].conferenceUrl === null);
  check("...nor a script URL", evil.meetings[1].conferenceUrl === null);

  const junk = upcomingFrom({
    meetings: [
      null,
      "x",
      meeting({ id: "" }),
      meeting({ id: "bad-times", startsAt: "soon" }),
      meeting({ id: "backwards", startsAt: at(10), endsAt: at(5) }),
      meeting({ id: "ok", title: "   ", attendees: [{ email: "" }, { name: "No email" }, { email: "a@example.test" }] }),
    ],
  });
  check("unreadable meetings are dropped rather than repaired", junk.meetings.map((m) => m.id).join() === "ok");
  check("...a blank title reads as Meeting", junk.meetings[0].title === "Meeting");
  check("...and a guest with no address is dropped, one with no name is named by it", junk.meetings[0].attendees.length === 1 && junk.meetings[0].attendees[0].name === "a@example.test");

  const many = upcomingFrom({ meetings: Array.from({ length: 80 }, (_, i) => meeting({ id: `m${i}` })) });
  check("at most fifty meetings are kept", many.meetings.length === 50);

  check("an ask time that is not a choice falls back to a minute, never to never", upcomingFrom({ meetings: [], askBeforeMs: 7 }).askBeforeMs === DEFAULT_ASK_BEFORE_MS);
  check("...and a missing one too", upcomingFrom({ meetings: [] }).askBeforeMs === DEFAULT_ASK_BEFORE_MS);
  check("null is how a person says don't ask", upcomingFrom({ meetings: [], askBeforeMs: null }).askBeforeMs === null);
  check("five minutes is a choice", upcomingFrom({ meetings: [], askBeforeMs: 300_000 }).askBeforeMs === 300_000);
  check("a push that is not an object is an empty day", upcomingFrom("nonsense").meetings.length === 0);

  // -- the menu bar ------------------------------------------------------------
  const soon = upcomingFrom({ meetings: [meeting()] });
  check("four minutes out, the menu bar names it", nextUp(soon, NOW)?.id === "work@example.test:evt1");
  check("...as 'Leadership Weekly · 4 min'", menuBarTitle(nextUp(soon, NOW), NOW) === "Leadership Weekly · 4 min");
  check("...and 'now' once it has started", menuBarTitle(soon.meetings[0], NOW + 5 * 60_000) === "Leadership Weekly · now");
  check("half an hour out, it names nothing yet", nextUp(upcomingFrom({ meetings: [meeting({ startsAt: at(30), endsAt: at(60) })] }), NOW) === null);
  check("thirty seconds out reads 1 min, never 0 min", menuBarTitle(meeting({ startsAt: new Date(NOW + 30_000).toISOString() }), NOW).endsWith("· 1 min"));
  const long = menuBarTitle(meeting({ title: "Supa Leadership Weekly with the whole team" }), NOW);
  check("a long title is shortened so the menu bar keeps room", long.startsWith("Supa Leadership Weekly".slice(0, 21)) && long.includes("…") && long.length <= 30);

  check("the detail names the call and counts the person in", meetingDetail(soon.meetings[0]) === "Google Meet · 4 people");
  check("...and a room says it has no link", meetingDetail(meeting({ conferenceUrl: null, attendees: [{ name: "Ruth", email: "ruth@example.test" }] })) === "No call link · 2 people");

  // -- the ask -----------------------------------------------------------------
  const minute = upcomingFrom({ meetings: [meeting({ startsAt: at(1), endsAt: at(30) })], askBeforeMs: 60_000 });
  check("a minute before, the app asks", nudgeDue(minute, NOW, new Set())?.id === "work@example.test:evt1");
  check("...once: a meeting already asked about is not asked again", nudgeDue(minute, NOW, new Set(["work@example.test:evt1"])) === null);
  check("four minutes before, a one-minute ask waits", nudgeDue(upcomingFrom({ meetings: [meeting()], askBeforeMs: 60_000 }), NOW, new Set()) === null);
  check("...and a five-minute ask does not", nudgeDue(upcomingFrom({ meetings: [meeting()], askBeforeMs: 300_000 }), NOW, new Set()) !== null);
  check("don't ask means never", nudgeDue(upcomingFrom({ meetings: [meeting({ startsAt: at(1) })], askBeforeMs: null }), NOW, new Set()) === null);
  check("a Mac that woke a minute late still asks", nudgeDue(minute, NOW + 2 * 60_000 - 1, new Set()) !== null);
  check("...but not ten minutes into the meeting", nudgeDue(minute, NOW + 11 * 60_000, new Set()) === null);
  check("the nudge says when", nudgeWords(minute.meetings[0], NOW).title === "Leadership Weekly starts in 1 min");
  check("...and says it is starting once it has", nudgeWords(minute.meetings[0], NOW + 90_000).title === "Leadership Weekly is starting");

  // -- the menu bar's own states win ------------------------------------------
  check("idle shows the next meeting beside the icon", trayPresentation({ state: "idle", nextUp: "Leadership Weekly · 4 min" }).title === "Leadership Weekly · 4 min");
  check("...armed too", trayPresentation({ state: "armed", nextUp: "Leadership Weekly · 4 min" }).title === "Leadership Weekly · 4 min");
  check(
    "A RECORDING'S TIMER IS NEVER REPLACED BY THE CALENDAR",
    trayPresentation({ state: "recording", elapsedMs: 42_000, nextUp: "Leadership Weekly · now" }).title === "00:42",
  );
  check("...nor a detected meeting's ask", trayPresentation({ state: "detected", nextUp: "Leadership Weekly · now" }).title === "");
}

/*
  AND THE ONE RULE THE MAIN-PROCESS HALF HAS TO KEEP, READ FROM ITS SOURCE.

  `main/calendar.ts` needs Electron to run, so what is checked is its shape:
  a recording starts in exactly one place, behind the `record` a press
  passed, and never from a tick, an arriving list, or a nudge being shown.
*/
import { readFileSync } from "node:fs";

export function runCalendarMainShapeChecks(check) {
  const source = readFileSync(new URL("../src/main/calendar.ts", import.meta.url), "utf8");
  const starts = source.match(/recordNow\(/g) ?? [];
  check("the calendar starts a recording in exactly one place", starts.length === 1);
  check(
    "...behind the press's own `record`",
    /if \(record && !ctx\.controller\.recording\) await ctx\.pressed\("record", \(\) => ctx\.recordNow\(meeting\)\)/.test(source),
  );
  const tick = source.slice(source.indexOf("function calendarTick"), source.indexOf("return { setUpcoming"));
  check("A TICK NEVER JOINS OR RECORDS — it only asks", !tick.includes("joinMeeting") && !tick.includes("recordNow"));
  check("closing the ask does nothing", !/nudge\.on\("close"/.test(source));
  check(
    "A CLICK ON THE NOTIFICATION ITSELF STARTS NOTHING — only its buttons join",
    /nudge\.on\("click", \(\) => void ctx\.openConsoleWindow\(\)\)/.test(source),
  );
  check("the link is checked again at the moment it is opened", /safeJoinUrl\(meeting\.conferenceUrl\)/.test(source));
}
