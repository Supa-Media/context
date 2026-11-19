/**
 * Photon's inbound events (Contract A, `/mnt/project-files/photon/plan.md`):
 * one `PhotonEvent` from the bridge, read into the shapes Sendblue's and
 * Whapi's are, so the inbox and the group queue never know which line a text
 * came in on.
 *
 * The same rules as Sendblue's (`sendblue.ts`, `sendblueGroups.ts`):
 * - a message from Tex's own side (`fromMe`) is never read;
 * - the sender is a phone number, E.164, or the event is ignored: an Apple ID
 *   email is not one Tex answers;
 * - an SMS or an RCS text is kept only so it gets its fixed answer; its files are not read;
 * - a 1:1 message from one of our iMessage apps is read as the words the card
 *   stands for (`cardReply`), Apple's own link preview is read as its words (the
 *   link), as a group's always is, and any other app's card is not a message;
 * - a message that is not read but names its chat says which (`chatId` or
 *   `groupId`), so the chat's history can show what was dropped;
 * - a link's preview file is not something the person sent (`isPreviewFile`);
 * - a tapback is a reaction, read as its name; a removal is marked `removed`;
 *   and a tapback on Tex's own text carries that text (`onTex`), as Sendblue's does.
 *
 * Pure: no fetch, no storage. The caller gives each picture's address in
 * `options.attachmentUrl` (`photon.ts`); a picture with none is left off.
 */

import { cardReply } from "./cardChats";
import { cutText, MAX_INBOUND_ATTACHMENTS, MAX_INBOUND_TEXT, type Inbound, type InboundAttachment } from "./inbound";
import { photonChatId, photonGroupId } from "./photon";
import type { Reaction, Tapback } from "./reactions";
import { cleanGroupName, type GroupInbound, type GroupMessage } from "./sendblueGroups";
import { E164, isPreviewFile, MAX_QUOTED_TEXT } from "./sendblue";

/** An edit or an unsend of a message in a chat: either goes to the chat's `edit` step (`editStep.ts`, node `edit`). */
export type PhotonSideEvent = {
  kind: "edited" | "unsent";
  eventId: string;
  /** A 1:1 chat's id, or a group's; exactly one is set. */
  chatId?: string;
  groupId?: string;
  /** Tex's line it came in on. */
  line: string;
  from: string;
  /** A group's: everyone the event lists, as a group message's are. */
  participants?: string[];
  /** The guid of the message edited or unsent. */
  messageId: string;
  /** An edit's new words, cut as a text's are. */
  text?: string;
  /** An edit's words before, when the bridge still held them (`previousText`): somebody's own words, as given. */
  previous?: string;
  /** When Apple stamped it, as the bridge sent it. */
  at: string;
};

/** An edit or an unsend, as the chat's `edit` step takes it: an edit always has its new words. */
export type PhotonEdit = PhotonSideEvent;

/** A message dropped on its way in, with the chat it was sent in when the event names one, so its history can show the drop. */
export type PhotonDropped = { kind: "ignored"; reason: string; chatId?: string; groupId?: string; line?: string; from?: string; participants?: string[] };

export type PhotonParsed = Inbound | GroupInbound | PhotonSideEvent | PhotonDropped | { kind: "invalid" };

/**
 * Apple's own rich link preview: a text whose words are a link, which iMessage draws as a card. It is the person's
 * words, never another app's card (2026-11-17: the 1:1 path dropped every link sent with a preview as "app_card").
 */
export const LINK_PREVIEW_BUNDLE = "com.apple.messages.URLBalloonProvider";
const LONE_LINK = /^https?:\/\/\S+$/i;

/** True for Apple's link preview: its bundle id, or a card with no app address whose words are one link. */
export function isLinkPreview(bundleId: string, appUrl: unknown, text: string): boolean {
  return bundleId === LINK_PREVIEW_BUNDLE || (typeof appUrl !== "string" && LONE_LINK.test(text));
}

export type PhotonParseOptions = {
  /** The address a picture is served at, by its guid; undefined leaves that picture off. */
  attachmentUrl?: (guid: string) => string | undefined;
};

type Rec = Record<string, unknown>;

