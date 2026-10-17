/**
 * The control plane's `/gateway/calendar/event`, for the stub. The real route
 * (`apps/convex/functions/lib/gatewayRoutes/calendarWrite.ts`) holds the
 * limits and changes the person's Google Calendar; this records what arrived
 * and answers as the stub's flags say: `calendarAddress` is the calendar that
 * may be changed (null for none), and `calendarRefusal` answers every change
 * and check with that word instead.
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
    else answer = { ok: true, calendar: flags.calendarAddress };
    calls.push({ accessToken: body.accessToken, change: body.change, check: body.check === true, answer });
    return answer;
  }

  /** The route's answer, or undefined for a path that is not this one. */
  async function handle(path, body) {
    return path === "/gateway/calendar/event" ? await change(body) : undefined;
  }

  return { calls, handle };
}
