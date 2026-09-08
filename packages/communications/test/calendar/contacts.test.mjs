// Attendees feed the Contacts graph through the same merge rules email does —
// this only checks that a calendar event produces the same shape
// `mergeContacts`/`canAutoMerge` in `../../src/contacts.js` already consume,
// and that folding two drafts together actually works end to end.

import { contactDraftsFromEvent } from "../../src/calendar/contacts.js";
import { canAutoMerge, mergeContacts, normalizeIdentifier } from "../../src/contacts.js";

function meetingEvent(overrides = {}) {
  return {
    account: "person@example.com",
    calendarId: "primary",
    eventId: "e1",
    title: "Quarterly review",
    status: "confirmed",
    start: { dateTime: "2026-09-07T14:00:00.000Z" },
    end: { dateTime: "2026-09-07T15:00:00.000Z" },
    attendees: [
      { name: "Adam Okonkwo", email: "adam@example.com" },
      { name: "", email: "priya@example.com" },
    ],
    organizer: { name: "Priya Shah", email: "priya@example.com" },
    ...overrides,
  };
}

export function runCalendarContactChecks(check) {
  const drafts = contactDraftsFromEvent(meetingEvent());
  check("one draft per named attendee", drafts.length === 2);
  check("every draft's identifier normalizes as a real email — the same rule contacts.js merges on", drafts.every((draft) => normalizeIdentifier(draft.identifiers[0]) !== null));
  check("an attendee with no display name falls back to their address", drafts.find((draft) => draft.identifiers[0].value === "priya@example.com")?.name === "priya@example.com");
  check(
    "the activity entry points at the real event anchor and the real day path",
    drafts[0].activity[0].path === "0-inbox/calendar/2026-09-07.md" && drafts[0].activity[0].channel === "calendar"
  );
  check("the activity label is the event's own title", drafts[0].activity[0].label === "Quarterly review");
  check("an untitled event still gets a label, never a blank one", contactDraftsFromEvent(meetingEvent({ title: "" }))[0].activity[0].label === "(untitled event)");

  check("a cancelled event produces no drafts — nobody's activity is credited to a meeting that did not happen", contactDraftsFromEvent(meetingEvent({ status: "cancelled" })).length === 0);
  check(
    "an attendee with no usable email is skipped rather than producing a dangling identifier",
    contactDraftsFromEvent(meetingEvent({ attendees: [{ name: "No Email" }], organizer: null })).length === 0
  );
  check("an organizer already listed as an attendee is not duplicated", contactDraftsFromEvent(meetingEvent()).filter((draft) => draft.identifiers[0].value === "priya@example.com").length === 1);
  const soloOrganizer = contactDraftsFromEvent(meetingEvent({ attendees: [], organizer: { name: "Solo Owner", email: "solo@example.com" } }));
  check("an organizer with no separate attendees is still drafted — a solo block still credits its own page", soloOrganizer.length === 1 && soloOrganizer[0].identifiers[0].value === "solo@example.com");

  // -- an all-day event: the date comes from start.date, not start.dateTime
  const allDayDrafts = contactDraftsFromEvent(meetingEvent({ start: { date: "2026-09-10" }, end: { date: "2026-09-11" } }));
  check("an all-day event's activity dates from its calendar date, not a dateTime that does not exist", allDayDrafts[0].activity[0].date === "2026-09-10");

  // -- folding into the existing merge machinery, end to end -----------------
  const existing = { name: "A. Okonkwo", identifiers: [{ kind: "email", value: "adam@example.com" }], activity: [{ date: "2026-01-01", path: "0-inbox/email/x/2026-01-01.md", anchor: "msg-a", label: "Old thread", channel: "email" }] };
  const draft = drafts.find((entry) => entry.identifiers[0].value === "adam@example.com");
  check("a calendar draft auto-merges with an existing contact sharing the address", canAutoMerge(existing, draft));
  const merged = mergeContacts(existing, draft);
  check(
    "merging keeps the human's own name and adds the calendar activity beside the email activity",
    merged.name === "A. Okonkwo" && merged.activity.length === 2 && merged.activity.some((entry) => entry.channel === "calendar")
  );

  // -- sabotage record --------------------------------------------------
  //
  // Dropped the `event.status === "cancelled"` guard — 1 check failed
  // directly, and it is the one that matters: a cancelled meeting would have
  // kept crediting activity to every invitee's contact page on every
  // regeneration until the note caught up, rather than disappearing with it.
}
