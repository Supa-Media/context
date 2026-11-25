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

/**
 * Apple's own stamp when it is a valid date. When Apple gave none, the
 * observation time, and `guessed` says so: a guessed time is never old enough
 * to be a replay the agent should drop (`ledger.mjs`).
 */
function stampOf(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return { at: value.toISOString() };
  if (typeof value === "string" && value.length > 0) return { at: value };
  return { at: new Date().toISOString(), guessed: true };
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

const MAX_MENTIONS = 20;
const MAX_APP_WORDS = 200;

/**
 * EXTENSION: the native tags in a text (`content.mentions`), each the tagged address and its UTF-16 range in the
 * text, so the agent can tell a tag from the bare name iMessage writes for it.
 */
function mentionsOf(content) {
  const listed = Array.isArray(content?.mentions) ? content.mentions : [];
  const mentions = listed
    .filter((m) => isObject(m) && typeof m.address === "string" && m.address !== "" && Number.isInteger(m.start) && Number.isInteger(m.length) && m.start >= 0 && m.length > 0)
    .slice(0, MAX_MENTIONS)
    .map((m) => ({ address: m.address.slice(0, 200), start: m.start, length: m.length }));
  return mentions.length > 0 ? mentions : undefined;
}

/** EXTENSION: the bubble or screen effect a text was sent with (`content.expressiveSendStyleId`), Apple's id as given. */
function effectOf(content) {
  const id = content?.expressiveSendStyleId;
  return typeof id === "string" && id !== "" ? id.slice(0, 120) : undefined;
}

const words = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, MAX_APP_WORDS) : undefined);

/**
 * EXTENSION: what another app's card shows (`content.miniApp`): its name, its extension's id and the words on the
 * card, never its opaque payload, so a card from Apple Cash or Check In reads as what the person sees.
 */
function appOf(content) {
  const app = content?.miniApp;
  if (!isObject(app)) return undefined;
  const layout = isObject(app.layout) ? app.layout : {};
  const card = compact({
    name: words(app.appName),
    bundle: words(app.extensionBundleId),
    caption: words(layout.caption),
    subcaption: words(layout.subcaption),
    trailingCaption: words(layout.trailingCaption),
    trailingSubcaption: words(layout.trailingSubcaption),
    imageTitle: words(layout.imageTitle),
    imageSubtitle: words(layout.imageSubtitle),
    summary: words(layout.summary),
  });
  return Object.keys(card).length > 0 ? card : undefined;
}

function attachment(raw) {
  return compact({
    guid: raw.guid,
    name: raw.fileName,
    mimeType: raw.mimeType,
    size: Number.isFinite(raw.totalBytes) ? raw.totalBytes : null,
    // A sticker sent as its own message (not stuck on a text): the agent keeps it to stick back (`stickers.ts`).
    sticker: raw.isSticker === true ? true : undefined,
  });
}

/** The address that acted, for events another person caused. */
function actorOf(event) {
  return event.isFromMe ? undefined : event.actor?.address || undefined;
}

/** The common fields. `when` is Apple's stamp (or undefined): `at` is that time, `atGuessed` true when it was missing. */
function envelope(event, line, type, eventId, chat, when) {
  const { at, guessed } = stampOf(when);
  return compact({
    seq: event.sequence,
    eventId,
    type,
    line,
    chat,
    fromMe: event.isFromMe === true,
    at,
    atGuessed: guessed ? true : undefined,
  });
}

function received(event, line, extras) {
  const message = event.message;
  if (!isObject(message) || typeof message.guid !== "string") return null;
  const chat = chatOf(event.chatGuid ?? message.chatGuids?.[0], message.groupTitle || extras.chatName);
  if (!chat) return null;
  const base = envelope(
    event,
    line,
    "message.received",
    `photon:message.received:${message.guid}`,
    chat,
    message.dateCreated,
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
      app: appOf(message.content),
      mentions: mentionsOf(message.content),
      effect: effectOf(message.content),
      replyToText: extras.replyToText,
      replyToFromMe: extras.replyToFromMe,
    }),
  };
}

function edited(event, line, extras) {
  const chat = chatOf(event.chatGuid);
  if (!chat || typeof event.messageGuid !== "string") return null;
  return compact({
    ...envelope(event, line, "message.edited", `photon:message.edited:${event.messageGuid}:${event.sequence}`, chat, event.editedAt),
    from: actorOf(event),
    message: compact({ guid: event.messageGuid, text: event.content?.text ?? "", mentions: mentionsOf(event.content) }),
    edited: compact({ targetGuid: event.messageGuid, previousText: extras.previousText }),
  });
}

function unsent(event, line) {
  const chat = chatOf(event.chatGuid);
  if (!chat || typeof event.messageGuid !== "string") return null;
  return compact({
    ...envelope(event, line, "message.unsent", `photon:message.unsent:${event.messageGuid}:${event.sequence}`, chat, event.retractedAt),
    from: actorOf(event),
    unsent: { targetGuid: event.messageGuid },
  });
}