const EVENT_TYPES = new Set([
  "message.received",
  "message.edited",
  "message.unsent",
  "message.reactionAdded",
  "message.reactionRemoved",
  "message.read",
  "group.changed",
  "chat.other",
]);
/** Kinds the bridge reads that are not a message here: described, then dropped with a 200. */
const NOT_A_MESSAGE = new Set(["message.read", "group.changed", "chat.other"]);
const NOT_A_MESSAGE_REASON: Record<string, string> = { "message.read": "read", "group.changed": "group_change", "chat.other": "chat_event" };

/** Photon's reaction kinds, read onto the tapback names `sendblueTapbacks.ts` uses. `emoji` and `sticker` are read apart (`reactionOf`). */
const TAPBACKS: Record<string, Tapback> = {
  love: "Loved",
  like: "Liked",
  dislike: "Disliked",
  laugh: "Laughed at",
  emphasize: "Emphasized",
  question: "Questioned",
};

/**
 * A group's Photon guid: `any;+;<id>`. Capped so the encoded id (`photonGroupId`, 6 more characters of prefix and
 * about 4/3 of the guid) stays within the gateway's 128-character chat id limit (`log.js` CHAT).
 */
const GROUP_GUID = /^any;\+;[^\s;]{1,72}$/;
const MAX_ID = 200;
const MAX_NAME = 200;
const MAX_PARTICIPANTS = 64;
const MAX_EMOJI = 16;
/** A sticker's reaction, as its text reads ("Reacted with a sticker to …"). */
export const STICKER = "with a sticker";

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string no longer than `max`, or null. */
function idOf(value: unknown, max = MAX_ID): string | null {
  return typeof value === "string" && value !== "" && value.length <= max ? value : null;
}

/** The chat as this event names it: a 1:1 by the other party's phone, a group by its id. */
type Where = { chatId: string; groupId?: undefined } | { groupId: string; chatId?: undefined };

type Envelope = { type: string; eventId: string; line: string; where: Where | null; from: string | undefined; at: string };

/** The fields every event carries, or null when one is missing or malformed. `where` is null for a 1:1 without a phone, or a group whose guid is not one. */
function envelopeOf(body: Rec): Envelope | null {
  const type = body.type;
  const eventId = idOf(body.eventId);
  const at = idOf(body.at, 64);
  const line = typeof body.line === "string" && E164.test(body.line) ? body.line : null;
  const chat = isRecord(body.chat) ? body.chat : null;
  if (typeof type !== "string" || !EVENT_TYPES.has(type) || eventId === null || at === null || line === null || chat === null) return null;
  if (typeof body.fromMe !== "boolean" || idOf(chat.guid) === null) return null;
  const from = typeof body.from === "string" ? body.from : undefined;
  if (chat.kind === "group") {
    const guid = typeof chat.guid === "string" && GROUP_GUID.test(chat.guid) ? chat.guid : null;
    return { type, eventId, line, at, from, where: guid === null ? null : { groupId: photonGroupId(guid) } };
  }
  if (chat.kind !== "dm") return null;
  // A 1:1 chat is named by the other party's phone: the sender of a message, or the one a reaction or edit came from.
  return { type, eventId, line, at, from, where: from !== undefined && E164.test(from) ? { chatId: photonChatId(line, from) } : null };
}

/** The participants a group event lists, as Sendblue's group shape does: an entry that is not a string counts as somebody unknown. */
function participantsOf(chat: Rec, from: string): string[] {
  const listed = Array.isArray(chat.participants) ? chat.participants.slice(0, MAX_PARTICIPANTS) : [];
  const participants = listed.map((entry) => (typeof entry === "string" ? entry.slice(0, 320) : "?"));
  if (!participants.includes(from)) participants.push(from);
  return participants;
}

/**
 * The words a tapback was on, as the bridge read them: Tex's own text carries its words (`onTex`), another person's
 * message is flagged `onOther` with its words apart (`otherWords`), and a target the bridge could not tell is neither.
 */
