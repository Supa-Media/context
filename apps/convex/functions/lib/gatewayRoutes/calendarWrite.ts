/**
 * `POST /gateway/calendar/event`: add, edit, move, cancel or answer one event
 * on a primary Google Calendar of the person whose token this is
 * (`lib/calendarWrite.ts`, `lib/calendarEdit.ts`). An existing event is
 * looked for on each of their calendars that may be changed.
 *
 * Body `{ accessToken, expectedWorkspaceId, change, check? }`. Answers
 * `{ ok: true, calendar, guests?, meet? }` (with `check`, nothing changes; a
 * change to an existing event checked names who it would tell, a create its invitees; a
 * create with a Meet answers its link) or `{ ok: false, refused }`.
 *
 * The gateway makes Tex's change to an event nobody else is on at once, and
 * holds any other for the person's yes (`apps/mcp/src/tools/calendarGate.js`).
 * Decided here: the calendar is one of the token's person's own connections
 * that granted `calendar.events`, the limits hold, and a change to an
 * existing event reaches exactly one event, never the shared parts of an
 * invite somebody else organizes (`not_organizer`). One with guests is changed only with
 * `notify_guests`, and then Google tells them (`sendUpdates=all`); otherwise
 * `sendUpdates=none`. A new event invites guests only with it too, and gets a
 * Google Meet with `meet` (`conferenceDataVersion=1`). Nothing of the event is stored or logged; Google's
 * error body can quote it, so only a status is.
 *
 * A create is safe to send twice (a review of a chat, 2026-10-24: "Serving at
 * church" landed twice, the second call sent after the first looked failed).
 * Its Google event id is worked out from the calendar, the title and the
 * moments (`createdEventId`), so the same event asked for again is Google's
 * 409 and answered as the one already there (`existing`); one the person
 * deleted since holds that id still, cancelled, so it is added afresh.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import type { CalendarChange, CalendarRefusal, GoogleEvent } from "../calendarWrite";
import { googleTime, instant, matchingEvents, meetLink, readCalendarChange, searchWindow } from "../calendarWrite";
import { googleReminders } from "../calendarEdit";
import { EVENTS_ENDPOINT, existingEventRequest, whoHears } from "./calendarEditRequest";

function log(fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ event: "calendar_write", ...fields }));
}

type Found = { ok: true; event: GoogleEvent; guests: string[] } | { ok: false; refused: CalendarRefusal };

/** The one event a change names on one calendar, or why there is not exactly one. */
async function findEvent(accessToken: string, change: CalendarChange, check: boolean): Promise<Found> {
  const query = new URLSearchParams({ ...searchWindow(change.start), singleEvents: "true", q: change.title, maxResults: "50" });
  let response = await fetch(`${EVENTS_ENDPOINT}?${query}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    log({ outcome: "http_error", stage: "find", status: response.status });
    return { ok: false, refused: "unavailable" };
  }
  let listed = (await response.json().catch(() => null)) as { items?: unknown } | null;
  let matches = matchingEvents(listed?.items, change);
  if (matches.length === 0) {
    // Google's word search misses a title written a little differently; the moment does not.
    query.delete("q");
    response = await fetch(`${EVENTS_ENDPOINT}?${query}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    listed = response.ok ? ((await response.json().catch(() => null)) as { items?: unknown } | null) : null;
    matches = matchingEvents(listed?.items, change);
  }
  if (matches.length === 0) return { ok: false, refused: "not_found" };
  if (matches.length > 1) return { ok: false, refused: "ambiguous" };
  const event = matches[0]!;
  const heard = whoHears(change, event);
  if (!heard.ok) return heard;
  if (heard.guests.length > 0 && !change.notifyGuests && !check) return { ok: false, refused: "has_guests" };
  return { ok: true, event, guests: heard.guests };
}

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/**
 * The Google event id a create asks for: the same calendar, title (any case
 * or spacing), start and end always give the same one, in the base32hex
 * Google takes. Nothing of the event can be read back from it.
 */
export async function createdEventId(connectionId: string, change: CalendarChange): Promise<string> {
  const title = change.title.trim().replace(/\s+/g, " ").toLowerCase();
  const key = [connectionId, title, instant(change.start), instant(change.end!), (change.recurrence ?? []).join(";")].join("\n");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  let bits = 0;
  let value = 0;
  let id = "ctx";
  for (const byte of digest.subarray(0, 20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      id += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return id;
}

/** The one request that adds a new event, under `id` when given. */
function createRequest(change: CalendarChange, id: string | null): { url: string; method: string; body: string } {
  const quiet = change.notifyGuests ? "?sendUpdates=all" : "?sendUpdates=none";
  return {
    url: `${EVENTS_ENDPOINT}${quiet}${change.meet ? "&conferenceDataVersion=1" : ""}`,
    method: "POST",
    body: JSON.stringify({
      ...(id !== null ? { id } : {}),
      summary: change.title,
      start: googleTime(change.start),
      end: googleTime(change.end!),
      ...(change.location !== null ? { location: change.location } : {}),
      ...(change.notes !== null ? { description: change.notes } : {}),
      ...(change.guests.length > 0 ? { attendees: change.guests.map((email) => ({ email })) } : {}),
      ...(change.reminders !== null ? { reminders: googleReminders(change.reminders) } : {}),
      ...(change.recurrence !== null ? { recurrence: change.recurrence } : {}),
      ...(change.meet
        ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } }
        : {}),
    }),
  };
}

