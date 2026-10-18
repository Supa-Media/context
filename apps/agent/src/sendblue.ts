/**
 * Sendblue: Tex's dedicated iMessage line (Dev2, 2026-10-18), in place of
 * Linq's free shared line, whose 20-number list kept newcomers out.
 *
 * Sendblue has no chat ids: a message goes to a phone number from one of our
 * line numbers. So a Sendblue chat is named `sendblue:<line>:<phone>`, which
 * is what the inbox remembers as the chat a sender last texted from, and the
 * reply goes back from the same line it came in on.
 *
 * Its receive webhook carries the secret we set, verbatim, in the
 * `sb-signing-secret` header; there is no HMAC over the body. So the secret is
 * compared in constant time, and a redelivered message is answered once
 * because the inbox dedupes on its `message_handle`.
 *
 * No response body is ever logged or echoed: it can quote the message. Two
 * bodies are read: a replied-to message, only when it is in this person's
 * own chat (`repliedToText`), and the line's Name & Photo state.
 */

import { MAX_REPLY_TEXT, ServiceError, type Fetch } from "./clients";
import { CARD_VERSION } from "./card";
import { MAX_INBOUND_ATTACHMENTS, MAX_INBOUND_TEXT, type Inbound, type InboundAttachment } from "./inbound";

/** The base address docs.sendblue.com names for every call. */
export const SENDBLUE_API = "https://api.sendblue.com";

/** Tex's iMessage Name & Photo: the name and the card's photo (`apps/mobile/public/texts-card.png`), its address versioned so a new photo is fetched anew. */
export const PROFILE_NAME = "Tex";
export const PROFILE_PHOTO_URL = `https://context.lc/texts-card.png?v=${CARD_VERSION}`;
/** The most of a replied-to message quoted to Tex. */
export const MAX_QUOTED_TEXT = 500;

export type SendblueKeys = { keyId: string; secret: string };

const E164 = /^\+[1-9]\d{6,14}$/;
const CHAT_PREFIX = "sendblue:";
const TIMEOUT_MS = 30_000;
const QUICK_TIMEOUT_MS = 3_000;

export function sendblueChatId(line: string, phone: string): string {
  return `${CHAT_PREFIX}${line}:${phone}`;
}

export function isSendblueChat(chatId: string): boolean {
  return chatId.startsWith(CHAT_PREFIX);
}

/** The line and the person of a Sendblue chat id, or null for anything else. */
export function parseSendblueChat(chatId: string): { line: string; phone: string } | null {
  if (!isSendblueChat(chatId)) return null;
  const [line, phone, ...rest] = chatId.slice(CHAT_PREFIX.length).split(":");
  if (rest.length > 0 || !E164.test(line ?? "") || !E164.test(phone ?? "")) return null;
  return { line, phone };
}

/** Both keys, or null: a half-configured line is no line. */
export function sendblueKeys(keyId: string | undefined, secret: string | undefined): SendblueKeys | null {
  const id = keyId?.trim();
  const key = secret?.trim();
  return id && key ? { keyId: id, secret: key } : null;
}

