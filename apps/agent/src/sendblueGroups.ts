/**
 * Sendblue group chats (docs.sendblue.com: Groups): the receive webhook's
 * group shape, sending into a group, and reading who is in one.
 *
 * A group message carries `group_id`, `participants` (numbers) and
 * `group_display_name` on the same receive webhook as a 1:1 text. Typing
 * bubbles and read receipts are 1:1 only, and Tex cannot leave a group, so a
 * group sees neither and "Tex, stop" mutes it instead (`groupInbox.ts`).
 *
 * Nothing here decides who may read what: the participant list goes to the
 * control plane (`/agent-texts/group`), which resolves the chat to one shared
 * workspace or to none. A group's display name is never read: anyone in the
 * chat can set it.
 */

import { MAX_REPLY_TEXT, ServiceError, type Fetch } from "./clients";
import { MAX_INBOUND_TEXT } from "./inbound";
import { readRemovedTapback, readTapback, type Reaction } from "./reactions";
import { holdsAsYes, takesBackYes } from "./thumbs";
import { call, E164, getJson, handleOf, isLinkPreview, isRecord, line, sendCall, TAPBACK, type SendblueKeys } from "./sendblue";
import type { InboundAttachment } from "./inbound";

/** Sendblue's group ids are uuids; anything much longer is not one. */
const MAX_GROUP_ID = 200;
/** More entries than this is not a chat Tex answers in (`apps/convex/functions/textGroups.ts` allows 32 people). */
export const MAX_GROUP_LIST = 64;

export type GroupMessage = {
  kind: "group-message";
  eventId: string;
  groupId: string;
  /** Tex's line it came in on. */
  line: string;
  from: string;
  /** Everyone the webhook lists, as given: an entry that is not a phone stays, and counts as somebody unknown. */
  participants: string[];
  messageId: string;
  text: string;
  replyTo?: string;
  /** A green-bubble group: answered with one fixed line, never with notes. */
  sms?: true;
  /** A like on one of Tex's asks, or one taken back (`thumbs.ts`); `text` is then the tapback's own words. */
  reaction?: Reaction;
  /**
   * WhatsApp names the message a reaction is on rather than quoting it: its
   * words are read before the reaction is queued, and only when Tex sent it in
   * this same group (`index.ts`, `groupLine.ts` `readOwnMessage`). Dropped then.
   */
  reactionOn?: string;
  /**
   * A picture or file sent in the chat, by Sendblue's address only, never its
   * bytes: fetched when a turn reads it, as a 1:1 text's are (`attachments.ts`).
   * A link's preview card is not one (`isLinkPreview`).
   */
  attachments?: InboundAttachment[];
  /** A chat routine's run, queued by this Worker itself and never by a webhook (`groupRoutines.ts`). */
  routine?: { runId: string; path: string };
};

export type GroupInbound = GroupMessage | { kind: "ignored"; reason: string } | { kind: "invalid" };

/**
 * A receive webhook's group message, or null when the payload is not a group
 * one (then `parseSendblueInbound` reads it as before). Tapbacks, files
 * without words and Tex's own messages are ignored.
 */
export function parseSendblueGroup(payload: unknown): GroupInbound | null {
  if (!isRecord(payload)) return null;
  const groupId = payload.group_id;
  if (typeof groupId !== "string" || groupId === "") return null;
  const handle = payload.message_handle;
  if (typeof handle !== "string" || handle === "" || handle.length > 200 || groupId.length > MAX_GROUP_ID) return { kind: "invalid" };
  if (payload.is_outbound !== false) return { kind: "ignored", reason: "event_type" };
  if (payload.message_type !== undefined && payload.message_type !== "group" && payload.message_type !== "message") {
    return { kind: "ignored", reason: "event_type" };
  }
  const from = payload.from_number;
  if (typeof from !== "string" || !E164.test(from)) return { kind: "ignored", reason: "sender" };
  const ours = line(payload);
  if (ours === undefined) return { kind: "invalid" };
  if (payload.service !== "iMessage" && payload.service !== "SMS") return { kind: "ignored", reason: "service" };
  const listed = Array.isArray(payload.participants) ? payload.participants : [];
  if (listed.length > MAX_GROUP_LIST) return { kind: "ignored", reason: "group_size" };
  const participants = listed.map((entry) => (typeof entry === "string" ? entry.slice(0, 320) : "?"));
  // The sender is in the chat whatever the list says.
  if (!participants.includes(from)) participants.push(from);
  const text = typeof payload.content === "string" ? payload.content.trim() : "";
  // An SMS group never has its files read: it is answered with one fixed line (`groupInbox.ts`).
  const attachment = payload.service === "SMS" || (text !== "" && TAPBACK.test(text)) ? null : sentFile(payload.media_url, text);
  if (text === "" && attachment === null) return { kind: "ignored", reason: "empty" };
  // A like on an ask, or one taken back off it, is read: it may be the asker's yes (`thumbs.ts`). Any other tapback is not.
  const reaction = TAPBACK.test(text) ? (readTapback(text) ?? readRemovedTapback(text)) : null;
  if (TAPBACK.test(text) && (reaction === null || !(holdsAsYes(reaction) || takesBackYes(reaction)))) return { kind: "ignored", reason: "reaction" };
  const replyTo = handleOf(payload.reply_to);
  return {
    kind: "group-message",
    eventId: `sendblue:${handle}`,
    groupId,
    line: ours,
    from,
    participants,
    messageId: handle,
    text: text.slice(0, MAX_INBOUND_TEXT),
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(payload.service === "SMS" ? { sms: true as const } : {}),
    ...(reaction !== null ? { reaction } : {}),
    ...(attachment !== null ? { attachments: [attachment] } : {}),
  };
}

