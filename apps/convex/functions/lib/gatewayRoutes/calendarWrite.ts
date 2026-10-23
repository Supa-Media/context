/**
 * `POST /gateway/calendar/event`: add, move or cancel one event on the
 * primary Google Calendar of the person whose token this is
 * (`lib/calendarWrite.ts`).
 *
 * Body `{ accessToken, expectedWorkspaceId, change, check? }`. Answers
 * `{ ok: true, calendar, guests?, meet? }` (with `check`, nothing changes; a
 * move or cancel checked names the event's guests, a create its invitees; a
 * create with a Meet answers its link) or `{ ok: false, refused }`.
 *
 * The gateway makes Tex's change to an event nobody else is on at once, and
 * holds any other for the person's yes (`apps/mcp/src/tools/calendarGate.js`).
 * Decided here: the calendar is one of the token's person's own connections
 * that granted `calendar.events`, the limits hold, and a move or a cancel
 * reaches exactly one event. One with guests is changed only with
 * `notify_guests`, and then Google tells them (`sendUpdates=all`); otherwise
 * `sendUpdates=none`. A new event invites guests only with it too, and gets a
 * Google Meet with `meet` (`conferenceDataVersion=1`). Nothing of the event is stored or logged; Google's
 * error body can quote it, so only a status is.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import type { CalendarChange } from "../calendarWrite";
import { googleTime, guestNames, hasGuests, matchingEvents, meetLink, readCalendarChange, searchWindow } from "../calendarWrite";

const EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

function log(fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ event: "calendar_write", ...fields }));
}

type Found = { ok: true; eventId: string | null; guests: string[] } | { ok: false; refused: "not_found" | "ambiguous" | "has_guests" | "unavailable" };

/** The one event a move or a cancel names, or why there is not exactly one. */
async function findEvent(accessToken: string, change: CalendarChange, check = false): Promise<Found> {
  if (change.action === "create") return { ok: true, eventId: null, guests: [] };
  const query = new URLSearchParams({ ...searchWindow(change.start), singleEvents: "true", q: change.title, maxResults: "50" });
  const response = await fetch(`${EVENTS_ENDPOINT}?${query}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    log({ outcome: "http_error", stage: "find", status: response.status });
    return { ok: false, refused: "unavailable" };
  }
  const listed = (await response.json().catch(() => null)) as { items?: unknown } | null;
  const matches = matchingEvents(listed?.items, change);
  if (matches.length === 0) return { ok: false, refused: "not_found" };
  if (matches.length > 1) return { ok: false, refused: "ambiguous" };
  const guests = hasGuests(matches[0]!) ? guestNames(matches[0]!) : [];
  if (hasGuests(matches[0]!) && !change.notifyGuests && !check) return { ok: false, refused: "has_guests" };
  return { ok: true, eventId: matches[0]!.id as string, guests: hasGuests(matches[0]!) && guests.length === 0 ? ["a guest"] : guests };
}

/** The one request that makes the change. */
function changeRequest(change: CalendarChange, eventId: string | null): { url: string; method: string; body?: string } {
  const quiet = change.notifyGuests ? "?sendUpdates=all" : "?sendUpdates=none";
  if (change.action === "create") {
    return {
      url: `${EVENTS_ENDPOINT}${quiet}${change.meet ? "&conferenceDataVersion=1" : ""}`,
      method: "POST",
      body: JSON.stringify({
        summary: change.title,
        start: googleTime(change.start),
        end: googleTime(change.end!),
        ...(change.location !== null ? { location: change.location } : {}),
        ...(change.notes !== null ? { description: change.notes } : {}),
        ...(change.guests.length > 0 ? { attendees: change.guests.map((email) => ({ email })) } : {}),
        ...(change.meet
          ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } }
          : {}),
      }),
    };
  }
  const url = `${EVENTS_ENDPOINT}/${encodeURIComponent(eventId!)}${quiet}`;
  if (change.action === "cancel") return { url, method: "DELETE" };
  return { url, method: "PATCH", body: JSON.stringify({ start: googleTime(change.newStart!), end: googleTime(change.newEnd!) }) };
}

export async function gatewayCalendarWriteHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const change = readCalendarChange(body.change);
  const check = body.check === true;
  if (accessToken === null || expected === null) return json({ ok: false, refused: "not_allowed" });
  if (change === null) return json({ ok: false, refused: "invalid" });

  const claim = async (spend: boolean) =>
    await ctx.runMutation(internal.functions.calendarWrite.claimCalendarWrite, {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: expected,
      action: change.action,
      spend,
    });
  const room = await claim(false);
  if (!room.ok) {
    log({ outcome: "refused", reason: room.refused, check });
    return json({ ok: false, refused: room.refused });
  }
  if (check && change.action === "create") {
    return json({ ok: true, calendar: room.address, ...(change.guests.length > 0 ? { guests: change.guests } : {}) });
  }

  const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, { connectionId: room.connectionId });
  if (minted === null) {
    log({ outcome: "no_token" });
    return json({ ok: false, refused: "unavailable" });
  }
  try {
    const found = await findEvent(minted.accessToken, change, check);
    if (!found.ok) {
      log({ outcome: "refused", reason: found.refused, action: change.action, check });
      return json({ ok: false, refused: found.refused });
    }
    // A move or a cancel checked: whether it would tell anybody, so the gateway knows to ask first.
    if (check) return json({ ok: true, calendar: room.address, guests: found.guests });
    // Spent before the change is made: one that fails after Google took it
    // still counted, the safe direction for a limit.
    const spent = await claim(true);
    if (!spent.ok) return json({ ok: false, refused: spent.refused });
    const request = changeRequest(change, found.eventId);
    const response = await fetch(request.url, {
      method: request.method,
      headers: { Authorization: `Bearer ${minted.accessToken}`, "Content-Type": "application/json" },
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
    log({ outcome: response.ok ? "changed" : "http_error", action: change.action, status: response.status });
    if (!response.ok) return json({ ok: false, refused: "unavailable" });
    const meet = change.meet ? meetLink(await response.json().catch(() => null)) : null;
    return json({ ok: true, calendar: room.address, ...(meet !== null ? { meet } : {}) });
  } catch {
    log({ outcome: "transport_error", action: change.action });
    return json({ ok: false, refused: "unavailable" });
  }
}
