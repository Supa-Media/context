/**
 * MEETINGS TO JOIN — `src/scheduled.js`.
 *
 * The Join button opens a link from an invite, and an invite's words are
 * whoever sent it. So the first checks here are about which links it will
 * never open; the rest are about which events count as meetings at all.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines.
 *
 *   `safeJoinUrl` allowing http                                     1
 *   host check by `includes` rather than exact-or-subdomain         2
 *   declined events kept                                            1
 *   all-day events kept                                             1
 *   `nextMeeting` ignoring the lead                                 1
 */

import { callKindOf, callNameOf, joinUrlOf, mergeScheduled, nextMeeting, safeJoinUrl, scheduledMeetingOf } from "../src/scheduled.js";

const ME = { email: "seyi@example.test", self: true, responseStatus: "accepted" };
const ZAY = { email: "zay@example.test", name: "Zay" };

function google(overrides = {}) {
  return {
    account: "seyi@example.test",
    calendarId: "primary",
    eventId: "e1",
    title: "Leadership Weekly",
    description: "",
    location: "",
    meetingLink: "https://meet.google.com/abc-defg-hij",
    start: { dateTime: "2026-10-28T14:00:00-04:00" },
    end: { dateTime: "2026-10-28T15:00:00-04:00" },
    attendees: [ME, ZAY],
    organizer: null,
    status: "confirmed",
    recurringEventId: null,
    originalDate: null,
    ...overrides,
  };
}

export function runScheduledChecks(check) {
  /* ----------------------------- join links ----------------------------- */
  check("a Meet link is joinable", safeJoinUrl("https://meet.google.com/abc-defg-hij") === "https://meet.google.com/abc-defg-hij");
  check("a Zoom subdomain is joinable", safeJoinUrl("https://us02web.zoom.us/j/123?pwd=x") !== null);
  check("http is never opened", safeJoinUrl("http://meet.google.com/abc") === null);
  check("a look-alike host is not a call", safeJoinUrl("https://meet.google.com.evil.example/abc") === null);
  check("a host that only ends in the name is not a call", safeJoinUrl("https://notzoom.us/j/1") === null);
  check("a link with a login in it is refused", safeJoinUrl("https://user:pw@meet.google.com/abc") === null);
  check("a javascript: link is refused", safeJoinUrl("javascript:alert(1)") === null);
  check("a non-string is refused", safeJoinUrl(undefined) === null);
  check(
    "a Zoom link written in the description is found when the event has no conference",
    joinUrlOf({ meetingLink: null, location: "", description: "Join: https://acme.zoom.us/j/99, thanks" }) === "https://acme.zoom.us/j/99",
  );
  check(
    "an unknown link in the description is skipped for the call link after it",
    joinUrlOf({ meetingLink: null, description: "Agenda https://docs.example/x then https://teams.microsoft.com/l/meetup-join/1" }) ===
      "https://teams.microsoft.com/l/meetup-join/1",
  );
  check("a conference link on an unknown host is not used", joinUrlOf({ meetingLink: "https://evil.example/join" }) === null);

  check("a Meet link is a meet call", callKindOf("https://meet.google.com/abc") === "meet");
  check("a Zoom subdomain is a zoom call", callKindOf("https://acme.zoom.us/j/1") === "zoom");
  check("a Meet link is named Google Meet", callNameOf("https://meet.google.com/abc") === "Google Meet");
  check("...and a link off the allowlist is only ever 'the call'", callNameOf("https://meet.google.com.evil.example/x") === "the call");
  check("a link that is not a call is unknown", callKindOf("https://evil.example/zoom.us") === "unknown");

  /* ---------------------------- which events ---------------------------- */
  const meeting = scheduledMeetingOf(google());
  check("a call with a guest is a meeting", meeting !== null && meeting.conferenceUrl === "https://meet.google.com/abc-defg-hij");
  check("its times are instants", meeting?.startsAt === "2026-10-28T18:00:00.000Z" && meeting?.endsAt === "2026-10-28T19:00:00.000Z");
  check("its guests carry their names and who is me", meeting?.attendees.length === 2 && meeting.attendees[0].self === true && meeting.attendees[1].name === "Zay");
  check("it keeps the account it came from", meeting?.account === "seyi@example.test" && meeting?.id === "seyi@example.test:e1");
  check("an all-day event is not a meeting", scheduledMeetingOf(google({ start: { date: "2026-10-28" }, end: { date: "2026-10-29" } })) === null);
  check("a cancelled event is not a meeting", scheduledMeetingOf(google({ status: "cancelled" })) === null);
  check("a declined event is not a meeting", scheduledMeetingOf(google({ attendees: [{ ...ME, responseStatus: "declined" }, ZAY] })) === null);
  check("a solo hold with no call is not a meeting", scheduledMeetingOf(google({ meetingLink: null, attendees: [] })) === null);
  check("a room booking does not make a hold a meeting", scheduledMeetingOf(google({ meetingLink: null, attendees: [ME, { email: "room@resource.example", resource: true }] })) === null);
  check("an in-person meeting with a guest counts, with no link", (() => {
    const inPerson = scheduledMeetingOf(google({ meetingLink: null }));
    return inPerson !== null && inPerson.conferenceUrl === undefined;
  })());
  check("a call with nobody else still counts", scheduledMeetingOf(google({ attendees: [] })) !== null);
  check("an untitled event is called Meeting", scheduledMeetingOf(google({ title: "  " }))?.title === "Meeting");

  /* ----------------------------- one day -------------------------------- */
  const a = scheduledMeetingOf(google({ eventId: "a", start: { dateTime: "2026-10-28T16:00:00Z" }, end: { dateTime: "2026-10-28T17:00:00Z" } }));
  const b = scheduledMeetingOf(google({ eventId: "b", start: { dateTime: "2026-10-28T13:00:00Z" }, end: { dateTime: "2026-10-28T13:30:00Z" } }));
  const twin = scheduledMeetingOf(google({ account: "other@example.test", eventId: "z", start: { dateTime: "2026-10-28T16:00:00Z" }, end: { dateTime: "2026-10-28T17:00:00Z" } }));
  const outside = scheduledMeetingOf(google({ eventId: "c", start: { dateTime: "2026-10-30T13:00:00Z" }, end: { dateTime: "2026-10-30T14:00:00Z" } }));
  const day = mergeScheduled([a, twin, outside, b], { from: Date.parse("2026-10-28T04:00:00Z"), to: Date.parse("2026-10-29T04:00:00Z") });
  check("the day is soonest first", day.map((m) => m.id).join(",") === "seyi@example.test:b,other@example.test:z");
  check("one meeting both accounts were invited to shows once", day.length === 2);

  /* ----------------------------- next up -------------------------------- */
  const at = (iso) => Date.parse(iso);
  check("nothing is next an hour before", nextMeeting(day, at("2026-10-28T12:00:00Z")) === null);
  check("the meeting 5 minutes away is next", nextMeeting(day, at("2026-10-28T12:55:00Z"))?.id === "seyi@example.test:b");
  check("the meeting under way is next", nextMeeting(day, at("2026-10-28T13:10:00Z"))?.id === "seyi@example.test:b");
  check("a finished meeting is not next", nextMeeting(day, at("2026-10-28T13:40:00Z")) === null);
}
