/**
 * The control plane's `/gateway/calendar/event`, for the stub. The real route
 * (`apps/convex/functions/lib/gatewayRoutes/calendarWrite.ts`) holds the
 * limits and changes the person's Google Calendar; this records what arrived
 * and answers as the stub's flags say: `calendarAddress` is the calendar that
 * may be changed (null for none), `calendarRefusal` answers every change
 * and check with that word instead, and `calendarGuests` are the guests on
 * the event a move or a cancel names: named back on a check, and a change
 * without `notify_guests` refused, as the real route does.
 *
 * `/gateway/calendar/days` (`gatewayRoutes/personCalendar.ts`) is answered by
 * `calendarDays`, a function of the request body returning the route's
 * answer; without one there is no calendar connected. The real clearance is
 * proved in Convex.
 */

export function createCalendarRoute(clearedEditor, flags) {
  /** Every call: the change, whether it was a check, and what was answered. */
  const calls = [];

  async function change(body) {
    const cleared = await clearedEditor(body);
    let answer;
    if (!cleared) answer = { ok: false, refused: "not_allowed" };
    else if (flags.calendarRefusal) answer = { ok: false, refused: flags.calendarRefusal };
    else if (!flags.calendarAddress) answer = { ok: false, refused: "no_calendar" };
    else {
      const guests = body.change?.action === "create" ? [] : (flags.calendarGuests ?? []);
      if (guests.length > 0 && body.check !== true && body.change?.notify_guests !== true) answer = { ok: false, refused: "has_guests" };
      else answer = { ok: true, calendar: flags.calendarAddress, ...(body.check === true && body.change?.action !== "create" ? { guests } : {}) };
    }
    calls.push({ accessToken: body.accessToken, change: body.change, check: body.check === true, answer });
    return answer;
  }

  async function days(body) {
    if (!(await clearedEditor(body))) return { ok: false, refused: "not_allowed" };
    return typeof flags.calendarDays === "function" ? flags.calendarDays(body) : { ok: false, refused: "no_calendar" };
  }

  /** The route's answer, or undefined for a path that is not this one. */
  async function handle(path, body) {
    if (path === "/gateway/calendar/event") return await change(body);
    if (path === "/gateway/calendar/days") return await days(body);
    return undefined;
  }

  return { calls, handle };
}
