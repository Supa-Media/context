import { callKindOf, callNameOf } from "@context/meetings/scheduled";

import type { CalendarEvent, MeetingSource } from "./protocol";
import type { StartInput } from "./controller/types";

/**
 * What "Join and take notes" records for one meeting from the calendar
 * (docs/decisions/meetings/joining-from-the-calendar.md): the meeting is named
 * after the event, its guests come from the invite so speakers can be named,
 * and its source says which call it was.
 */
export function joinStartInput(meeting: CalendarEvent): Pick<StartInput, "title" | "attendees" | "source"> {
  const source: MeetingSource =
    meeting.conferenceUrl === undefined
      ? { kind: "in-person", calendarEventId: meeting.id }
      : { kind: callKindOf(meeting.conferenceUrl), url: meeting.conferenceUrl, calendarEventId: meeting.id };
  return {
    title: meeting.title,
    // The person themself is added by the controller from their own name.
    attendees: meeting.attendees.filter((attendee) => attendee.self !== true),
    source,
  };
}

/** The call's own name, for "Open Google Meet" and the row under a meeting. */
export function callName(url: string | undefined): string | null {
  return url === undefined ? null : callNameOf(url);
}

/** The label on the button that opens the call: "Open Google Meet". */
export function openCallLabel(url: string): string {
  return `Open ${callName(url) ?? "the call"}`;
}

/** "in 4 min", "now", "2:00 PM": when a meeting starts, said for a row. */
export function startsWhen(meeting: CalendarEvent, now: number, locale?: string): string {
  const start = Date.parse(meeting.startsAt);
  const end = Date.parse(meeting.endsAt);
  if (now >= start && now < end) return "now";
  const minutes = Math.round((start - now) / 60_000);
  if (minutes > 0 && minutes <= 60) return `in ${minutes} min`;
  return new Date(start).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}
