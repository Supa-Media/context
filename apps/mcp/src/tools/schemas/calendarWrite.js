/** The calendar tool. See `tools/calendarWrite.js` and `tools/calendarGate.js`. */
export function calendarToolDefinitions() {
  return [
    {
      name: "calendar_event",
      title: "Change the calendar",
      description:
        "Add, move or cancel one event on the person's own Google Calendar. It is never done straight away: the person is " +
        "shown this exact change and must say yes to it. Times carry their UTC offset (2026-10-20T15:00:00-04:00) or are " +
        "whole days (2026-10-20, end the day after); work the offset out from the person's time zone. create takes title, " +
        "start, end, and optional location and notes. move and cancel name the event by its exact title and its start as it " +
        "is now (from their calendar notes); move also takes new_start and new_end. Never an event with guests. " +
        "Only when the person asked for this change. At most 5 changes an hour and 20 a day.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "move", "cancel"] },
          title: { type: "string", description: "The event's title: the new one's, or the existing one's, exactly." },
          start: { type: "string", description: "create: when it starts. move or cancel: when it starts now." },
          end: { type: "string", description: "create only: when it ends." },
          new_start: { type: "string", description: "move only: when it starts after the move." },
          new_end: { type: "string", description: "move only: when it ends after the move." },
          location: { type: "string", description: "create only, optional." },
          notes: { type: "string", description: "create only, optional: the event's description." },
        },
        required: ["action", "title", "start"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}
