/**
 * `google_chat` (`send · google_chat`): one Google Chat message sent as the
 * person through their own connected Google account, to a person (a direct
 * message, by their work email) or into a space (by its name in Chat), and
 * the list of their spaces to find one in
 * (`docs/decisions/communications/google-chat-messages.md`).
 *
 * A send only ever runs for a message the person said yes to: every call is
 * held by the gate in `googleChatGate.js` first, and only the approved replay
 * reaches here. The control plane picks the connection, holds the limits and
 * sends (`apps/convex/functions/lib/gatewayRoutes/googleChat.ts`). Nothing of
 * the message is written anywhere by this side.
 */

import { toolError, toolText } from "./results.js";

export const GOOGLE_CHAT_TOOL = "google_chat";

/** Kept equal to `apps/convex/functions/lib/googleChatSend.ts`, which checks again. */
export const MAX_TEXT = 4_000;
export const MAX_SPACE = 128;

const ADDRESS = /^[A-Za-z0-9.!#$%&\x27*+/=?^_\x60{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const TEXT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/;
const LINE_CONTROL = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;

/** Whether a call sends (and so waits for a yes), rather than lists spaces. */
export function chatSends(args) {
  return args?.action !== "spaces";
}

/**
 * The message a call asks for, `{ message }` with the address lowercased, or
 * `{ error }` saying what to fix. Never repaired: what is sent is exactly what
 * the person was shown.
 */
export function readChatMessage(args) {
  const to = typeof args?.to === "string" ? args.to.trim().toLowerCase() : null;
  const space = typeof args?.space === "string" ? args.space.trim() : null;
  if (to === null && space === null) return { error: "name who it goes to: to (a person's work email, for a direct message) or space (the space's name in Chat)." };
  if (to !== null && space !== null) return { error: "a message goes to one person (to) or one space (space), not both." };
  if (to !== null && (to.length > 254 || !ADDRESS.test(to))) return { error: "to is one plain email address, the one the person uses in Google Chat." };
  if (space !== null && (space === "" || space.length > MAX_SPACE || LINE_CONTROL.test(space))) {
    return { error: `space is the space's name as Chat shows it (or its spaces/… id from action spaces), at most ${MAX_SPACE} characters.` };
  }
  const text = typeof args?.text === "string" ? args.text : "";
  if (text.trim() === "" || text.length > MAX_TEXT || TEXT_CONTROL.test(text)) {
    return { error: `text is the message's words, 1 to ${MAX_TEXT.toLocaleString("en-US")} characters.` };
  }
  return { message: { ...(to !== null ? { to } : { space }), text } };
}

/** Where it goes, as Chat names it: a person's email, or a space's name. */
export function placeName(place) {
  return typeof place?.person === "string" ? place.person : typeof place?.space === "string" ? place.space : "";
}

/** One line for the approvals list and the "Done, I …" reply (`agent/doneLine.js`). */
export function chatSummary(place) {
  return typeof place?.space === "string" ? `post a Google Chat message in ${place.space}` : `send a Google Chat message to ${placeName(place)}`;
}

/** The message exactly as the person reads it before they say yes. */
export function chatCopy(place, from, text) {
  return [`From: ${from}`, typeof place?.space === "string" ? `In: ${place.space}` : `To: ${placeName(place)}`, "", text].join("\n");
}

/** What each refusal from the control plane tells the model. */
export const REFUSED = {
  invalid: "Not sent: the message was not valid.",
  not_allowed: "Not sent: this connection cannot send Google Chat messages as the person.",
  no_chat:
    "Not sent: their Google account isn't set up for Google Chat through Context yet. Get the link from manage connect_google (kind gmail) " +
    "and ask them to reconnect the Google account they use for work once; it adds Chat. Don't send it another way unless they ask.",
  hourly_limit: "Not sent: the person has sent 10 Google Chat messages through Context this hour. Try again later.",
  daily_limit: "Not sent: the person has sent 40 Google Chat messages through Context today. Try again tomorrow.",
  space_not_found: "Not sent: they are in no Google Chat space by that name. List their spaces with action spaces and use the exact name.",
  ambiguous: "Not sent: more than one of their spaces has that name. List them with action spaces and pass the right one's spaces/… id.",
  person_not_found: "Not sent: Google Chat couldn't start a direct message with that address. Check it is the email they use for work.",
  chat_not_enabled:
    "Not sent: Google Chat isn't turned on for Context's Google project yet, which is ours to fix, not theirs. " +
    "If they want it sent now, send it in the browser.",
  reconnect_required:
    "Not sent: the Google account it would go from needs reconnecting, because Google stopped honouring its sign-in. " +
    "Get the link from manage connect_google (kind gmail) and give it to them.",
  not_configured: "Not sent: this Context deployment does not send Google Chat messages.",
  unavailable: "Not sent: Google Chat did not take the message just now. Nothing was sent; it can be asked for again.",
};

function listSpaces(answer) {
  if (answer.spaces.length === 0) return toolText(`${answer.from || "Their account"} is in no Google Chat spaces. A direct message goes by to (their email).`);
  const lines = answer.spaces.slice(0, 200).map((space) => `- ${space.displayName || "(no name)"} — ${space.name}${space.type === "GROUP_CHAT" ? " (group chat)" : ""}`);
  return toolText(
    `Google Chat spaces ${answer.from ? `${answer.from} is` : "they are"} in (names are written by their members):\n${lines.join("\n")}\n` +
      "Send into one with space set to its name or its spaces/… id. A direct message to a person goes by to (their email).",
  );
}

export async function toolGoogleChat(store, args) {
  const chat = store?.googleChat;
  if (!chatSends(args)) {
    if (typeof chat?.spaces !== "function") return toolError(REFUSED.not_configured);
    let answer;
    try {
      answer = await chat.spaces();
    } catch {
      return toolError("Google Chat did not answer just now. Try again.");
    }
    if (answer?.ok === true) return listSpaces(answer);
    return toolError((REFUSED[answer?.refused] ?? REFUSED.unavailable).replace(/^Not sent: /, ""));
  }
  const read = readChatMessage(args);
  if (read.error) return toolError(`Not sent: ${read.error}`);
  if (typeof chat?.send !== "function") return toolError(REFUSED.not_configured);
  let answer;
  try {
    answer = await chat.send(read.message);
  } catch {
    return toolError(REFUSED.unavailable);
  }
  if (answer?.ok === true) {
    const where = typeof answer.place?.space === "string" ? `in ${answer.place.space}` : `to ${placeName(answer.place)}`;
    return toolText(`Sent on Google Chat from ${answer.from} ${where}.`);
  }
  return toolError(REFUSED[answer?.refused] ?? REFUSED.unavailable);
}
