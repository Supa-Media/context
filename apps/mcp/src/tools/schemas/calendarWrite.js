/** The calendar tool. See `tools/calendarWrite.js`, `tools/calendarEdit.js` and `tools/calendarGate.js`. */

const GUESTS = { type: "array", items: { type: "string" }, maxItems: 10 };

export function calendarToolDefinitions() {
  return [
    {
      name: "calendar_event",
      title: "Change the calendar",
      description:
        "Add, edit, move, cancel or answer one event on the person's own Google Calendar. When Tex makes it, it is done at once, with no " +
        "yes to ask for, unless the event has guests or invites some (or it is an RSVP, which tells the organizer): then the person is shown the change with the guests named, " +
        "and their yes or 👍 makes it and Google tells the guests. Another AI's change waits for the person's yes in the app. Times carry their UTC offset (2026-10-20T15:00:00-04:00) or are " +
        "whole days (2026-10-20, end the day after); work the offset out from the person's time zone. create takes title, " +
        "start, end, and optional location, notes, guests (email addresses to invite), meet (true adds a Google Meet link), reminders and recurrence. " +
        "edit, move, cancel and rsvp name the event by its exact title and its start as it is now (fetch calendar: shows both). " +
        "edit changes any of new_title, new_start + new_end, location, notes (\"\" takes either off), add_guests, remove_guests, meet, reminders, recurrence; " +
        "all_events: true changes every time a repeating event happens, not just that one. rsvp takes response. Never tell the person to make a change themselves. " +
        "Only when the person asked for this change. At most 20 changes an hour and 100 a day.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "edit", "move", "cancel", "rsvp"] },
          title: { type: "string", description: "The event's title: the new one's, or the existing one's, exactly." },
          start: { type: "string", description: "create: when it starts. Otherwise: when it starts now." },
          end: { type: "string", description: "create only: when it ends." },
          new_title: { type: "string", description: "edit only: its new title." },
          new_start: { type: "string", description: "edit or move: when it starts after the change." },
          new_end: { type: "string", description: "edit or move: when it ends after the change." },
          location: { type: "string", description: "create or edit: where it is (an address, a room or a link). On edit, \"\" takes it off." },
          notes: { type: "string", description: "create or edit: the event's description. On edit it replaces the old one; \"\" takes it off." },
          guests: { ...GUESTS, description: "create only, optional: the email addresses to invite. The person is asked before anyone is." },
          add_guests: { ...GUESTS, description: "edit only: email addresses to invite. The person is asked first." },
          remove_guests: { ...GUESTS, description: "edit only: email addresses to take off it. The person is asked first." },
          meet: { type: "boolean", description: "create or edit: true adds a Google Meet link, given back once it's made." },
          reminders: {
            type: "array",
            items: { type: "integer" },
            maxItems: 5,
            description: "create or edit: minutes before it starts to remind them, like [10, 60]; [] for none.",
          },
          recurrence: {
            type: "array",
            items: { type: "string" },
            maxItems: 5,
            description: 'create or edit: how it repeats, like ["RRULE:FREQ=WEEKLY;BYDAY=TU"] or ["RRULE:FREQ=DAILY;COUNT=5"]. On edit, [] stops it repeating.',
          },
          all_events: { type: "boolean", description: "edit, move, cancel or rsvp of a repeating event: true for every time it happens, not just this one." },
          response: { type: "string", enum: ["accepted", "declined", "tentative"], description: "rsvp only: their answer to the invite." },
          calendar: {
            type: "string",
            description: "Optional: which of their connected Google accounts, by address (fetch calendar: names each). create puts it there; otherwise only that one is searched.",
          },
          notify_guests: { type: "boolean", description: "Leave out: Context sets it on a change the person said yes to." },
        },
        required: ["action", "title", "start"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}