/** EXTENSION: the plan names no read payload; `read.targetGuid` is the message read. */
function read(event, line) {
  const chat = chatOf(event.chatGuid);
  if (!chat || typeof event.messageGuid !== "string") return null;
  return compact({
    ...envelope(event, line, "message.read", `photon:message.read:${event.messageGuid}:${event.sequence}`, chat, event.readAt),
    from: actorOf(event),
    read: { targetGuid: event.messageGuid },
  });
}

function reaction(event, line, extras) {
  const chat = chatOf(event.chatGuid);
  if (!chat || typeof event.messageGuid !== "string" || !isObject(event.reaction)) return null;
  const kind = REACTION_KINDS.has(event.reaction.kind) ? event.reaction.kind : "unknown";
  return compact({
    ...envelope(event, line, event.type, `photon:${event.type}:${event.messageGuid}:${event.sequence}`, chat, event.occurredAt),
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

/**
 * EXTENSION: a sticker stuck on a message is a reaction of kind "sticker", on the message it was stuck to, so the
 * agent reads it as it reads a tapback (Sendblue never sent these).
 */
function stickerPlaced(event, line, extras) {
  const chat = chatOf(event.chatGuid);
  if (!chat || typeof event.messageGuid !== "string") return null;
  return compact({
    ...envelope(event, line, "message.reactionAdded", `photon:message.stickerPlaced:${event.messageGuid}:${event.sequence}`, chat, event.occurredAt),
    from: actorOf(event),
    reaction: compact({
      kind: "sticker",
      targetGuid: event.messageGuid,
      targetPart: Number.isInteger(event.targetPartIndex) ? event.targetPartIndex : undefined,
      targetText: extras.targetText,
      targetFromMe: extras.targetFromMe,
      // The sticker's own attachment on the line, so Tex can stick the same one again (`sticker` op).
      sticker: typeof event.sticker?.guid === "string" && event.sticker.guid !== "" ? event.sticker.guid : undefined,
    }),
  });
}

const MAX_POLL_WORDS = 600;

function quoted(text) {
  return `“${String(text ?? "").replace(/\s+/g, " ").trim()}”`;
}

/** What a poll change says, in words, as a person would read it in the chat. Null when it cannot be told. */
export function pollWords(delta, poll) {
  if (!isObject(delta)) return null;
  const title = typeof delta.title === "string" && delta.title !== "" ? delta.title : poll?.title ?? "";
  const named = title !== "" ? ` ${quoted(title)}` : "";
  const options = (list) => (Array.isArray(list) ? list.map((option) => quoted(option?.text)).join(", ") : "");
  let words = null;
  if (delta.type === "created") words = `Started a poll${named}: ${options(delta.options)}`;
  else if (delta.type === "optionAdded") words = `Added an option to the poll${named}; the options now: ${options(delta.options)}`;
  else if (delta.type === "voted") {
    const choice = poll?.options?.find((option) => option.id === delta.optionIdentifier)?.text;
    words = `Voted${choice ? ` ${quoted(choice)}` : ""} in the poll${named}`;
  } else if (delta.type === "unvoted") words = `Took back a vote in the poll${named}`;
  return words === null ? null : words.slice(0, MAX_POLL_WORDS);
}

/**
 * EXTENSION: a poll change (`poll.changed`) is a message of the actor's, in words (`pollWords`), with its own guid,
 * so a poll started, an option added and a vote reach Tex as what the person did. Sendblue never read polls.
 */
function pollChanged(event, line, extras) {
  const chat = chatOf(event.chatGuid);
  if (!chat || typeof event.pollMessageGuid !== "string") return null;
  const text = pollWords(event.delta, extras.poll);
  if (text === null) return null;
  const guid = `${event.pollMessageGuid}:poll:${event.sequence}`;
  return {
    ...envelope(event, line, "message.received", `photon:poll.changed:${event.pollMessageGuid}:${event.sequence}`, chat, event.occurredAt),
    from: actorOf(event),
    message: compact({ guid, text, service: service(event.actor?.service), attachments: [], poll: true }),
  };
}

/** EXTENSION: `group` carries the membership or name change the plan leaves open. */
function groupChanged(event, line) {
  const chat = chatOf(event.chatGuid);
  if (!chat || !isObject(event.change)) return null;
  const change = event.change;
  return compact({
    ...envelope(event, line, "group.changed", `photon:group.changed:${chat.guid}:${event.sequence}`, chat, event.occurredAt),
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
    ...envelope(event, line, "chat.other", `photon:${event.type}:${chat.guid}:${event.sequence}`, chat, event.occurredAt),
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
    case "message.stickerPlaced":
      return stickerPlaced(event, line, extras);
    case "poll.changed":
      return pollChanged(event, line, extras);
    default:
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
  "message.stickerPlaced",
  "poll.changed",
  "chat.*",
]);
