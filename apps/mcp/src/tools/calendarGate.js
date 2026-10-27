/**
 * THE CALENDAR GATE (`docs/decisions/communications/calendar-writes.md`).
 * Tex changes the person's own calendar at once when nobody else is on the
 * event (the owner, 2026-10-22). A move or a cancel that Google would tell a
 * guest about waits for the person's 👍 or yes to that exact change, guests
 * named; so does every change another connected AI asks for, in the app. It
 * is held the way `emailGate.js` holds an email:
 *
 *   1. The change is checked as the control plane will check it, and the
 *      limits are asked about without spending them, so the person is never
 *      asked to approve something that would be refused.
 *   2. Tex or another connected AI may ask; a routine or a dream has no person
 *      on the line and never may. A routine's own run (never a direct call on
 *      its connection) changes the person's own calendar at once, as Tex does,
 *      and only that (a review, 2026-10-26).
 *   3. The call is held as a pending approval whose record carries the whole
 *      change, which the person reads before their YES. Only a literal YES
 *      releases it by text (`agent/textedApprovals.js`); another AI's change
 *      is answered in the app.
 *
 * Only the replay of an approved record (`session.egress.approved`) passes
 * through to `calendar_event` itself.
 */

import { callKey, createPending, findPending, ALREADY_ASKED, shownBefore, takeDone } from "./approvals.js";
import { toolError } from "./results.js";
import { CALENDAR_TOOL, REFUSED, calendarCopy, calendarSummary, readCalendarChange, refusalFor } from "./calendarWrite.js";
import { emailCaller } from "./emailGate.js";
import { offerFor, offerTarget } from "./offerFor.js";

export { CALENDAR_TOOL };

/** The routine runner's client (`agent/routine.js`), named here as `forwardRule.js` does. */
const ROUTINES_CLIENT_ID = "context_routines";

/**
 * `null` to let an approved replay through to `calendar_event`, or the answer
 * to give instead: a refusal, a released result, or a hold.
 */
export async function calendarGate(supplied, { store, session, target }) {
  if (session.egress?.approved === true) return null;
  if (target.workspaceId !== session.workspaceId) {
    return toolError("Not changed: calendar_event takes no context. It always changes the person's own calendar.");
  }
  const read = readCalendarChange(supplied);
  if (read.error) return toolError(`Not changed: ${read.error}`);
  // A change to somebody else's calendar in a group chat, made on their own yes (`offerFor.js`).
  const offer = offerTarget(session, supplied, "calendar change");
  if (offer?.error) return toolError(`Not changed: ${offer.error}`);
  if (offer) return offerFor(session, { who: offer.who, tool: CALENDAR_TOOL, detail: calendarCopy(read.change, Date.now(), []), noun: "calendar change" });
  const userId = session.actorUserId;

  // A connected AI calling again after the person approved it in the app.
  const released = await takeDone(store, { name: CALENDAR_TOOL, args: supplied, userId, clientId: session.actorClientId });
  if (released) return released;
  // A routine's run, as `route.js` set it from the grant: the person's own events only (`routine.js`).
  const routineRun = session.actorClientId === ROUTINES_CLIENT_ID && typeof session.egress?.routine === "string";
  // Unattended after a page or an email's words: those words may add an event, never take one away or rewrite it.
  if (routineRun && session.egress?.ledger?.untrusted === true && read.change.action !== "create") {
    return toolError("Not changed: this routine read something from outside, so it may only add events now. Text them the change in one line instead.");
  }
  if (emailCaller(session.actorClientId) === null && !routineRun) {
    return toolError("Not changed: this connection may not change the person's calendar. Tell them what to change instead.");
  }

  if (typeof store?.calendar?.check !== "function") return toolError(REFUSED.not_configured);
  let room;
  try {
    // A new event's invitees are checked as the change their yes would release.
    room = await store.calendar.check(read.change.guests ? { ...read.change, notify_guests: true } : read.change);
  } catch {
    room = { ok: false, refused: "unavailable" };
  }
  if (room?.ok !== true) return toolError(refusalFor(room));

  const texting = session.egress?.texting === true;
  const guests = Array.isArray(room.guests) ? room.guests : [];
  /*
    Tex changes the person's own calendar at once (the owner, 2026-10-22: "as
    long as there isn't a second person added in a calendar event, there is no
    need to get permission ... we only need confirmation when you are sending
    things to another human being, so a cal invite to another person"). A new
    event inviting guests, or a move or a cancel of one with guests, tells
    somebody: that one is put to the person with the guests named, and their
    👍 or yes makes it and lets Google tell them (`notify_guests`). The
    owner, 2026-10-22, on Tex refusing to move a meeting with a guest and
    telling them to do it themselves: "it should've suggested the change and
    had me 👍 to approve it". Another AI's change still waits for the app.
  */
  if ((texting || routineRun) && guests.length === 0) return null;
  if (routineRun) {
    return toolError(
      `Not changed: this would tell ${guests.join(", ")}, and nobody is on the line in a routine to say yes. ` +
        "Text them this change in one line; their yes to it makes it.",
    );
  }
  const held = guests.length > 0 ? { ...supplied, notify_guests: true } : supplied;
  // One change per texted ask, as one email: one YES releases exactly what was read.
  const ledger = session.egress?.ledger ?? null;
  if (texting && ledger?.asked.some((asked) => asked.tool === CALENDAR_TOOL && asked.key !== callKey(CALENDAR_TOOL, held))) {
    return toolError("Not changed: one calendar change at a time by text. Ask about this one after the person answers.");
  }
  const existing = await findPending(store, { name: CALENDAR_TOOL, args: held, userId });
  if (session.egress?.texting === true && shownBefore(existing)) return toolError(ALREADY_ASKED);
  const record =
    existing?.record ??
    (await createPending(store, {
      name: CALENDAR_TOOL,
      args: held,
      actor: store.actor,
      tier: session.scope,
      scopes: session.scopes,
      widening: { summary: calendarSummary(read.change), audience: "outside" },
      detail: calendarCopy(read.change, Date.now(), guests),
      workspaceId: target.workspaceId,
      texting,
      armed: false, // armed by `textedAsk` once the ask goes out whole
    }));
  if (record === null) {
    return toolError("Not changed: the person has too many things waiting for their OK. Ask them to clear some first.");
  }
  if (ledger && !ledger.asked.some((asked) => asked.id === record.id)) ledger.asked.push(record);
  return {
    ...toolError(
      texting
        ? "Held for their yes, and nothing failed: right after your answer, in this same reply, they are shown this exact change " +
            "and asked, and one yes or 👍 makes it" + (guests.length > 0 ? " and Google tells the guests" : "") +
            ". Say in one short line what you'd change, without repeating it or asking for their yes. " +
            "Never say it is still waiting, and never point them to another message, app or confirmation. Don't call this again in this turn."
        : "Not changed yet: the person must approve this exact change in the Context app. " +
            "Once they have, call calendar_event again with exactly the same arguments and you will be told it was done.",
    ),
    held: true,
  };
}
