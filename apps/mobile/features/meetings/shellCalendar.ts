import { getDesktopBridge, type UpcomingMeetingView } from "@context/desktop-bridge";

import type { CalendarEvent } from "./protocol";

/**
 * How long before a meeting the Mac app asks, until Settings › Meetings
 * chooses otherwise: a minute (board j3, 2026-10-27).
 */
export const DEFAULT_ASK_BEFORE_MS = 60 * 1000;

/** One meeting as the menu bar takes it: the person themself is not a guest. */
export function upcomingView(meeting: CalendarEvent): UpcomingMeetingView {
  return {
    id: meeting.id,
    title: meeting.title,
    startsAt: meeting.startsAt,
    endsAt: meeting.endsAt,
    conferenceUrl: meeting.conferenceUrl ?? null,
    attendees: meeting.attendees
      .filter((attendee) => attendee.self !== true && typeof attendee.email === "string")
      .map((attendee) => ({ name: attendee.name, email: attendee.email as string })),
  };
}

/**
 * Hand today's meetings to the Mac app's menu bar, when this page is in one
 * that can take them (bridge version 9). Silent everywhere else: a browser, a
 * phone, an older Mac app. The shell keeps them in memory and checks every
 * link again; nothing it is handed starts a recording.
 */
export function tellShellUpcoming(meetings: readonly CalendarEvent[], askBeforeMs: number | null = DEFAULT_ASK_BEFORE_MS): void {
  const calendar = getDesktopBridge()?.calendar;
  if (calendar === undefined) return;
  try {
    calendar.setUpcoming({ meetings: meetings.map(upcomingView), askBeforeMs });
  } catch {
    // The menu bar is a convenience; the console's own Join still works.
  }
}
