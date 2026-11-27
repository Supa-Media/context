/**
 * `POST /gateway/calendar/days`: a run of days of a person's own Google
 * calendars, read live (`functions/personCalendar.ts`).
 *
 * Body `{ accessToken, expectedWorkspaceId, date, days?, account? }` answers
 * `{ ok: true, days: [{ address, date, timezone, events, text }], unanswered?, reconnect?, aiAccess? }`,
 * one entry per calendar per day, where `text` is the day rendered as the
 * calendar day note used to be (events fenced as untrusted, since an event's
 * words are whoever sent the invite). Or `{ ok: false, refused }`.
 *
 * `account` names one of the person's connected Google addresses, and then
 * only that calendar is read; one they have not connected is refused
 * (`other_calendar`) and no other calendar is read in its place. Left out,
 * every connected calendar is read, as before.
 *
 * Nothing read here is stored or logged: a log line carries an outcome and a
 * count, never a title, a guest or a time.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import { timeoutFetch } from "../filesFns/forwardSyncSupport";
import { MAX_LIVE_CALENDAR_DAYS, readCalendarDays } from "../../../../mcp/src/communications/calendarLive.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ACCOUNT = 320;

/** The chosen address, trimmed and lowercased; undefined when none was given; null when not a usable one. */
export function chosenAccount(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const account = value.trim().toLowerCase();
  return account === "" || account.length > MAX_ACCOUNT || !account.includes("@") ? null : account;
}

function log(fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ event: "person_calendar", ...fields }));
}

type Calendar = { connectionId: Id<"googleConnections">; address: string; freeBusy?: true };

type Day = { address: string; timezone: string; date: string; events: number; busy: { start: string; end: string }[]; allDay: number; text: string };

/** An instant as the calendar's own wall clock, "HH:MM". */
function wallClock(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/**
 * A day of a calendar shared with a group chat, read on a turn its own person did not ask for (Dev2, 2026-11-27: "by
 * default we should share free and busy"): when it is busy, on its own wall clock, and how many all-day events it has, as data. No title, place, guest or description:
 * the rendered day (`text`) is replaced, so nothing of an event's words reaches the turn.
 */
export function freeBusyDay(day: Day): Day {
  const busy = day.busy.map((slot) => ({ from: wallClock(slot.start, day.timezone), to: wallClock(slot.end, day.timezone) }));
  return {
    ...day,
    text: JSON.stringify({ free_busy_only: true, calendar: day.address, date: day.date, timezone: day.timezone, busy, all_day_events: day.allDay }),
  };
}

export async function gatewayPersonCalendarDaysHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const date = typeof body.date === "string" ? body.date : "";
  const days = body.days === undefined ? 1 : body.days;
  const account = chosenAccount(body.account);
  if (accessToken === null || expected === null) return json({ ok: false, refused: "not_allowed" });
  if (account === null) return json({ ok: false, refused: "invalid" });
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return json({ ok: false, refused: "invalid" });
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_LIVE_CALENDAR_DAYS) {
    return json({ ok: false, refused: "invalid" });
  }

  const claimed = await ctx.runMutation(internal.functions.personCalendar.claimPersonCalendarRead, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
    ...(account === undefined ? {} : { account }),
  });
  if (!claimed.ok) {
    log({ outcome: "refused", reason: claimed.refused });
    return json({ ok: false, refused: claimed.refused, ...("reconnect" in claimed && claimed.reconnect ? { reconnect: claimed.reconnect } : {}), ...("aiAccess" in claimed && claimed.aiAccess ? { aiAccess: claimed.aiAccess } : {}) });
  }

  // A fresh fence nonce per answer: a guest who writes a closing fence into
  // an invite cannot guess it.
  const nonce = `live:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const unanswered: string[] = [];
  const perCalendar = await Promise.all(
    claimed.calendars.map(async (calendar: Calendar) => {
      const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, { role: "agent" as const,
        connectionId: calendar.connectionId,
      });
      if (minted === null) {
        unanswered.push(calendar.address);
        return [];
      }
      try {
        const read = await readCalendarDays({
          fetchImpl: timeoutFetch,
          accessToken: minted.accessToken,
          account: calendar.address,
          from: date,
          days: days as number,
          nonce,
          now,
        });
        const readDays = read.days.map((day) => ({ address: calendar.address, timezone: read.timezone, ...day }));
        // Anyone but the calendar's own person gets free and busy times only: no event's words leave here (`freeBusyDay`).
        return calendar.freeBusy === true ? readDays.map(freeBusyDay) : readDays;
      } catch (error) {
        unanswered.push(calendar.address);
        log({ outcome: "google_error", status: Number((error as { status?: unknown })?.status) || 0 });
        return [];
      }
    }),
  );
  const answered = perCalendar.flat();
  log({ outcome: "ok", calendars: claimed.calendars.length, failed: unanswered.length, days: answered.length });
  if (answered.length === 0 && unanswered.length > 0) {
    return json({ ok: false, refused: "unavailable", ...(claimed.reconnect.length > 0 ? { reconnect: claimed.reconnect } : {}), ...(claimed.aiAccess ? { aiAccess: claimed.aiAccess } : {}) });
  }
  return json({
    ok: true,
    days: answered,
    ...(unanswered.length > 0 ? { unanswered } : {}),
    ...(claimed.reconnect.length > 0 ? { reconnect: claimed.reconnect } : {}),
    ...(claimed.aiAccess ? { aiAccess: claimed.aiAccess } : {}),
  });
}
