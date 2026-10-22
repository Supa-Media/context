/**
 * One Google Chat message a person's AI sends as them, to a person (a direct
 * message) or into a space (`docs/decisions/communications/google-chat-messages.md`).
 *
 * The gateway holds every one until the person says yes to the exact words
 * and the exact place (`apps/mcp/src/tools/googleChatGate.js`); this side is
 * the check the gateway cannot skip: whose Chat it is, that the connection
 * granted `chat.messages.create`, and how many the person may send. Pure
 * helpers here; the route is `gatewayRoutes/googleChat.ts` and the counting
 * is `functions/googleChatSend.ts`. Nothing of a message is kept: the limits
 * count messages, never words or recipients.
 */

export { CHAT_SEND_SCOPE, CHAT_SEND_SCOPES } from "./googleOAuth";

export const CHAT_SEND_HOURLY_LIMIT = 10;
export const CHAT_SEND_DAILY_LIMIT = 40;
/** Google takes up to 32,000 bytes; a text from Tex never needs that many. */
export const CHAT_MAX_TEXT = 4_000;
export const CHAT_MAX_SPACE = 128;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** A space's resource name, as Google gives it. */
export const SPACE_NAME = /^spaces\/[A-Za-z0-9_-]{1,64}$/;
const TEXT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/;
const LINE_CONTROL = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;

export type ChatRefusal =
  | "invalid"
  | "not_allowed"
  | "no_chat"
  | "hourly_limit"
  | "daily_limit"
  | "space_not_found"
  | "ambiguous"
  | "person_not_found"
  | "chat_not_enabled"
  | "reconnect_required"
  | "unavailable";

/** `to` is one person's email (a direct message); `space` a space, by its name in Chat or its `spaces/…` id. */
export interface ChatMessage {
  to: string | null;
  space: string | null;
  text: string;
}

/**
 * The message as the gateway sent it, checked again here, or null. The
 * gateway runs the same rules (`apps/mcp/src/tools/googleChat.js`); a
 * mismatch is refused rather than repaired, because a repaired message is not
 * the one the person said yes to.
 */
export function readChatMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const to = typeof raw.to === "string" ? raw.to.trim().toLowerCase() : null;
  const space = typeof raw.space === "string" ? raw.space.trim() : null;
  if ((to === null) === (space === null)) return null;
  if (to !== null && (to.length > 254 || !ADDRESS.test(to))) return null;
  if (space !== null && (space === "" || space.length > CHAT_MAX_SPACE || LINE_CONTROL.test(space))) return null;
  const text = typeof raw.text === "string" ? raw.text : "";
  if (text.trim() === "" || text.length > CHAT_MAX_TEXT || TEXT_CONTROL.test(text)) return null;
  return { to, space, text };
}

/** The counters one message spends, all or none (`functions/googleChatSend.ts`). */
export function chatSendPolicies(userId: string) {
  return [
    { key: `chat_send.hour:${userId}`, limit: CHAT_SEND_HOURLY_LIMIT, windowMs: HOUR_MS, refusal: "hourly_limit" as const },
    { key: `chat_send.day:${userId}`, limit: CHAT_SEND_DAILY_LIMIT, windowMs: DAY_MS, refusal: "daily_limit" as const },
  ];
}

interface ListedSpace {
  name?: unknown;
  displayName?: unknown;
  spaceType?: unknown;
}

/** The named spaces in a listing whose name in Chat is `wanted`, ignoring case and outer spaces. */
export function matchingSpaces(items: unknown, wanted: string): Array<{ name: string; displayName: string }> {
  if (!Array.isArray(items)) return [];
  const folded = wanted.trim().replace(/^#/, "").toLowerCase();
  return (items as ListedSpace[])
    .filter((space) => typeof space.name === "string" && typeof space.displayName === "string" && space.spaceType !== "DIRECT_MESSAGE")
    .filter((space) => (space.displayName as string).trim().toLowerCase() === folded)
    .map((space) => ({ name: space.name as string, displayName: (space.displayName as string).trim() }));
}

/** A listing trimmed to what finding a space needs: its id, its name and its kind. */
export function listedSpaces(items: unknown): Array<{ name: string; displayName: string; type: string }> {
  if (!Array.isArray(items)) return [];
  return (items as ListedSpace[])
    .filter((space) => typeof space.name === "string" && SPACE_NAME.test(space.name as string))
    .map((space) => ({
      name: space.name as string,
      displayName: typeof space.displayName === "string" ? space.displayName.replace(LINE_CONTROL, " ").trim().slice(0, CHAT_MAX_SPACE) : "",
      type: typeof space.spaceType === "string" ? space.spaceType : "",
    }));
}

/**
 * What a refused Google Chat call means for the person. A Chat API that is
 * off in the deployment's Google Cloud project (or has no Chat app set up)
 * is the deployment's to fix, never the person's.
 */
export function chatFailure(status: number, body: unknown): ChatRefusal {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  if (status === 401) return "reconnect_required";
  if (/SERVICE_DISABLED|has not been used in project|Chat app not found|accessNotConfigured/i.test(text)) return "chat_not_enabled";
  if (status === 403 && /insufficient|scope/i.test(text)) return "no_chat";
  return "unavailable";
}
