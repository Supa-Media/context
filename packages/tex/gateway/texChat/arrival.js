/**
 * The shape of a text arriving at a chat's intake (`POST /arrive` on `TexChat`, `agent/textsArrive.js` in front of it).
 * Shared by both so the object never trusts a body the texting entrypoint did not check.
 */

/** The ways a text can arrive: a 1:1 text, a group text, a tapback, a group's membership change, an edit of a text, and Tex added to a group. */
export const ARRIVAL_KINDS = Object.freeze(new Set(["one", "group", "react", "members", "edit", "joined"]));
/** An inbox name is the chat's handle: letters, digits and the few marks a chat id uses, never a path. */
export const INBOX_NAME = /^[A-Za-z0-9:+_.@-]{1,200}$/;
/** The longest event id accepted, and the one that dedupes a text. */
export const MAX_EVENT_ID = 200;

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Whether `body` is a well-formed arrival: `{kind, inbox, eventId?, message, origin?}`. `message` is a plain object,
 * except a members change, which carries none (`message: null`, as the texting Worker's `toChat` sends it; the chat
 * object posts nothing for it, `texChat.js`). Refusing that null on 2026-11-25 answered the Photon bridge 503, and the
 * bridge retried that one event for good, holding every later text on the line behind it.
 */
export function isArrival(body) {
  if (!isPlainObject(body)) return false;
  if (!ARRIVAL_KINDS.has(body.kind)) return false;
  if (typeof body.inbox !== "string" || !INBOX_NAME.test(body.inbox)) return false;
  if (body.eventId !== undefined && (typeof body.eventId !== "string" || body.eventId.length < 1 || body.eventId.length > MAX_EVENT_ID)) return false;
  if (body.origin !== undefined && (typeof body.origin !== "string" || body.origin.length > MAX_EVENT_ID)) return false;
  if (body.kind === "members" && body.message === null) return true;
  return isPlainObject(body.message);
}
