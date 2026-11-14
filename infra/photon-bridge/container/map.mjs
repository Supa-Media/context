/**
 * Raw Photon events (the public shapes of @photon-ai/advanced-imessage's gRPC
 * transport, `subscribeEvents` and `events.catchUp`) -> the PhotonEvent that
 * the agent Worker reads (plan.md, Contract A).
 *
 * Pure: no SDK import, no I/O. A null result means "nothing for the agent"; the
 * caller still counts the sequence as handled, so the checkpoint can pass it.
 *
 * Fields the plan does not name are added where the raw event carries data the
 * agent needs, and each is marked EXTENSION below.
 */

const REACTION_KINDS = new Set([
  "love", "like", "dislike", "laugh", "emphasize", "question", "emoji", "sticker", "unknown",
]);
const SERVICES = new Set(["iMessage", "SMS", "RCS"]);

function isObject(value) {
  return value !== null && typeof value === "object";
}

/** Drops undefined members so the JSON body carries only what is known. */
function compact(object) {
  for (const key of Object.keys(object)) {
    if (object[key] === undefined) delete object[key];
  }
  return object;
}

/** Apple's own stamp when it is a valid date; the observation time otherwise. */
function isoOr(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return new Date().toISOString();
}

export function chatKind(guid) {
  return typeof guid === "string" && guid.includes(";+;") ? "group" : "dm";
}

function chatOf(guid, name) {
  if (typeof guid !== "string" || guid.length === 0) return null;
  return compact({ guid, kind: chatKind(guid), name: name || undefined });
}

function service(value) {
  return SERVICES.has(value) ? value : "unknown";
}

function attachment(raw) {
  return compact({
    guid: raw.guid,
    name: raw.fileName,
    mimeType: raw.mimeType,
    size: Number.isFinite(raw.totalBytes) ? raw.totalBytes : null,
  });
}

/** The address that acted, for events another person caused. */
function actorOf(event) {
  return event.isFromMe ? undefined : event.actor?.address || undefined;
}

function envelope(event, line, type, eventId, chat, at) {
  return compact({
    seq: event.sequence,
    eventId,
    type,
    line,
    chat,
    fromMe: event.isFromMe === true,
    at,
  });
}

function received(event, line, extras) {
  const message = event.message;
  if (!isObject(message) || typeof message.guid !== "string") return null;
  const chat = chatOf(event.chatGuid ?? message.chatGuids?.[0], message.groupTitle);
  if (!chat) return null;
  const base = envelope(
    event,
    line,
    "message.received",
    `photon:message.received:${message.guid}`,
    chat,
    isoOr(message.dateCreated),
  );
  return {
    ...base,
    from: message.isFromMe ? undefined : message.sender?.address || undefined,
    fromMe: message.isFromMe === true,
    message: compact({
      guid: message.guid,
      text: message.content?.text ?? "",
      service: service(message.sender?.service),
      replyTo: message.replyTargetGuid || undefined,
      threadRoot: message.threadOriginatorGuid || undefined,
      attachments: (message.content?.attachments ?? []).map(attachment),
      balloonBundleId: message.content?.balloonBundleId || undefined,
      appUrl: message.content?.miniApp?.url || undefined,
      replyToText: extras.replyToText,
      replyToFromMe: extras.replyToFromMe,
    }),
  };
}

function edited(event, line, extras) {
  const chat = chatOf(event.chatGuid);
  if (!chat || typeof event.messageGuid !== "string") return null;
  return compact({
    ...envelope(event, line, "message.edited", `photon:message.edited:${event.messageGuid}:${event.sequence}`, chat, isoOr(event.editedAt)),
    from: actorOf(event),
    message: { guid: event.messageGuid, text: event.content?.text ?? "" },
    edited: compact({ targetGuid: event.messageGuid, previousText: extras.previousText }),
  });
}

