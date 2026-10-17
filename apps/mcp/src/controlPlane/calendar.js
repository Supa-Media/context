/**
 * A change a person's AI makes to their own Google Calendar
 * (`tools/calendarWrite.js`): the control plane checks the limits, picks the
 * calendar (one of the token's person's own connections that granted
 * `calendar.events`), finds the event and makes the change. `check` asks only
 * whether it could go, and changes nothing.
 *
 * Answers `{ ok: true, calendar }` or `{ ok: false, refused }`.
 */

const REFUSALS = new Set([
  "invalid",
  "not_allowed",
  "no_calendar",
  "hourly_limit",
  "daily_limit",
  "not_found",
  "ambiguous",
  "has_guests",
  "not_configured",
  "unavailable",
]);

export function createCalendarMethods({ post }) {
  return {
    async changePersonCalendar(accessToken, expectedWorkspaceId, change, { check = false } = {}) {
      const answer = await post("/gateway/calendar/event", { accessToken, expectedWorkspaceId, change, check });
      if (answer?.ok === true && typeof answer.calendar === "string") return { ok: true, calendar: answer.calendar };
      return { ok: false, refused: REFUSALS.has(answer?.refused) ? answer.refused : "unavailable" };
    },
  };
}
