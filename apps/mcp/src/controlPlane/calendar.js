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
  "calendar_read_only",
  "hourly_limit",
  "daily_limit",
  "not_found",
  "ambiguous",
  "has_guests",
  "not_organizer",
  "not_invited",
  "other_calendar",
  "not_configured",
  "unavailable",
]);

const READ_REFUSALS = new Set(["invalid", "not_allowed", "no_calendar", "rate_limited", "reconnect_required", "unavailable"]);

/** A live read waits longer than the control plane's own bounded Google calls. */
const READ_TIMEOUT_MS = 25_000;

export function createCalendarMethods({ post }) {
  return {
    /**
     * Days of the person's own calendars, read live from Google
     * (`tools/calendarRead.js`): one entry per calendar per day, rendered
     * with its events fenced. Nothing of it is kept on either side.
     */
    async personCalendarDays(accessToken, expectedWorkspaceId, { date, days }) {
      const answer = await post("/gateway/calendar/days", { accessToken, expectedWorkspaceId, date, days }, { timeoutMs: READ_TIMEOUT_MS });
      const names = (list) => (Array.isArray(list) ? list.filter((entry) => typeof entry === "string") : []);
      if (answer?.ok === true && Array.isArray(answer.days)) {
        const valid = answer.days.filter(
          (day) => typeof day?.address === "string" && typeof day?.date === "string" && typeof day?.text === "string",
        );
        return { ok: true, days: valid, unanswered: names(answer.unanswered), reconnect: names(answer.reconnect) };
      }
      return { ok: false, refused: READ_REFUSALS.has(answer?.refused) ? answer.refused : "unavailable", reconnect: names(answer?.reconnect) };
    },
    async changePersonCalendar(accessToken, expectedWorkspaceId, change, { check = false } = {}) {
      const answer = await post("/gateway/calendar/event", { accessToken, expectedWorkspaceId, change, check });
      if (answer?.ok === true && typeof answer.calendar === "string") {
        // A move or cancel checked names who it would tell (`calendarGate.js` asks first when anybody).
        const guests = Array.isArray(answer.guests) ? answer.guests.filter((name) => typeof name === "string" && name !== "").slice(0, 10) : [];
        const meet = typeof answer.meet === "string" && /^https:\/\/meet\.google\.com\/[a-z0-9-]{1,64}$/i.test(answer.meet) ? answer.meet : null;
        return { ok: true, calendar: answer.calendar, guests, ...(meet !== null ? { meet } : {}) };
      }
      const refused = REFUSALS.has(answer?.refused) ? answer.refused : "unavailable";
      // The accounts Google said can only be read, by address alone (`gatewayRoutes/calendarWrite.ts`).
      const accounts = refused === "calendar_read_only" && Array.isArray(answer?.accounts)
        ? answer.accounts.filter((address) => typeof address === "string" && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(address)).slice(0, 5)
        : [];
      return { ok: false, refused, ...(accounts.length > 0 ? { accounts } : {}) };
    },
  };
}