/** The file a group message carried, or null: none, not https, or a link's preview card (`isLinkPreview`). */
function sentFile(mediaUrl: unknown, text: string): InboundAttachment | null {
  if (typeof mediaUrl !== "string" || mediaUrl === "" || isLinkPreview(mediaUrl, text)) return null;
  try {
    const url = new URL(mediaUrl);
    if (url.protocol !== "https:") return null;
    // No type or size is sent; the bytes and the name tell (`attachments.ts`).
    return { url: mediaUrl, mimeType: "", filename: decodeURIComponent(url.pathname.split("/").pop() ?? "").slice(0, 200), size: null };
  } catch {
    return null;
  }
}

/**
 * Every phone-like entry in a members answer, wherever it sits. The fields of
 * `GET /api/v2/groups/{id}` are not documented, so the read takes any string
 * that is a phone number, in any list of strings or of `{ number }`-like rows.
 */
function phonesIn(value: unknown, found: Set<string>, depth = 0): void {
  if (depth > 4) return;
  if (typeof value === "string") {
    if (E164.test(value)) found.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, MAX_GROUP_LIST)) phonesIn(entry, found, depth + 1);
    return;
  }
  if (isRecord(value)) for (const inner of Object.values(value)) phonesIn(inner, found, depth + 1);
}

/** Who Sendblue says is in the group, or null when that couldn't be read. Quick, never throws. */
export async function readGroupMembers(fetcher: Fetch, keys: SendblueKeys, groupId: string): Promise<string[] | null> {
  const body = await getJson(fetcher, keys, `/api/v2/groups/${encodeURIComponent(groupId)}`);
  if (body === null) return null;
  const found = new Set<string>();
  phonesIn(body, found);
  return found.size > 0 ? [...found] : null;
}

/**
 * One text into the group from the line it came in on (`from_number` is
 * required: a group with two of our lines in it is otherwise ambiguous),
 * threaded under `replyTo` when given; a refused threaded send goes again
 * plain, as 1:1 does. Its `message_handle` when Sendblue names one.
 */
export async function sendGroupText(
  fetcher: Fetch,
  keys: SendblueKeys,
  chat: { line: string; groupId: string },
  text: string,
  replyTo?: string,
): Promise<string | undefined> {
  const plain = { from_number: chat.line, group_id: chat.groupId, content: text.slice(0, MAX_REPLY_TEXT) };
  if (replyTo) {
    const sent = await sendCall(fetcher, keys, { ...plain, reply_to: { message_handle: replyTo } }, "/api/send-group-message");
    if (sent.status >= 200 && sent.status < 300) return sent.handle;
    if (sent.status !== 400) throw new ServiceError("sendblue", sent.status);
  }
  const sent = await sendCall(fetcher, keys, plain, "/api/send-group-message");
  if (sent.status < 200 || sent.status >= 300) throw new ServiceError("sendblue", sent.status);
  return sent.handle;
}

/** A picture into a group, by an address Sendblue fetches, threaded like the text it goes with. */
export async function sendGroupMedia(fetcher: Fetch, keys: SendblueKeys, chat: { line: string; groupId: string }, url: string, replyTo?: string): Promise<void> {
  const plain = { from_number: chat.line, group_id: chat.groupId, media_url: url };
  if (replyTo) {
    const sent = await sendCall(fetcher, keys, { ...plain, reply_to: { message_handle: replyTo } }, "/api/send-group-message");
    if (sent.status >= 200 && sent.status < 300) return;
    if (sent.status !== 400) throw new ServiceError("sendblue", sent.status);
  }
  const sent = await sendCall(fetcher, keys, plain, "/api/send-group-message");
  if (sent.status < 200 || sent.status >= 300) throw new ServiceError("sendblue", sent.status);
}

/** A tapback on a group message, the same for every tagger so it says nothing about them. Best effort; never throws. */
export async function reactInGroup(fetcher: Fetch, keys: SendblueKeys, chat: { line: string }, messageHandle: string, reaction: string): Promise<void> {
  let status: number | null = null;
  try {
    status = await call(fetcher, keys, "/api/send-reaction", { from_number: chat.line, message_handle: messageHandle, reaction }, 3_000);
  } catch {
    // costs only the tapback
  }
  if (status !== null && status >= 200 && status < 300) return;
  console.log(JSON.stringify({ event: "sendblue_group_reaction", outcome: "refused", status }));
  // An emoji the line refuses still leaves the chat a sign it landed, as in a 1:1 (`line.ts`).
  if (reaction !== "like") await reactInGroup(fetcher, keys, chat, messageHandle, "like");
}

/**
 * The words of a message replied to, only when it is one Tex sent in this
 * same group: anyone else's words, or another chat's, are never read.
 */
export async function readOwnGroupMessage(fetcher: Fetch, keys: SendblueKeys, handle: string, chat: { line: string; groupId: string }): Promise<string | null> {
  const parent = await getJson(fetcher, keys, `/api/v2/messages/${encodeURIComponent(handle)}`);
  if (parent === null || parent.group_id !== chat.groupId || parent.is_outbound !== true) return null;
  if (parent.from_number !== chat.line && parent.sendblue_number !== chat.line) return null;
  const content = typeof parent.content === "string" ? parent.content.trim() : "";
  return content === "" ? null : content.slice(0, 500);
}
