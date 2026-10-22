/**
 * THE GOOGLE CHAT GATE (`docs/decisions/communications/google-chat-messages.md`).
 * A Google Chat message reaches another person, so it waits for the person's
 * one yes or 👍 to that exact message and place (the owner, 2026-10-22: "we
 * only need confirmation when you are sending things to another human
 * being"), held the way `emailGate.js` holds an email:
 *
 *   1. The message is checked as the control plane will check it, and the
 *      control plane is asked, spending nothing, whether it could go and
 *      where: the person is shown the space or person by the name Chat gives
 *      it, and is never asked about a message that would be refused.
 *   2. Tex or another connected AI may ask; a routine or a dream has no person
 *      on the line and never may.
 *   3. Their yes or 👍 to Tex's own preview of exactly this message, place
 *      included, sends it without a second ask (`likedPreview.js`).
 *   4. Otherwise it is held as a pending approval whose record carries the
 *      whole message, and the ask is texted right after the answer.
 *
 * Listing spaces is never held. Only the replay of an approved record
 * (`session.egress.approved`) passes through to `google_chat` itself.
 */

import { callKey, createPending, findPending, takeDone } from "./approvals.js";
import { toolError } from "./results.js";
import { GOOGLE_CHAT_TOOL, REFUSED, chatCopy, chatSends, chatSummary, placeName, readChatMessage } from "./googleChat.js";
import { emailCaller } from "./emailGate.js";
import { agreedWordsHold } from "./likedPreview.js";
import { recordChange } from "../activity/record.js";

export { GOOGLE_CHAT_TOOL };

/**
 * `null` to let an approved replay (or a listing) through to `google_chat`,
 * or the answer to give instead: a refusal, a released result, or a hold.
 */
export async function googleChatGate(supplied, { store, session, target }) {
  if (session.egress?.approved === true || !chatSends(supplied)) return null;
  if (target.workspaceId !== session.workspaceId) {
    return toolError("Not sent: google_chat takes no context. It always sends as the person, from their own Google account.");
  }
  const read = readChatMessage(supplied);
  if (read.error) return toolError(`Not sent: ${read.error}`);
  const userId = session.actorUserId;

  // A connected AI calling again after the person approved it in the app.
  const released = await takeDone(store, { name: GOOGLE_CHAT_TOOL, args: supplied, userId, clientId: session.actorClientId });
  if (released) return released;
  if (emailCaller(session.actorClientId) === null) {
    return toolError("Not sent: this connection may not send messages as the person. Give them the words to send themselves.");
  }

  if (typeof store?.googleChat?.check !== "function") return toolError(REFUSED.not_configured);
  let room;
  try {
    room = await store.googleChat.check(read.message);
  } catch {
    room = { ok: false, refused: "unavailable" };
  }
  if (room?.ok !== true) return toolError(REFUSED[room?.refused] ?? REFUSED.unavailable);

  const texting = session.egress?.texting === true;
  // Their yes or 👍 to Tex's own preview: where it goes and the whole message in the words they agreed to.
  if (texting && agreedWordsHold(session, [placeName(room.place), read.message.text])) {
    await recordChange(store, "approve_action", session.scope, [], { tool: GOOGLE_CHAT_TOOL, by: "yes_to_offer", client_id: session.actorClientId ?? null, team_visible: false }).catch(() => {});
    console.log(JSON.stringify({ event: "yes_to_offer", tool: GOOGLE_CHAT_TOOL, released: true }));
    return null;
  }
  // One message per texted ask, as one email: one yes sends exactly what was read.
  const ledger = session.egress?.ledger ?? null;
  if (texting && ledger?.asked.some((asked) => asked.tool === GOOGLE_CHAT_TOOL && asked.key !== callKey(GOOGLE_CHAT_TOOL, supplied))) {
    return toolError("Not sent: one Google Chat message at a time by text. Ask about this one after the person answers.");
  }
  const existing = await findPending(store, { name: GOOGLE_CHAT_TOOL, args: supplied, userId });
  const record =
    existing?.record ??
    (await createPending(store, {
      name: GOOGLE_CHAT_TOOL,
      args: supplied,
      actor: store.actor,
      tier: session.scope,
      scopes: session.scopes,
      widening: { summary: chatSummary(room.place), audience: "outside" },
      detail: chatCopy(room.place, room.from, read.message.text),
      workspaceId: target.workspaceId,
      texting,
      armed: false, // armed by `textedAsk` once the ask goes out whole
    }));
  if (record === null) {
    return toolError("Not sent: the person has too many things waiting for their OK. Ask them to clear some first.");
  }
  if (ledger && !ledger.asked.some((asked) => asked.id === record.id)) ledger.asked.push(record);
  return {
    ...toolError(
      texting
        ? "Held for their 👍, and nothing failed: right after your answer they are texted this exact message and asked " +
            "for their 👍, and it sends then. Say in one short line what you'd send. Don't repeat the message, don't " +
            "offer the browser, and don't call google_chat again in this turn."
        : "Waiting for the person, and nothing failed: they must approve this exact message in the Context app. " +
            "Once they have, call google_chat again with exactly the same arguments and you will be told it was sent.",
    ),
    held: true,
  };
}
