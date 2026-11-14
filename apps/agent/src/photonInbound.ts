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
 * - an SMS is kept only so it gets its fixed answer; its files are not read;
 * - a 1:1 message from one of our iMessage apps is read as the words the card
 *   stands for (`cardReply`), any other app's card is not a message;
 * - a tapback is a reaction, read as its name; a removal is marked `removed`.
 *
 * Pure: no fetch, no storage. The route (`index.ts`) gives the attachment
 * addresses in `options.attachmentUrl`, signed by `photon.ts`; an attachment
 * with no address is left off.
 */

import { cardReply } from "./cardChats";
import { cutText, MAX_INBOUND_ATTACHMENTS, type Inbound, type InboundAttachment } from "./inbound";
import { photonChatId, photonGroupId } from "./photon";
import type { Reaction, Tapback } from "./reactions";
import type { GroupInbound, GroupMessage } from "./sendblueGroups";
import { E164 } from "./sendblue";

/** An edit or an unsend of a message in a chat: phase 1 only records it, so nothing answers it (plan.md, "Not now"). */
export type PhotonSideEvent = {
  kind: "edited" | "unsent";
  eventId: string;
  /** A 1:1 chat's id, or a group's; exactly one is set. */
  chatId?: string;
  groupId?: string;
  from: string;
  /** The guid of the message edited or unsent. */
  messageId: string;
  /** An edit's new words, cut as a text's are. */
  text?: string;
  /** When Apple stamped it, as the bridge sent it. */
  at: string;
};

export type PhotonParsed = Inbound | GroupInbound | PhotonSideEvent | { kind: "invalid" };

