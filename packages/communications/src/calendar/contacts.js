// Attendees feed the Contacts graph through the same merge rules email does
// — `canAutoMerge`, `suggestMerge` and `mergeContacts` in `../contacts.js` —
// so this file adds no second merge policy. It only shapes an event's
// attendees into the `Contact`-like drafts those functions already consume:
// one draft per attendee, each carrying the identifier that makes it
// mergeable and one activity entry pointing at the event.
//
// An organizer with no separate attendee entry (Google always includes the
// organizer as an attendee when they invited others, but not when they are
// the sole attendee of their own event) is included as one more draft, so a
// solo calendar block still credits its owner's own contact page — though in
// practice the caller filters the owner's own identity out before merging,
// the same way it would filter their own address out of an email's `to`.

import { eventAnchor } from "./anchors.js";
import { calendarDayNotePath } from "./paths.js";

/**
 * One contact draft per attendee (and the organizer, if distinct), ready to
 * fold into an existing contact with `mergeContacts` from `../contacts.js`.
 *
 * @param {import("./protocol.js").CalendarEventInstance} event
 * @param {{root?: string}} [options]
 * @returns {Array<{name: string, identifiers: Array<{kind: "email", value: string}>, activity: Array<{date: string, path: string, anchor: string, label: string, channel: "calendar"}>}>}
 */
export function contactDraftsFromEvent(event, options = {}) {
  if (!event || event.status === "cancelled") return [];
  const date = typeof event.start?.date === "string" ? event.start.date : String(event.start?.dateTime ?? "").slice(0, 10);
  if (!date) return [];

  const anchor = eventAnchor(event);
  const path = calendarDayNotePath({ date }, options);
  const label = String(event.title ?? "").trim() || "(untitled event)";

  const people = [...(Array.isArray(event.attendees) ? event.attendees : [])];
  if (event.organizer?.email && !people.some((attendee) => attendee?.email === event.organizer.email)) {
    people.push(event.organizer);
  }

  return people
    .filter((person) => typeof person?.email === "string" && person.email.includes("@"))
    .map((person) => ({
      name: String(person.name ?? "").trim() || person.email,
      identifiers: [{ kind: "email", value: person.email }],
      activity: [{ date, path, anchor, label, channel: "calendar" }],
    }));
}
