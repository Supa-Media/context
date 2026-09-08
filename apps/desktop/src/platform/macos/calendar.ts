/**
 * What the calendar says is happening now.
 *
 * The signal that turns "a video app is open" into a meeting with a name and a
 * guest list. `detect()` does the correlation — matching a conference URL
 * against an open window is its job, not this file's — so all this collector
 * does is hand over the events near `now`, widened by the contract's own
 * `calendarLeadMs` and `calendarTrailMs` so that a person who joins four
 * minutes early is inside the same window the detector is reasoning about.
 *
 * ## Two deliberate reductions
 *
 * **Only the fields the contract names.** Title, times, attendees, conference
 * URL. Not the notes body, not the location, not the organiser's phone number,
 * not the description — all of which macOS will happily hand over and none of
 * which detection needs. A collector that reads the whole event is a collector
 * that puts somebody's dial-in PIN in a log line.
 *
 * **The URL is reduced the same way a window's is.** See `windows.ts`.
 *
 * ## Two permissions, not one — corrected after a Mac found the second
 *
 * This drives Calendar.app over JXA, which needs Automation permission to send
 * it Apple Events at all — and, separately, macOS gates the *data* those
 * events return by the same Calendars category `NSCalendarsFullAccessUsageDescription`
 * governs, exactly as if this were reading through EventKit directly. A build
 * can show Automation as granted and still get nothing back, because Calendars
 * is a second door: measured on the owner's Mac, on the shipped bundle
 * identifier, Automation for this target was granted and Calendars was at the
 * write-only tier macOS 14+ hands an app that declares only the legacy
 * `NSCalendarsUsageDescription` — see `docs/decisions/desktop-updates.md`,
 * "The one-way door", for the citations and what shipping the full-access key
 * does and does not fix for somebody already at that tier.
 *
 * **A calendar that refuses is not a calendar with nothing on it, and the
 * script now says which happened.** This used to be indistinguishable:
 * `calendarScript`'s per-calendar `try { ... } catch (e) { continue }` treated
 * a calendar that refuses to enumerate exactly like a calendar with nothing on
 * it right now, both producing the same empty array, and `collectSignals` in
 * `core/detection/collectors.ts` only marks a collector `degraded` when it
 * *throws* — so a write-only Calendars grant, which makes every calendar
 * refuse to enumerate while Automation itself stays granted (the two-door
 * split above), read as a quiet hour with no meetings. Confirmed on a real
 * Mac's own TCC store, not reasoned from the plist: Apple Events to Calendar
 * granted, Calendars data at the write-only tier, and the app reported no
 * meetings rather than reporting that it could not see any.
 *
 * The script now counts calendars and refusals rather than only calendars and
 * events. `parseCalendarEvents` throws when every calendar that exists
 * refused to enumerate — the shape a total data-access denial produces, since
 * a call that is merely idle returns an empty event list without throwing at
 * all — and stays silent (an ordinary, possibly-empty result) whenever at
 * least one calendar enumerated successfully, or there were no calendars to
 * ask in the first place. That second case is not evidence of a refusal; it
 * is evidence of nothing, which is the collector's honest answer when there is
 * nothing to correlate it against.
 *
 * It is also, separately, slow — enumerating a busy calendar can take
 * seconds, which is why it runs behind the shared timeout and is the collector
 * most likely to be reported as degraded for that reason alone. The right
 * implementation is EventKit through a small native helper,
 * which also gets a change notification instead of a five-second poll. It is
 * listed in `README.md` under "what is stubbed".
 */

import { DETECTOR_THRESHOLDS } from "../../core/contract.ts";
import type { Attendee, CalendarEvent } from "../../core/contract.ts";
import { osascript } from "../exec.ts";
import { redactUrl } from "./windows.ts";

/** The window of time the contract considers "now". */
export function calendarWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - DETECTOR_THRESHOLDS.calendarTrailMs),
    to: new Date(now.getTime() + DETECTOR_THRESHOLDS.calendarLeadMs),
  };
}

export function calendarScript(from: Date, to: Date): string {
  return `
    const cal = Application("Calendar");
    const from = new Date(${from.getTime()});
    const to = new Date(${to.getTime()});
    const out = [];
    const calendars = cal.calendars();
    const calendarCount = calendars.length;
    let refusedCount = 0;
    for (const c of calendars) {
      let events = [];
      try {
        events = c.events.whose({ _and: [{ startDate: { _lessThan: to } }, { endDate: { _greaterThan: from } }] })();
      } catch (e) { refusedCount += 1; continue; }
      for (const e of events) {
        try {
          out.push({
            id: String(e.uid()),
            title: String(e.summary() || ""),
            startsAt: e.startDate().toISOString(),
            endsAt: e.endDate().toISOString(),
            conferenceUrl: e.url() ? String(e.url()) : null,
          });
        } catch (err) {}
      }
    }
    JSON.stringify({ events: out, calendarCount, refusedCount });
  `;
}

/**
 * Parse the script's output into contract events.
 *
 * `attendees` comes back empty: Calendar.app's attendee list is reachable but
 * costs a round trip per event and is the single slowest thing this collector
 * could do. `detect()` may suggest attendees when it has them, and the note
 * gets them from the gateway's own calendar connection where one exists.
 * Returning `[]` is honest; inventing names from an event title would not be.
 *
 * **A total refusal throws instead of returning `[]`.** `calendarCount` and
 * `refusedCount` come from the script, not from this function guessing at
 * JXA's failure shape: when there is at least one calendar and every single
 * one of them refused to enumerate its events, that is Calendars data access
 * denied — write-only, or revoked outright — never an empty diary, because an
 * authorized call that is merely idle returns an empty event list without
 * throwing. `collectSignals` turns this throw into `degraded`, the same as
 * any other collector failure. Zero calendars at all is left alone: it is not
 * evidence of a refusal, it is evidence of nothing to ask.
 */
export function parseCalendarEvents(stdout: string): CalendarEvent[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("calendar collector returned something that is not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("calendar collector returned the wrong shape");
  }
  const payload = raw as Record<string, unknown>;
  const items = payload["events"];
  if (!Array.isArray(items)) throw new Error("calendar collector returned the wrong shape");

  const calendarCount = typeof payload["calendarCount"] === "number" ? payload["calendarCount"] : 0;
  const refusedCount = typeof payload["refusedCount"] === "number" ? payload["refusedCount"] : 0;
  if (calendarCount > 0 && refusedCount === calendarCount) {
    throw new Error("calendar access refused: every calendar failed to enumerate its events");
  }

  const events: CalendarEvent[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record["id"] === "string" ? record["id"] : "";
    const startsAt = typeof record["startsAt"] === "string" ? record["startsAt"] : "";
    const endsAt = typeof record["endsAt"] === "string" ? record["endsAt"] : "";
    if (id === "" || startsAt === "" || endsAt === "") continue;
    const attendees: Attendee[] = [];
    const event: CalendarEvent = {
      id,
      title: typeof record["title"] === "string" ? record["title"] : "",
      startsAt,
      endsAt,
      attendees,
    };
    const url = typeof record["conferenceUrl"] === "string" ? redactUrl(record["conferenceUrl"]) : undefined;
    if (url !== undefined) event.conferenceUrl = url;
    events.push(event);
  }
  return events;
}

export async function collectCalendarEvents(now: Date): Promise<CalendarEvent[]> {
  const { from, to } = calendarWindow(now);
  return parseCalendarEvents(await osascript(calendarScript(from, to), { timeoutMs: 4_500 }));
}
