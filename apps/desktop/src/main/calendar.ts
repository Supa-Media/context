/**
 * The calendar in the menu bar: the next meeting beside the icon, Join in the
 * menu, and one ask a minute before (boards j1-j3, 2026-10-27).
 *
 * The console reads the person's calendars and pushes today's meetings here;
 * this file only keeps the last list and acts on a press. **Nothing here
 * starts a recording on its own.** The ask is a notification with buttons,
 * and the recording starts only when one of them, or the menu's Join, is
 * pressed: the same consent as Record a meeting, which is the path it takes
 * (docs/decisions/meetings/joining-from-the-calendar.md).
 */

import { Notification, shell } from "electron";
import type { UpcomingMeetingView, UpcomingMeetings } from "@context/desktop-bridge";
import { safeJoinUrl } from "@context/meetings/scheduled";
import { menuBarTitle, nextUp, nudgeDue, nudgeWords } from "../core/calendar/upcoming.ts";
import type { MainActions, MainContext } from "./context.ts";

export function createCalendar(ctx: MainContext): Pick<MainActions, "setUpcoming" | "joinMeeting" | "calendarTick"> {
  /** What the menu bar said last, so a tick that changes nothing pushes nothing. */
  let shown: string | null = null;
  /** Held so a nudge is not collected before somebody answers it. */
  let nudge: Notification | null = null;

  function setUpcoming(upcoming: UpcomingMeetings): void {
    ctx.upcoming = upcoming;
    calendarTick();
    ctx.push();
  }

  async function joinMeeting(id: string | null, record: boolean): Promise<void> {
    const meeting =
      id === null ? nextUp(ctx.upcoming, Date.now()) : (ctx.upcoming.meetings.find((candidate) => candidate.id === id) ?? null);
    if (meeting === null) return;
    ctx.askedMeetings.add(meeting.id);
    nudge?.close();
    nudge = null;
    // Checked again at the moment of opening, not only when the list arrived.
    const url = safeJoinUrl(meeting.conferenceUrl);
    if (url !== null) await shell.openExternal(url);
    if (record && !ctx.controller.recording) await ctx.pressed("record", () => ctx.recordNow(meeting));
  }

  function ask(meeting: UpcomingMeetingView, now: number): void {
    ctx.askedMeetings.add(meeting.id);
    if (!Notification.isSupported()) return;
    const words = nudgeWords(meeting, now);
    const hasCall = meeting.conferenceUrl !== null;
    nudge = new Notification({
      title: words.title,
      body: words.body,
      silent: false,
      actions: hasCall
        ? [
            { type: "button", text: "Join and take notes" },
            { type: "button", text: "Join only" },
          ]
        : [{ type: "button", text: "Take notes" }],
      closeButtonText: "Not now",
    });
    // Only a button records. A click on the notification itself is how people
    // open an app, so it brings Context forward and starts nothing; closing
    // it, or Not now, does nothing at all.
    nudge.on("click", () => void ctx.openConsoleWindow());
    nudge.on("action", (_event, index) => void joinMeeting(meeting.id, index === 0));
    nudge.show();
  }

  function calendarTick(): void {
    const now = Date.now();
    const recording = ctx.controller.recording;
    if (!recording) {
      const due = nudgeDue(ctx.upcoming, now, ctx.askedMeetings);
      if (due !== null) ask(due, now);
    }
    const next = nextUp(ctx.upcoming, now);
    const title = next === null ? null : menuBarTitle(next, now);
    if (title !== shown) {
      shown = title;
      ctx.push();
    }
  }

  return { setUpcoming, joinMeeting, calendarTick };
}