async function call(
  fetcher: Fetch,
  keys: SendblueKeys,
  path: string,
  body: Record<string, unknown>,
  timeoutMs = TIMEOUT_MS,
): Promise<number> {
  let response: Response;
  try {
    response = await fetcher(`${SENDBLUE_API}${path}`, {
      method: "POST",
      headers: { ...headersOf(keys), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ServiceError("sendblue", null);
  }
  // Drained, never read: an error body can quote the request.
  await response.body?.cancel();
  return response.status;
}

function headersOf(keys: SendblueKeys): Record<string, string> {
  return { "sb-api-key-id": keys.keyId, "sb-api-secret-key": keys.secret };
}

/** A GET's JSON, unwrapped from `data` when it is wrapped; null for any failure. Quick, never throws. */
async function getJson(fetcher: Fetch, keys: SendblueKeys, path: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(`${SENDBLUE_API}${path}`, {
      method: "GET",
      headers: headersOf(keys),
      signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const body: unknown = await response.json();
    if (!isRecord(body)) return null;
    return isRecord(body.data) ? body.data : body;
  } catch {
    return null;
  }
}

function chatOf(chatId: string): { number: string; from_number: string } {
  const chat = parseSendblueChat(chatId);
  if (chat === null) throw new ServiceError("sendblue", null);
  return { number: chat.phone, from_number: chat.line };
}

export async function sendSendblueText(fetcher: Fetch, keys: SendblueKeys, chatId: string, text: string): Promise<void> {
  const status = await call(fetcher, keys, "/api/send-message", {
    ...chatOf(chatId),
    content: text.slice(0, MAX_REPLY_TEXT),
  });
  if (status < 200 || status >= 300) throw new ServiceError("sendblue", status);
}

/** Send one picture by its https address, which Sendblue fetches. */
export async function sendSendblueMedia(fetcher: Fetch, keys: SendblueKeys, chatId: string, url: string): Promise<void> {
  const status = await call(fetcher, keys, "/api/send-message", { ...chatOf(chatId), media_url: url });
  if (status < 200 || status >= 300) throw new ServiceError("sendblue", status);
}

/** The "…" bubble. Best effort and quick; never throws. */
export async function startSendblueTyping(fetcher: Fetch, keys: SendblueKeys, chatId: string): Promise<void> {
  let status: number | null = null;
  try {
    status = await call(fetcher, keys, "/api/send-typing-indicator", chatOf(chatId), QUICK_TIMEOUT_MS);
  } catch {
    // A bubble that failed costs nothing, but is logged below.
  }
  logRefused("sendblue_typing", status);
}

/** "Read" under the person's text. Best effort and quick; never throws. */
export async function markSendblueRead(fetcher: Fetch, keys: SendblueKeys, chatId: string): Promise<void> {
  let status: number | null = null;
  try {
    status = await call(fetcher, keys, "/api/mark-read", chatOf(chatId), QUICK_TIMEOUT_MS);
  } catch {
    // A receipt that failed costs only the receipt, but is logged below.
  }
  logRefused("sendblue_read", status);
}

/** A bubble or receipt Sendblue refused, so "no typing bubble" can be told from "never asked". The status only, never the number. */
function logRefused(event: string, status: number | null): void {
  if (status !== null && status >= 200 && status < 300) return;
  console.log(JSON.stringify({ event, outcome: "refused", status }));
}

/**
 * Share Tex's iMessage Name & Photo into this chat, so Messages shows "Tex"
 * and the icon at the top, as for a saved contact (docs: Name & Photo
 * Sharing). The profile is set once per line, here, the first time it is
 * missing; it is applied after the call returns, so that first time shares
 * nothing and says so, and the next offer shares it. Sendblue needs an
 * iMessage already sent in the chat, so this runs after a reply. `refresh`
 * sets the profile again whatever is there (the photo changed), and shares
 * nothing until it is applied. Best effort: never throws.
 */
export async function shareSendblueProfile(
  fetcher: Fetch,
  keys: SendblueKeys,
  chatId: string,
  refresh = false,
): Promise<ProfileShared> {
  const chat = parseSendblueChat(chatId);
  if (chat === null) return "not_yet";
  if (refresh) {
    try {
      const status = await call(fetcher, keys, "/api/v2/contact-sharing/profile", {
        fromNumber: chat.line,
        firstName: PROFILE_NAME,
        lastName: "",
        photoUrl: PROFILE_PHOTO_URL,
      }, QUICK_TIMEOUT_MS);
      return status >= 200 && status < 300 ? "refreshed" : "not_yet";
    } catch {
      return "not_yet";
    }
  }
  const state = await getJson(fetcher, keys, `/api/v2/contact-sharing/state?fromNumber=${encodeURIComponent(chat.line)}`);
  if (state === null) return "not_yet";
  try {
    if (state.publishRecordPresent !== true) {
      // A profile already set is still being applied: leave it be.
      if (state.hasProfile !== true) {
        await call(fetcher, keys, "/api/v2/contact-sharing/profile", {
          fromNumber: chat.line,
          firstName: PROFILE_NAME,
          lastName: "",
          photoUrl: PROFILE_PHOTO_URL,
        }, QUICK_TIMEOUT_MS);
      }
      return "not_yet";
    }
    const status = await call(fetcher, keys, "/api/v2/contact-sharing/share", { fromNumber: chat.line, toNumber: chat.phone }, QUICK_TIMEOUT_MS);
    return status >= 200 && status < 300 ? "shared" : "not_yet";
  } catch {
    return "not_yet";
  }
}

/** What sharing the Name & Photo came to: shared into the chat, the profile set again (shared on a later offer), or neither yet. */
export type ProfileShared = "shared" | "refreshed" | "not_yet";

/**
 * The words of the message an inline reply answers, so Tex reads "this one"
 * the way the person meant it. Only a message in the same person's own chat
 * on this line is quoted: the handle comes from a signed webhook, and this
 * check makes sure it can never pull another person's message in. Null for
 * anything else, and for any failure: the reply is answered without it.
 */
export async function repliedToText(fetcher: Fetch, keys: SendblueKeys, handle: string, chatId: string): Promise<string | null> {
  const chat = parseSendblueChat(chatId);
  if (chat === null || handle === "" || handle.length > 200) return null;
  const parent = await getJson(fetcher, keys, `/api/v2/messages/${encodeURIComponent(handle)}`);
  if (parent === null || parent.number !== chat.phone) return null;
  if (typeof parent.group_id === "string" && parent.group_id !== "") return null;
  const ours = parent.is_outbound === true ? parent.from_number : parent.to_number;
  if (ours !== chat.line && parent.sendblue_number !== chat.line) return null;
  const content = typeof parent.content === "string" ? parent.content.trim() : "";
  return content === "" ? null : content.slice(0, MAX_QUOTED_TEXT);
}

/**
 * Whether the request carries our webhook secret. Both sides are hashed
 * first, so the comparison takes the same time whatever the header holds,
 * its length included. A short or missing secret refuses everything, which is
 * the safe direction.
 */
export async function verifySendblueSecret(secret: string, headers: Headers): Promise<boolean> {
  const expected = secret.trim();
  const given = headers.get("sb-signing-secret");
  if (expected.length < 16 || !given) return false;
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(expected), digest(given.trim())]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * A tapback as words: what Messages sends for a reaction ("Loved “…”",
 * "Laughed at “…”", "Removed a heart from “…”", "Reacted 🎉 to “…”"). Linq
 * sent reactions as their own event, which was never answered; this keeps a
 * heart from getting a reply.
 */
const TAPBACK = /^(?:Loved|Liked|Disliked|Laughed at|Emphasi[sz]ed|Questioned|Removed an? .{1,40} from|Reacted .{1,16} to) [“"][\s\S]*[”"]$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one shape of Sendblue's receive webhook this Worker acts on: an
 * inbound iMessage in a direct chat, from a phone number, with words or a
 * file. The same rules as Linq's (`inbound.ts`): groups and Apple ID email
 * senders are dropped on purpose. An SMS is kept, flagged `sms`, only so it is
 * answered without its words deciding anything.
 */
export function parseSendblueInbound(payload: unknown): Inbound {
  if (!isRecord(payload)) return { kind: "invalid" };
  const handle = payload.message_handle;
  if (typeof handle !== "string" || handle === "" || handle.length > 200) return { kind: "invalid" };
  if (payload.is_outbound !== false) return { kind: "ignored", reason: "event_type" };

  const group = payload.group_id;
  if ((typeof group === "string" && group !== "") || (payload.message_type !== undefined && payload.message_type !== "message")) {
    return { kind: "ignored", reason: "group" };
  }
  const from = payload.from_number;
  if (typeof from !== "string" || !E164.test(from)) return { kind: "ignored", reason: "sender" };
  // The phone is the login, and only Apple vouches for an iMessage sender.
  // An SMS still gets a fixed answer over iMessage, never one from its words:
  // a first text to a new number often goes green (`reply.ts`, `smsReply`).
  if (payload.service === "SMS") return smsInbound(payload, handle, line(payload), from);
  if (payload.service !== "iMessage") return { kind: "ignored", reason: "service" };

  const ours = line(payload);
  if (ours === undefined) return { kind: "invalid" };

  const text = typeof payload.content === "string" ? payload.content.trim() : "";
  if (TAPBACK.test(text) && !payload.media_url) return { kind: "ignored", reason: "reaction" };
  const attachments: InboundAttachment[] = [];
  if (typeof payload.media_url === "string" && payload.media_url !== "") {
    try {
      const url = new URL(payload.media_url);
      if (url.protocol === "https:") {
        const name = decodeURIComponent(url.pathname.split("/").pop() ?? "").slice(0, 200);
        // No type or size is sent; the bytes and the name tell (`attachments.ts`).
        attachments.push({ url: payload.media_url, mimeType: "", filename: name, size: null });
      }
    } catch {
      // not an address
    }
  }
  if (text.length === 0 && attachments.length === 0) return { kind: "ignored", reason: "empty" };
  // An inline reply names the message it answers; its words are fetched before queueing (`repliedToText`).
  const parent = isRecord(payload.reply_to) ? payload.reply_to.message_handle : undefined;
  const replyTo = typeof parent === "string" && parent !== "" && parent.length <= 200 ? parent : undefined;

  return {
    kind: "message",
    eventId: `sendblue:${handle}`,
    chatId: sendblueChatId(ours, from),
    from,
    messageId: handle,
    text: text.slice(0, MAX_INBOUND_TEXT),
    ...(attachments.length > 0 ? { attachments: attachments.slice(0, MAX_INBOUND_ATTACHMENTS) } : {}),
    ...(replyTo !== undefined ? { replyTo } : {}),
  };
}

/** Tex's line a delivery came in on. */
function line(payload: Record<string, unknown>): string | undefined {
  return [payload.sendblue_number, payload.to_number].find(
    (value): value is string => typeof value === "string" && E164.test(value),
  );
}

/**
 * An SMS, kept only so it is answered: no file and no inline reply are read
 * from it, and its words never decide anything (`reply.ts`, `smsReply`).
 */
function smsInbound(payload: Record<string, unknown>, handle: string, ours: string | undefined, from: string): Inbound {
  if (ours === undefined) return { kind: "invalid" };
  const text = typeof payload.content === "string" ? payload.content.trim() : "";
  if (TAPBACK.test(text)) return { kind: "ignored", reason: "reaction" };
  const hasMedia = typeof payload.media_url === "string" && payload.media_url !== "";
  if (text.length === 0 && !hasMedia) return { kind: "ignored", reason: "empty" };
  return {
    kind: "message",
    eventId: `sendblue:${handle}`,
    chatId: sendblueChatId(ours, from),
    from,
    messageId: handle,
    text: text.slice(0, MAX_INBOUND_TEXT),
    sms: true,
  };
}