export type PhotonParseOptions = {
  /** The address an attachment is served at, by its guid; undefined leaves that attachment off. */
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

/** Photon's reaction kinds, read onto the tapback names `sendblueTapbacks.ts` uses. `emoji` and `sticker` are separate. */
const TAPBACKS: Record<string, Tapback> = {
  love: "Loved",
  like: "Liked",
  dislike: "Disliked",
  laugh: "Laughed at",
  emphasize: "Emphasized",
  question: "Questioned",
};

/** A group's Photon guid: `any;+;<id>`. Anything else is not a group this Worker can answer in. */
const GROUP_GUID = /^any;\+;[^\s;]{1,190}$/;
const MAX_ID = 200;
const MAX_NAME = 200;
const MAX_PARTICIPANTS = 64;
const MAX_EMOJI = 16;

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

/** The fields every event carries, or null when one is missing or malformed. `where` is null only for a group whose guid is not one. */
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

/** A reaction's tapback, or null when it names nothing this Worker reads (a sticker, a kind it does not know). */
function reactionOf(kind: unknown, emoji: unknown, removed: boolean): Reaction | null {
  if (typeof kind !== "string") return null;
  const removal = removed ? { removed: true as const } : {};
  const how = TAPBACKS[kind];
  if (how !== undefined) return { how, words: "", ...removal };
  if (kind === "emoji" && typeof emoji === "string" && emoji !== "") return { how: "Reacted", words: "", emoji: [...emoji].slice(0, MAX_EMOJI).join(""), ...removal };
  return null;
}

/** The attachments a message carries that have an address, as `InboundAttachment`s; none for an SMS, whose files are not read. */
function attachmentsOf(message: Rec, options: PhotonParseOptions): InboundAttachment[] {
  const listed = Array.isArray(message.attachments) ? message.attachments : [];
  return listed
    .flatMap((item): InboundAttachment[] => {
      if (!isRecord(item)) return [];
      const guid = idOf(item.guid);
      const url = guid === null ? undefined : options.attachmentUrl?.(guid);
      if (guid === null || url === undefined) return [];
      return [
        {
          url,
          mimeType: typeof item.mimeType === "string" ? item.mimeType.toLowerCase().slice(0, 100) : "",
          filename: typeof item.name === "string" ? item.name.slice(0, MAX_NAME) : "",
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
  const service = message.service;
  if (service !== "iMessage" && service !== "SMS") return { kind: "ignored", reason: "service" };
  const sms = service === "SMS";
  const isGroup = env.where?.groupId !== undefined;
  // A 1:1 message from one of our iMessage apps is what its card says, and another app's card is not a message (`cardChats.ts`).
  let text = typeof message.text === "string" ? message.text.trim() : "";
  let viaCard: { ask?: string } | undefined;
  if (!isGroup && typeof message.balloonBundleId === "string") {
    const card = typeof message.appUrl === "string" ? cardReply({ extensionBundleId: message.balloonBundleId, url: message.appUrl }) : null;
    if (card === null) return { kind: "ignored", reason: "app_card" };
    text = card.text;
    viaCard = card.ask !== undefined ? { ask: card.ask } : {};
  }
  const attachments = sms ? [] : attachmentsOf(message, options);
  if (text === "" && attachments.length === 0) return { kind: "ignored", reason: "empty" };
  const replyTo = idOf(message.replyTo);
  const from = env.from;
  if (env.where?.groupId !== undefined) {
    const group: GroupMessage = {
      kind: "group-message",
      eventId: `photon:${guid}`,
      groupId: env.where.groupId,
      line: env.line,
      from,
      participants: participantsOf(isRecord(body.chat) ? body.chat : {}, from),
      messageId: guid,
      ...cutText(text),
      ...(replyTo !== null ? { replyTo } : {}),
      ...(sms ? { sms: true as const } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    return group;
  }
  if (env.where?.chatId === undefined) return { kind: "invalid" };
  return {
    kind: "message",
    eventId: `photon:${guid}`,
    chatId: env.where.chatId,
    from,
    messageId: guid,
    ...cutText(text),
    ...(attachments.length > 0 ? { attachments } : {}),
    // An inline reply is answered inside its thread. Its words are not read here: Photon's gRPC event gives only the guid.
    ...(replyTo !== null ? { threaded: true as const } : {}),
    ...(viaCard !== undefined ? { viaCard } : {}),
    ...(sms ? { sms: true as const } : {}),
  };
}

/** A `message.reactionAdded` or `…Removed`, on any message in a chat. */
function reacted(body: Rec, env: Envelope, removed: boolean): PhotonParsed {
  const reaction = isRecord(body.reaction) ? body.reaction : null;
  const target = reaction === null ? null : idOf(reaction.targetGuid);
  if (reaction === null || target === null) return { kind: "invalid" };
  if (env.from === undefined || !E164.test(env.from)) return { kind: "ignored", reason: "sender" };
  const tapback = reactionOf(reaction.kind, reaction.emoji, removed);
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
  // `on` names the message it was on; its words are for the route to read, if it can (the bridge has no read yet).
  return { kind: "reaction", eventId: env.eventId, chatId: env.where.chatId, from: env.from, messageId: env.eventId, reaction: tapback, on: target };
}

/** A `message.edited` or `message.unsent`: recorded, never answered. */
function sideEvent(body: Rec, env: Envelope, kind: "edited" | "unsent"): PhotonParsed {
  const target = kind === "edited" ? (isRecord(body.edited) ? body.edited : null) : isRecord(body.unsent) ? body.unsent : null;
  const messageId = target === null ? null : idOf(target.targetGuid);
  if (messageId === null) return { kind: "invalid" };
  if (env.from === undefined || !E164.test(env.from)) return { kind: "ignored", reason: "sender" };
  if (env.where === null) return { kind: "invalid" };
  const words = kind === "edited" && isRecord(body.message) && typeof body.message.text === "string" ? body.message.text.trim() : undefined;
  const text = words === undefined ? undefined : cutText(words).text;
  return {
    kind,
    eventId: env.eventId,
    ...env.where,
    from: env.from,
    messageId,
    ...(text !== undefined ? { text } : {}),
    at: env.at,
  };
}

/** The guids of the attachments a message names, so the route can sign their addresses before the parse. */
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
  if (body.fromMe === true) return { kind: "ignored", reason: "event_type" };
  if (NOT_A_MESSAGE.has(env.type)) return { kind: "ignored", reason: "event_type" };
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