function targetOf(reaction: Rec): Pick<Reaction, "words" | "onTex" | "onOther" | "otherWords"> {
  const read = typeof reaction.targetText === "string" ? reaction.targetText.trim().slice(0, MAX_QUOTED_TEXT) : "";
  if (reaction.targetFromMe === true) return read === "" ? { words: "" } : { words: read, onTex: true as const };
  // Somebody else's words are shown with the tapback (`otherWords`), never taken for an ask of Tex's (`words`).
  if (reaction.targetFromMe === false) return { words: "", onOther: true as const, ...(read !== "" ? { otherWords: read } : {}) };
  return { words: "" };
}

/** A reaction's tapback, or null when it names nothing this Worker reads (a kind it does not know). */
function reactionOf(reaction: Rec, removed: boolean): Reaction | null {
  const kind = reaction.kind;
  if (typeof kind !== "string") return null;
  const removal = removed ? { removed: true as const } : {};
  const target = targetOf(reaction);
  const how = TAPBACKS[kind];
  if (how !== undefined) return { how, ...target, ...removal };
  const emoji = reaction.emoji;
  if (kind === "emoji" && typeof emoji === "string" && emoji !== "") {
    return { how: "Reacted", ...target, emoji: [...emoji].slice(0, MAX_EMOJI).join(""), ...removal };
  }
  // A sticker stuck on a message, or a sticker tapback: a reaction whose own text names it (Sendblue never sent these).
  if (kind === "sticker") return { how: "Reacted", ...target, emoji: STICKER, ...removal };
  return null;
}

/**
 * The pictures and files a message carries that have an address, as `InboundAttachment`s. None for an SMS, whose files
 * are not read, and none that are a link's preview of the words (`isPreviewFile`).
 */
function attachmentsOf(message: Rec, text: string, options: PhotonParseOptions): InboundAttachment[] {
  const listed = Array.isArray(message.attachments) ? message.attachments : [];
  return listed
    .flatMap((item): InboundAttachment[] => {
      if (!isRecord(item)) return [];
      const guid = idOf(item.guid);
      const name = typeof item.name === "string" ? item.name.slice(0, MAX_NAME) : "";
      const url = guid === null ? undefined : options.attachmentUrl?.(guid);
      if (guid === null || url === undefined || isPreviewFile(name, text)) return [];
      return [
        {
          url,
          mimeType: typeof item.mimeType === "string" ? item.mimeType.toLowerCase().slice(0, 100) : "",
          filename: name,
          size: typeof item.size === "number" && Number.isFinite(item.size) ? item.size : null,
        },
      ];
    })
    .slice(0, MAX_INBOUND_ATTACHMENTS);
}

