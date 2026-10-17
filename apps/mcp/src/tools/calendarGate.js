/**
 * THE CALENDAR GATE: no change reaches the person's calendar without their
 * yes to that exact change (`docs/decisions/communications/calendar-writes.md`),
 * held the way `emailGate.js` holds an email and before the deployment's
 * `EGRESS_APPROVALS = "off"`, which does not switch this off:
 *
 *   1. The change is checked as the control plane will check it, and the
 *      limits are asked about without spending them, so the person is never
 *      asked to approve something that would be refused.
 *   2. Tex or another connected AI may ask; a routine or a dream has no person
 *      on the line and never may.
 *   3. The call is held as a pending approval whose record carries the whole
 *      change, which the person reads before their YES. Only a literal YES
 *      releases it by text (`agent/textedApprovals.js`); another AI's change
 *      is answered in the app.
 *
 * Only the replay of an approved record (`session.egress.approved`) passes
 * through to `calendar_event` itself.
 */

import { callKey, createPending, findPending, takeDone } from "./approvals.js";
import { toolError } from "./results.js";
import { CALENDAR_TOOL, REFUSED, calendarCopy, calendarSummary, readCalendarChange } from "./calendarWrite.js";
import { emailCaller } from "./emailGate.js";

export { CALENDAR_TOOL };

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
  const userId = session.actorUserId;

  // A connected AI calling again after the person approved it in the app.
  const released = await takeDone(store, { name: CALENDAR_TOOL, args: supplied, userId, clientId: session.actorClientId });
  if (released) return released;
  if (emailCaller(session.actorClientId) === null) {
    return toolError("Not changed: this connection may not change the person's calendar. Tell them what to change instead.");
  }

  if (typeof store?.calendar?.check !== "function") return toolError(REFUSED.not_configured);
  let room;
  try {
    room = await store.calendar.check(read.change);
  } catch {
    room = { ok: false, refused: "unavailable" };
  }
  if (room?.ok !== true) return toolError(REFUSED[room?.refused] ?? REFUSED.unavailable);

  const texting = session.egress?.texting === true;
  // One change per texted ask, as one email: one YES releases exactly what was read.
  const ledger = session.egress?.ledger ?? null;
  if (texting && ledger?.asked.some((asked) => asked.tool === CALENDAR_TOOL && asked.key !== callKey(CALENDAR_TOOL, supplied))) {
    return toolError("Not changed: one calendar change at a time by text. Ask about this one after the person answers.");
  }
  const existing = await findPending(store, { name: CALENDAR_TOOL, args: supplied, userId });
  const record =
    existing?.record ??
    (await createPending(store, {
      name: CALENDAR_TOOL,
      args: supplied,
      actor: store.actor,
      tier: session.scope,
      scopes: session.scopes,
      widening: { summary: calendarSummary(read.change), audience: "outside" },
      detail: calendarCopy(read.change),
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
        ? "Not changed yet: the person will be shown this exact change and asked to reply YES. " +
            "Say in a line what you would change, without repeating it. Don't call this again in this turn."
        : "Not changed yet: the person must approve this exact change in the Context app. " +
            "Once they have, call calendar_event again with exactly the same arguments and you will be told it was done.",
    ),
    held: true,
  };
}
