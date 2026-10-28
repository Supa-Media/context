import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { nextMeeting, NEXT_MEETING_LEAD_MS } from "@context/meetings/scheduled";

import type { CalendarEvent } from "./protocol";
import { tellShellUpcoming } from "./shellCalendar";

/**
 * The meetings on the person's own calendars today, for "Join and take notes"
 * (docs/decisions/meetings/joining-from-the-calendar.md).
 *
 * One store, filled by one source mounted beside `useMeetingsSetup` in the app
 * gate, and read by every surface that offers Join: the Meetings tab, the
 * sidebar's next-up row, the meetings list. A store rather than a hook per
 * surface so three surfaces are one read of Google, not three, and so a
 * surface needs no Convex client to render (the demo console and the render
 * tests have none).
 *
 * Read live from Google on every refresh, never kept: nothing here is written
 * anywhere but memory.
 */

export interface ScheduledMeetings {
  /** `idle` before the first answer, `ready` after one, `none` with no calendar connected. */
  status: "idle" | "ready" | "none";
  /** Today's meetings, soonest first. */
  meetings: readonly CalendarEvent[];
  /** Calendars whose sign-in Google stopped honouring, by address. */
  reconnect: readonly string[];
}

const EMPTY: ScheduledMeetings = Object.freeze({ status: "idle", meetings: Object.freeze([]), reconnect: Object.freeze([]) });

let state: ScheduledMeetings = EMPTY;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ScheduledMeetings {
  return state;
}

/** Replace what the surfaces show. Exported for the source and for tests. */
export function setScheduledMeetings(next: ScheduledMeetings): void {
  state = next;
  for (const listener of listeners) listener();
  // The Mac app's menu bar names the same meetings (boards j1-j3).
  tellShellUpcoming(next.meetings);
}

/** Back to nothing known, on sign-out. */
export function clearScheduledMeetings(): void {
  if (state !== EMPTY) setScheduledMeetings(EMPTY);
}

export function useScheduledMeetings(): ScheduledMeetings {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The meeting the sidebar row names now, or null. */
export function useNextMeeting(now: number): CalendarEvent | null {
  const { meetings } = useScheduledMeetings();
  return nextMeeting(meetings, now === 0 ? Date.now() : now, NEXT_MEETING_LEAD_MS);
}

/** How often the day is asked of Google again while the app is open. */
export const SCHEDULED_REFRESH_MS = 5 * 60 * 1000;

/** Local midnight to the next one, around `now`: "today" on this device's clock. */
export function todayWindow(now: number): { from: number; to: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.getTime(), to: end.getTime() };
}

/**
 * Keep the store filled while somebody is signed in: on mount, every five
 * minutes, and when the app comes back to the front.
 *
 * `enabled` rather than a conditional call, as `useMeetingsSetup` argues: the
 * hook runs on every render, and what waits for a session is the request.
 */
export function useScheduledMeetingsSource({ enabled }: { enabled: boolean }): void {
  const convex = useConvex();
  useEffect(() => {
    if (!enabled) {
      clearScheduledMeetings();
      return;
    }
    let stopped = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const answer = await convex.action(api.functions.meetingCalendar.upcomingMeetings, todayWindow(Date.now()));
        if (stopped) return;
        if (answer.ok) {
          setScheduledMeetings({ status: "ready", meetings: answer.meetings, reconnect: answer.reconnect });
        } else if (answer.refused === "no_calendar") {
          setScheduledMeetings({ status: "none", meetings: [], reconnect: [] });
        }
        // Anything else keeps what was there: a Google hiccup is not an empty day.
      } catch {
        // Offline or signed out mid-request: the next refresh asks again.
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), SCHEDULED_REFRESH_MS);
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh();
    });
    return () => {
      stopped = true;
      clearInterval(timer);
      appState.remove();
    };
  }, [convex, enabled]);
}