/** A `message.received`: a 1:1 message, or a group's. */
function received(body: Rec, env: Envelope, options: PhotonParseOptions): PhotonParsed {
  const message = isRecord(body.message) ? body.message : null;
  const guid = message === null ? null : idOf(message.guid);
  if (message === null || guid === null) return { kind: "invalid" };
  if (env.from === undefined || !E164.test(env.from)) return { kind: "ignored", reason: "sender" };
  // RCS (an Android phone) is answered as an SMS is, with the fixed answer and never its words (`reply.ts` `smsReply`).
  const service = message.service === "RCS" ? "SMS" : message.service;
  if (service !== "iMessage" && service !== "SMS") {
    const where = env.where?.groupId !== undefined ? { groupId: env.where.groupId, line: env.line, participants: participantsOf(isRecord(body.chat) ? body.chat : {}, env.from) } : env.where?.chatId !== undefined ? { chatId: env.where.chatId } : {};
    return { kind: "ignored", reason: "service", ...where, from: env.from };
  }
  const sms = service === "SMS";
  const from = env.from;
  if (env.where?.groupId !== undefined) {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const attachments = sms ? [] : attachmentsOf(message, text, options);
    const participants = participantsOf(isRecord(body.chat) ? body.chat : {}, from);
    if (text === "" && attachments.length === 0) return { kind: "ignored", reason: "empty", groupId: env.where.groupId, line: env.line, from, participants };
    const replyTo = idOf(message.replyTo);
    // An inline reply to one of Tex's own texts carries those words when the bridge read them, as a 1:1 reply's do.
    const quoted = replyTo !== null && message.replyToFromMe === true && typeof message.replyToText === "string" ? message.replyToText.trim().slice(0, MAX_QUOTED_TEXT) : "";
    const group: GroupMessage = {
      kind: "group-message",
      eventId: `photon:${guid}`,
      groupId: env.where.groupId,
      line: env.line,
      from,
      participants,
      messageId: guid,
      ...cutText(text),
      ...(replyTo !== null ? { replyTo } : {}),
      ...(quoted !== "" ? { quoted } : {}),
      ...(sms ? { sms: true as const } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    return group;
  }
  if (env.where?.chatId === undefined) return { kind: "invalid" };
  // A 1:1 message from one of our iMessage apps is what its card says, and another app's card is not a message (`cardChats.ts`).
  let text = typeof message.text === "string" ? message.text.trim() : "";
  let viaCard: { ask?: string } | undefined;
  const chatId = env.where.chatId;
  if (typeof message.balloonBundleId === "string" && !isLinkPreview(message.balloonBundleId, message.appUrl, text)) {
    const card = typeof message.appUrl === "string" ? cardReply({ extensionBundleId: message.balloonBundleId, url: message.appUrl }) : null;
    if (card === null) return { kind: "ignored", reason: "app_card", chatId, from };
    text = card.text;
    viaCard = card.ask !== undefined ? { ask: card.ask } : {};
  }
  const attachments = sms ? [] : attachmentsOf(message, text, options);
  if (text === "" && attachments.length === 0) return { kind: "ignored", reason: "empty", chatId, from };
  const replyTo = idOf(message.replyTo);
  // The words an inline reply answers, when the bridge read them (`replyToText`): somebody else's words, carried as `quoted`.
  const quoted = typeof message.replyToText === "string" ? message.replyToText.trim().slice(0, MAX_QUOTED_TEXT) : "";
  return {
    kind: "message",
    eventId: `photon:${guid}`,
    chatId: env.where.chatId,
    from,
    messageId: guid,
    ...cutText(text),
    ...(attachments.length > 0 ? { attachments } : {}),
    // An inline reply is answered inside its thread, and told it was a reply, even when its words are not there.
    ...(replyTo !== null ? { threaded: true as const } : {}),
    ...(replyTo !== null && quoted !== "" ? { quoted } : {}),
    ...(viaCard !== undefined ? { viaCard } : {}),
    ...(sms ? { sms: true as const } : {}),
  };
}

/** A `message.reactionAdded` or `…Removed`, on any message in a chat. */
function reacted(body: Rec, env: Envelope, removed: boolean): PhotonParsed {
  const reaction = isRecord(body.reaction) ? body.reaction : null;
  if (reaction === null || idOf(reaction.targetGuid) === null) return { kind: "invalid" };
  if (env.from === undefined || !E164.test(env.from)) return { kind: "ignored", reason: "sender" };
  const tapback = reactionOf(reaction, removed);
  if (tapback === null) return { kind: "ignored", reason: "reaction" };
  if (env.where?.groupId !== undefined) {
    const group: GroupMessage = {
      kind: "group-message",
      eventId: env.eventId,
      groupId: env.where.groupId,
      line: env.line,
      from: env.from,
      participants: participantsOf(isRecord(body.chat) ? body.chat : {}, env.from),
      messageId: env.eventId,
      text: "",
      reaction: tapback,
    };
    return group;
  }
  if (env.where?.chatId === undefined) return { kind: "invalid" };
  return { kind: "reaction", eventId: env.eventId, chatId: env.where.chatId, from: env.from, messageId: env.eventId, reaction: tapback };
}

/** A `message.edited` (its new words, and its old ones when the bridge held them) or a `message.unsent`. */
function sideEvent(body: Rec, env: Envelope, kind: "edited" | "unsent"): PhotonParsed {
  const target = kind === "edited" ? (isRecord(body.edited) ? body.edited : null) : isRecord(body.unsent) ? body.unsent : null;
  const messageId = target === null ? null : idOf(target.targetGuid);
  if (messageId === null) return { kind: "invalid" };
  if (env.from === undefined || !E164.test(env.from)) return { kind: "ignored", reason: "sender" };
  if (env.where === null) return { kind: "invalid" };
  const words = kind === "edited" && isRecord(body.message) && typeof body.message.text === "string" ? body.message.text.trim() : undefined;
  const text = words === undefined ? undefined : cutText(words).text;
  // An edit with no words left is not one Tex reads: iMessage edits words, and an emptied text is an unsend.
  if (kind === "edited" && (text === undefined || text === "")) return { kind: "ignored", reason: "empty" };
  const previous = kind === "edited" && target !== null && typeof target.previousText === "string" ? target.previousText.trim().slice(0, MAX_INBOUND_TEXT) : "";
  return {
    kind,
    eventId: env.eventId,
    ...env.where,
    line: env.line,
    from: env.from,
    ...(env.where.groupId !== undefined ? { participants: participantsOf(isRecord(body.chat) ? body.chat : {}, env.from) } : {}),
    messageId,
    ...(text !== undefined ? { text } : {}),
    ...(previous !== "" ? { previous } : {}),
    at: env.at,
  };
}

/**
 * A group's name as a Photon event gives it (the bridge's `chat.name`, Apple's `groupTitle`), cleaned as Sendblue's
 * `group_display_name` is: null when the event says nothing about it, or is no group's. Shown only as the chat's
 * folder name in the app, never in a turn (`sendblueGroups.ts` `groupNameOf`).
 */
export function photonGroupNameOf(body: unknown): string | null {
  const chat = isRecord(body) && isRecord(body.chat) ? body.chat : null;
  return chat !== null && chat.kind === "group" ? cleanGroupName(chat.name) : null;
}

/** A group's change as the bridge reads it (`group.changed`): a new name, or somebody added, removed or left. */
export type PhotonGroupChange = { groupId: string; line: string; from?: string; change: "renamed"; name: string } | { groupId: string; line: string; from?: string; change: "members" };

/** The change a `group.changed` event names, or null for any other event, or one this Worker does not read. */
export function photonGroupChange(body: unknown): PhotonGroupChange | null {
  if (!isRecord(body) || body.type !== "group.changed") return null;
  const env = envelopeOf(body);
  if (env === null || env.where?.groupId === undefined) return null;
  const group = isRecord(body.group) ? body.group : null;
  const from = env.from !== undefined && E164.test(env.from) ? { from: env.from } : {};
  if (group?.change === "displayNameChanged") {
    const name = cleanGroupName(group.displayName);
    return name === null ? null : { groupId: env.where.groupId, line: env.line, ...from, change: "renamed", name };
  }
  if (group?.change === "participantAdded" || group?.change === "participantRemoved" || group?.change === "participantLeft") {
    return { groupId: env.where.groupId, line: env.line, ...from, change: "members" };
  }
  return null;
}

/** The guids of the pictures a message names, so their addresses can be signed before the event is read. */
export function photonAttachmentGuids(body: unknown): string[] {
  const message = isRecord(body) && isRecord(body.message) ? body.message : null;
  const listed = message !== null && Array.isArray(message.attachments) ? message.attachments.slice(0, MAX_INBOUND_ATTACHMENTS) : [];
  return listed.flatMap((item) => {
    const guid = isRecord(item) ? idOf(item.guid) : null;
    return guid === null ? [] : [guid];
  });
}

/**
 * One `PhotonEvent` read into what the Worker acts on. `fromMe` is ignored
 * first of all: Tex's own side is never a message, whatever else it says.
 */
export function parsePhotonEvent(body: unknown, options: PhotonParseOptions = {}): PhotonParsed {
  if (!isRecord(body)) return { kind: "invalid" };
  const env = envelopeOf(body);
  if (env === null) return { kind: "invalid" };
  // Each its own reason, so the log tells Tex's own echoes from a group's changes and the chat events nobody reads.
  if (body.fromMe === true) return { kind: "ignored", reason: "from_me" };
  if (NOT_A_MESSAGE.has(env.type)) return { kind: "ignored", reason: NOT_A_MESSAGE_REASON[env.type] ?? "event_type" };
  switch (env.type) {
    case "message.received":
      return received(body, env, options);
    case "message.reactionAdded":
      return reacted(body, env, false);
    case "message.reactionRemoved":
      return reacted(body, env, true);
    case "message.edited":
      return sideEvent(body, env, "edited");
    case "message.unsent":
      return sideEvent(body, env, "unsent");
    default:
      return { kind: "invalid" };
  }
}