type Writer = { connectionId: Id<"googleConnections">; address: string };

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
  let room = await claim(false);
  // Stored scopes said read-only: Google is asked what the grant really holds before anybody is told to reconnect (`googleScopeCheck.ts`).
  let readOnly: string[] = [];
  if (!room.ok && room.refused === "calendar_read_only") {
    const recheck = await ctx.runAction(internal.functions.googleScopeCheck.recheckCalendarWrite, {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: expected,
    });
    readOnly = recheck.readOnly;
    if (recheck.writable) room = await claim(false);
  }
  if (!room.ok) {
    log({ outcome: "refused", reason: room.refused, check });
    return json({ ok: false, refused: room.refused, ...(room.refused === "calendar_read_only" ? { accounts: readOnly } : {}) });
  }

  try {
    // A new event goes on the calendar named, or the first that may be changed;
    // an existing one is looked for on each in turn, since the person may have connected several.
    const named = change.calendar === null ? room.writers : room.writers.filter((row: Writer) => row.address.toLowerCase() === change.calendar!.toLowerCase());
    if (named.length === 0) {
      log({ outcome: "refused", reason: "other_calendar", check });
      return json({ ok: false, refused: "other_calendar" });
    }
    const writers: Writer[] = change.action === "create" ? [named[0]!] : named;
    if (check && change.action === "create") {
      return json({ ok: true, calendar: named[0]!.address, ...(change.guests.length > 0 ? { guests: change.guests } : {}) });
    }
    let found: Found = { ok: false, refused: "not_found" };
    let writer: Writer | null = null;
    let googleToken: string | null = null;
    for (const candidate of writers) {
      const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, { connectionId: candidate.connectionId });
      if (minted === null) {
        log({ outcome: "no_token" });
        found = found.ok === false && found.refused === "not_found" ? { ok: false, refused: "unavailable" } : found;
        continue;
      }
      if (change.action === "create") {
        writer = candidate;
        googleToken = minted.accessToken;
        found = { ok: true, event: {}, guests: [] };
        break;
      }
      const here = await findEvent(minted.accessToken, change, check);
      if (here.ok || here.refused !== "not_found") {
        found = here;
        writer = candidate;
        googleToken = minted.accessToken;
        break;
      }
    }
    if (!found.ok || writer === null || googleToken === null) {
      const refused = found.ok ? "unavailable" : found.refused;
      log({ outcome: "refused", reason: refused, action: change.action, check });
      return json({ ok: false, refused });
    }
    // A change to an existing event checked: whether it would tell anybody, so the gateway knows to ask first.
    if (check) return json({ ok: true, calendar: writer.address, guests: found.guests });
    const eventId = change.action === "create" ? await createdEventId(writer.connectionId, change) : null;
    const request = change.action === "create" ? createRequest(change, eventId) : await existingEventRequest(change, found.event, { accessToken: googleToken });
    if (request === null) {
      log({ outcome: "http_error", stage: "prepare", action: change.action });
      return json({ ok: false, refused: "unavailable" });
    }
    // Spent before the change is made: one that fails after Google took it
    // still counted, the safe direction for a limit.
    const spent = await claim(true);
    if (!spent.ok) return json({ ok: false, refused: spent.refused });
    const send = async (sent: { url: string; method: string; body?: string }) =>
      await fetch(sent.url, {
        method: sent.method,
        headers: { Authorization: `Bearer ${googleToken}`, "Content-Type": "application/json" },
        ...(sent.body !== undefined ? { body: sent.body } : {}),
      });
    let response = await send(request);
    if (response.status === 409 && eventId !== null) {
      // The same create, already made: the event it made is the answer, unless the person has deleted it since.
      const there = await fetch(`${EVENTS_ENDPOINT}/${eventId}`, { headers: { Authorization: `Bearer ${googleToken}` } });
      const event = there.ok ? ((await there.json().catch(() => null)) as { status?: unknown } | null) : null;
      if (event !== null && event.status !== "cancelled") {
        log({ outcome: "existing", action: change.action });
        const meet = change.meet ? meetLink(event) : null;
        return json({ ok: true, calendar: writer.address, existing: true, ...(meet !== null ? { meet } : {}) });
      }
      if (event !== null) response = await send(createRequest(change, null));
    }
    log({ outcome: response.ok ? "changed" : "http_error", action: change.action, status: response.status });
    if (response.status === 403 && change.action !== "create") return json({ ok: false, refused: "not_organizer" });
    if (!response.ok) return json({ ok: false, refused: "unavailable" });
    const meet = change.meet || change.edit?.meet ? meetLink(await response.json().catch(() => null)) : null;
    return json({ ok: true, calendar: writer.address, ...(meet !== null ? { meet } : {}) });
  } catch {
    log({ outcome: "transport_error", action: change.action });
    return json({ ok: false, refused: "unavailable" });
  }
}
