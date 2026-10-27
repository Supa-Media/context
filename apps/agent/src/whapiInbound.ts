/**
 * Whapi's webhook (`POST /whapi`): the deliveries this Worker acts on, read
 * into the same shapes Sendblue's are (`Inbound` for a 1:1 chat,
 * `GroupMessage` for a group), so the inbox and the group queue never know
 * which app a text came from.
 *
 * One delivery can carry several messages (`messages: [...]`), so this
 * returns a list. Everything else Whapi can send (statuses, chats, contacts,
 * presences, Tex's own messages) reads as nothing, and the delivery is still
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
 * - an @mention of Tex's own number reads as its name, so "@Tex what's on
 *   today" is a tag (`groupInbox.ts`).
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
/** The only reactions a group reads: a like and a love (`thumbs.ts`). */
const GROUP_TAPBACKS = new Map<string, Tapback>([
  ["\u{1F44D}", "Liked"],
  ["❤", "Loved"],
]);

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bareEmoji(emoji: string): string {
  return emoji.replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, "");
}

/** Every message in one delivery, read; `line` is Tex's own WhatsApp number (E.164). */
export function parseWhapiWebhook(payload: unknown, line: string): WhapiEvent[] {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return [];
  return payload.messages.slice(0, READ_LIMIT).map((message) => parseMessage(message, line));
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
    const reaction = groupTapbackOf(emoji);
    if (reaction === null) return { kind: "ignored", reason: "reaction" };
    return { ...base, text: emoji, reaction, reactionOn: action.target } satisfies GroupMessage;
  }
  const media = MEDIA_TYPES.has(type) ? rec(message[type]) : null;
  // Tex is named by its own number in a mention; it reads as its name, and the digits never reach the gateway.
  const digits = line.slice(1);
  const text = wordsOf(message, media).replace(new RegExp(`@${digits}(?!\\d)`, "g"), "Tex").trim().slice(0, MAX_INBOUND_TEXT);
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

/** A 1:1 reaction: an empty emoji takes the tapback back; any other emoji names one. */
function tapbackOf(emoji: unknown): Reaction {
  const raw = typeof emoji === "string" ? emoji.trim() : "";
  if (raw === "") return { how: "Liked", words: "", removed: true };
  return { how: TAPBACKS.get(bareEmoji(raw)) ?? "Reacted", words: "" };
}

/** A group's reaction, or null for one a group does not read (`ignored: reaction`). */
function groupTapbackOf(raw: string): Reaction | null {
  if (raw === "") return { how: "Liked", words: "", removed: true };
  const how = GROUP_TAPBACKS.get(bareEmoji(raw));
  return how === undefined ? null : { how, words: "" };
}

export { MAX_INBOUND_ATTACHMENTS, MAX_INBOUND_TEXT };
export type { InboundAttachment };
