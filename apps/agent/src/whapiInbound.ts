/**
 * Whapi's webhook (`POST /whapi`): the deliveries this Worker acts on, read
 * into the same shapes Sendblue's are (`Inbound` for a 1:1 chat,
 * `GroupMessage` for a group), so the inbox and the group queue never know
 * which app a text came from.
 *
 * One delivery can carry several messages (`messages: [...]`), so this
 * returns a list. Everything else Whapi can send (statuses, chats, contacts,
 * presences, Tex's own messages) reads as nothing (a presence is only described
 * in the logs, `logPresenceShape`), and the delivery is still
 * answered 200 so it is not retried.
 *
 * The same rules as Sendblue's (`sendblue.ts`, `sendblueGroups.ts`):
 * - the sender is the phone WhatsApp registered (`phoneOfJid`); a `@lid`
 *   sender is never read as a phone;
 * - a reaction is a tapback (`reactions.ts`): 👍 Liked, ❤️ Loved, 😂 Laughed
 *   at, ‼️ Emphasized, ❓ Questioned, 👎 Disliked, anything else Reacted; an
 *   empty emoji takes one back. The message it is on is named (`on` /
 *   `reactionOn`), its words read before queueing;
 * - a WhatsApp reply carries the words it answers (`context.quoted_content`)
 *   in a 1:1 chat, taken as `quoted` (they are the person's own chat); in a
 *   group only the id is kept (`replyTo`), and the words are read only when
 *   Tex sent that message (`groupLine.ts`);
 * - an @mention of Tex reads as its name, so "@Tex what's on today" is a
 *   tag (`groupInbox.ts`), whether the words carry Tex's number or a `@lid`
 *   that `context.mentions` says is Tex (`namingTex`).
 */

import { MAX_INBOUND_ATTACHMENTS, MAX_INBOUND_TEXT, type Inbound, type InboundAttachment } from "./inbound";
import type { Reaction, Tapback } from "./reactions";
import type { GroupInbound, GroupMessage } from "./sendblueGroups";
import { MAX_QUOTED_TEXT } from "./sendblue";
import { E164, GROUP_JID, MESSAGE_ID, personOfJid, phoneOfJid, whapiChatId, whapiGroupId } from "./whapi";

export type WhapiEvent = Inbound | GroupInbound;

type Rec = Record<string, unknown>;

/** Whapi sends at most this many per delivery in practice; the rest are not read. */
const READ_LIMIT = 20;
const MESSAGE_TYPES = new Set(["text", "image", "video", "gif", "audio", "voice", "document", "sticker", "link_preview", "action"]);
const MEDIA_TYPES = new Set(["image", "video", "gif", "audio", "voice", "document", "sticker"]);
/** Tapbacks in a 1:1 chat, by emoji with skin tones and variation selectors removed. */
const TAPBACKS = new Map<string, Tapback>([
  ["\u{1F44D}", "Liked"],
  ["❤", "Loved"],
  ["\u{1F44E}", "Disliked"],
  ["\u{1F602}", "Laughed at"],
  ["‼", "Emphasized"],
  ["❓", "Questioned"],
  ["❔", "Questioned"],
]);

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bareEmoji(emoji: string): string {
  return emoji.replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, "");
}

/** Every message in one delivery, read; `line` is Tex's own WhatsApp number (E.164). */
export function parseWhapiWebhook(payload: unknown, line: string): WhapiEvent[] {
  if (isRecord(payload) && Array.isArray(payload.presences)) logPresenceShape(payload);
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return [];
  return payload.messages.slice(0, READ_LIMIT).map((message) => parseMessage(message, line));
}

/**
 * A presences delivery (typing) is only described, never acted on: its keys, each status, and whether
 * `contact_id` names a group or a person, never the id (Jhonatan, 2026-11-01: build group typing only if
 * Whapi's payload names the group; `docs/decisions/texting-assistant/whapi-presence-probe.md`).
 */