function unsent(event, line) {
  const chat = chatOf(event.chatGuid);
  if (!chat || typeof event.messageGuid !== "string") return null;
  return compact({
    ...envelope(event, line, "message.unsent", `photon:message.unsent:${event.messageGuid}:${event.sequence}`, chat, isoOr(event.retractedAt)),
    from: actorOf(event),
    unsent: { targetGuid: event.messageGuid },
  });
}

/** EXTENSION: the plan names no read payload; `read.targetGuid` is the message read. */
function read(event, line) {
  const chat = chatOf(event.chatGuid);
  if (!chat || typeof event.messageGuid !== "string") return null;
  return compact({
    ...envelope(event, line, "message.read", `photon:message.read:${event.messageGuid}:${event.sequence}`, chat, isoOr(event.readAt)),
    from: actorOf(event),
    read: { targetGuid: event.messageGuid },
  });
}

function reaction(event, line, extras) {
  const chat = chatOf(event.chatGuid);
  if (!chat || typeof event.messageGuid !== "string" || !isObject(event.reaction)) return null;
  const kind = REACTION_KINDS.has(event.reaction.kind) ? event.reaction.kind : "unknown";
  return compact({
    ...envelope(event, line, event.type, `photon:${event.type}:${event.messageGuid}:${event.sequence}`, chat, isoOr(event.occurredAt)),
    from: actorOf(event),
    reaction: compact({
      kind,
      emoji: event.reaction.emoji || undefined,
      targetGuid: event.messageGuid,
      targetPart: Number.isInteger(event.targetPartIndex) ? event.targetPartIndex : undefined,
      targetText: extras.targetText,
      targetFromMe: extras.targetFromMe,
    }),
  });
}

/** EXTENSION: `group` carries the membership or name change the plan leaves open. */
function groupChanged(event, line) {
  const chat = chatOf(event.chatGuid);
  if (!chat || !isObject(event.change)) return null;
  const change = event.change;
  return compact({
    ...envelope(event, line, "group.changed", `photon:group.changed:${chat.guid}:${event.sequence}`, chat, isoOr(event.occurredAt)),
    from: actorOf(event),
    group: compact({
      change: change.type,
      displayName: change.type === "displayNameChanged" ? change.displayName : undefined,
      address: change.participant?.address,
    }),
  });
}

/** EXTENSION: `chat.other` names which chat event it is in `chatEvent`. */
function chatOther(event, line) {
  const chat = chatOf(event.chatGuid);
  if (!chat) return null;
  return compact({
    ...envelope(event, line, "chat.other", `photon:${event.type}:${chat.guid}:${event.sequence}`, chat, isoOr(event.occurredAt)),
    from: actorOf(event),
    chatEvent: event.type,
  });
}

/**
 * Maps one raw SDK event for `line` (the E.164 number of the Photon line that
 * delivered it). Returns a PhotonEvent or null.
 *
 * Replays of the same event give the same `eventId` and `seq`, which is what
 * lets the agent deduplicate catch-up against live delivery.
 */
export function mapEvent(event, line, extras = {}) {
  if (!isObject(event) || typeof event.type !== "string") return null;
  // catchup.complete carries headSequence, not sequence: it is not an event.
  if (!Number.isSafeInteger(event.sequence)) return null;
  switch (event.type) {
    case "message.received":
      return received(event, line, extras);
    case "message.edited":
      return edited(event, line, extras);
    case "message.unsent":
      return unsent(event, line);
    case "message.read":
      return read(event, line);
    case "message.reactionAdded":
    case "message.reactionRemoved":
      return reaction(event, line, extras);
    case "group.changed":
      return groupChanged(event, line);
    default:
      // Sticker placements and polls are not in Contract A yet.
      return event.type.startsWith("chat.") ? chatOther(event, line) : null;
  }
}

export const MAPPED_TYPES = Object.freeze([
  "message.received",
  "message.edited",
  "message.unsent",
  "message.read",
  "message.reactionAdded",
  "message.reactionRemoved",
  "group.changed",
  "chat.*",
]);