function logPresenceShape(payload: Record<string, unknown>): void {
  const presences = (payload.presences as unknown[]).slice(0, READ_LIMIT);
  for (const presence of presences) {
    const keys = [...Object.keys(payload).filter((key) => key !== "presences"), ...(isRecord(presence) ? Object.keys(presence) : [])].sort().slice(0, 20).join(":");
    const status = isRecord(presence) && typeof presence.status === "string" && /^[a-z_]{1,20}$/.test(presence.status) ? presence.status : "other";
    const id = isRecord(presence) && typeof presence.contact_id === "string" ? presence.contact_id : "";
    const idKind = id.endsWith("@g.us") ? "group" : /^\d{6,16}(?:@s\.whatsapp\.net)?$/.test(id) ? "person" : "other";
    console.log(JSON.stringify({ event: "whapi_presence_shape", keys, status, idKind }));
  }
}

function logShape(message: unknown): void {
  const type = isRecord(message) && typeof message.type === "string" ? message.type.slice(0, 40) : null;
  const keys = isRecord(message) ? Object.keys(message).sort().slice(0, 40) : [];
  console.log(JSON.stringify({ event: "whapi_shape", type, keys }));
}

function invalid(message: unknown): WhapiEvent {
  logShape(message);
  return { kind: "invalid" };
}

function skipped(message: unknown): WhapiEvent {
  logShape(message);
  return { kind: "ignored", reason: "event_type" };
}

function parseMessage(message: unknown, line: string): WhapiEvent {
  if (!E164.test(line) || !isRecord(message) || typeof message.id !== "string" || !MESSAGE_ID.test(message.id)) {
    return invalid(message);
  }
  // Tex's own messages, including ones Dev2 types on the phone, are never answered.
  if (message.from_me === true) return { kind: "ignored", reason: "event_type" };
  const type = message.type;
  if (typeof type !== "string" || !MESSAGE_TYPES.has(type)) return skipped(message);
  const action = type === "action" ? rec(message.action) : null;
  if (type === "action" && (action === null || action.type !== "reaction")) return skipped(message);
  if (typeof message.chat_id !== "string" || message.chat_id === "") return invalid(message);

  if (GROUP_JID.test(message.chat_id)) return groupEvent(message, message.id, message.chat_id, line, type, action);
  return directEvent(message, message.id, message.chat_id, line, type, action);
}

function rec(value: unknown): Rec | null {
  return isRecord(value) ? value : null;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

/** A text's body, a link preview's body, or a file's caption, trimmed. */
function wordsOf(message: Rec, media: Rec | null): string {
  return (firstString(rec(message.text)?.body, rec(message.link_preview)?.body, media?.caption) ?? "").trim();
}

/** A file with an https address Whapi fetches, or null: no address, or not https, is no attachment. */
function attachmentOf(media: Rec): InboundAttachment | null {
  if (typeof media.link !== "string") return null;
  let url: URL;
  try {
    url = new URL(media.link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  let last = "";
  try {
    last = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  } catch {
    last = "";
  }
  return {
    url: media.link,
    mimeType: typeof media.mime_type === "string" ? media.mime_type.toLowerCase() : "",
    filename: (firstString(media.file_name, media.filename) || last).slice(0, 200),
    size: typeof media.file_size === "number" && Number.isFinite(media.file_size) ? media.file_size : null,
  };
}

/** The words of the message a reply answers, when WhatsApp sent them; never a handle. */
function quotedOf(context: Rec | null): string | undefined {
  const content = rec(context?.quoted_content);
  const words = (firstString(content?.body, content?.caption) ?? "").trim().slice(0, MAX_QUOTED_TEXT);
  return words === "" ? undefined : words;
}

function directEvent(message: Rec, id: string, chatId: string, line: string, type: string, action: Rec | null): WhapiEvent {
  // A `@lid` or a broadcast is no phone: nothing is answered from it.
  const phone = phoneOfJid(chatId);
  if (phone === null) return { kind: "ignored", reason: "sender" };
  const chat = whapiChatId(line, phone);
  if (action !== null) {
    if (typeof action.target !== "string" || !MESSAGE_ID.test(action.target)) return invalid(message);
    return { kind: "reaction", eventId: `whapi:${id}`, chatId: chat, from: phone, messageId: id, reaction: tapbackOf(action.emoji), on: action.target };
  }
  const media = MEDIA_TYPES.has(type) ? rec(message[type]) : null;
  const text = wordsOf(message, media);
  const attachment = media === null ? null : attachmentOf(media);
  if (text === "" && attachment === null) return { kind: "ignored", reason: "empty" };
  const context = rec(message.context);
  const quoted = quotedOf(context);
  const threaded = typeof context?.quoted_id === "string" && context.quoted_id !== "";
  return {
    kind: "message",
    eventId: `whapi:${id}`,
    chatId: chat,
    from: phone,
    messageId: id,
    text: text.slice(0, MAX_INBOUND_TEXT),
    ...(attachment !== null ? { attachments: [attachment] } : {}),
    ...(threaded ? { threaded: true as const, ...(quoted !== undefined ? { quoted } : {}) } : {}),
  };
}

function groupEvent(message: Rec, id: string, chatId: string, line: string, type: string, action: Rec | null): WhapiEvent {
  if (typeof message.from !== "string" || message.from === "") return invalid(message);
  const person = personOfJid(message.from);
  const base = {
    kind: "group-message" as const,
    eventId: `whapi:${id}`,
    groupId: whapiGroupId(chatId),
    line,
    from: person,
    participants: [person],
    messageId: id,
  };
  if (action !== null) {
    if (typeof action.target !== "string" || !MESSAGE_ID.test(action.target)) return invalid(message);
    const emoji = typeof action.emoji === "string" ? action.emoji.trim() : "";
    // Every reaction is read (Dev2, 2026-11-01): a named tapback by its name, any other emoji as itself.
    return { ...base, text: emoji, reaction: tapbackOf(emoji), reactionOn: action.target } satisfies GroupMessage;
  }
  const media = MEDIA_TYPES.has(type) ? rec(message[type]) : null;
  const text = namingTex(wordsOf(message, media), rec(message.context)?.mentions, line).trim().slice(0, MAX_INBOUND_TEXT);
  const attachment = media === null ? null : attachmentOf(media);
  if (text === "" && attachment === null) return { kind: "ignored", reason: "empty" };
  const quotedId = rec(message.context)?.quoted_id;
  const replyTo = typeof quotedId === "string" && MESSAGE_ID.test(quotedId) ? quotedId : undefined;
  return {
    ...base,
    text,
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(attachment !== null ? { attachments: [attachment] } : {}),
  };
}

/**
 * A group text with each @mention of Tex read as its name, so "@Tex where is
 * the page" is a tag (`groupInbox.ts`) and the digits never reach the gateway.
 *
 * WhatsApp writes a mention into the words as `@<digits>` and lists who it
 * names in `context.mentions`, in the same order. In a group the digits are
 * usually the person's private group id (a `@lid`), not their number, while
 * the list names Tex by its phone (seen 2026-10-27), so the list says which
 * `@<digits>` is Tex. Tex's own number written out reads as Tex too. When the
 * list names Tex but the words hold no matching mention, the text is read as
 * addressed to Tex all the same.
 */
export function namingTex(words: string, mentions: unknown, line: string): string {
  const digits = line.slice(1);
  const listed = Array.isArray(mentions) ? mentions.slice(0, 50).map((id) => (typeof id === "string" ? phoneOfJid(id) : null)) : [];
  const texListed = listed.includes(line);
  let index = 0;
  let named = false;
  const text = words.replace(/@(\d{5,20})(?!\d)/g, (whole, found: string) => {
    const at = index++;
    if (found === digits || (listed.length > at && listed[at] === line)) {
      named = true;
      return "Tex";
    }
    return whole;
  });
  return texListed && !named ? `Tex ${text}` : text;
}

/** A 1:1 reaction: an empty emoji takes the tapback back; any other emoji names one. */
function tapbackOf(emoji: unknown): Reaction {
  const raw = typeof emoji === "string" ? emoji.trim() : "";
  if (raw === "") return { how: "Liked", words: "", removed: true };
  const how = TAPBACKS.get(bareEmoji(raw));
  return how === undefined ? { how: "Reacted", words: "", emoji: [...raw].slice(0, 8).join("") } : { how, words: "" };
}

export { MAX_INBOUND_ATTACHMENTS, MAX_INBOUND_TEXT };
export type { InboundAttachment };
