// Google Chat's REST resource shapes -> the provider-agnostic
// `CommunicationEvent` `packages/communications` renders. Pure functions,
// no I/O, no fetch — the fixture server in the test suite is what exercises
// the shapes documented at
// https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages
// and https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.

const PREVIEW_LENGTH = 80;

/**
 * `spaceType` normalized to the lowercase, provider-agnostic value
 * `packages/communications`' `renderChannelDayNote` reads off `event.space.type`.
 * Chat's REST field is `spaceType: "SPACE" | "GROUP_CHAT" | "DIRECT_MESSAGE"`
 * (the older `type: "ROOM" | "DM"` is deprecated and not read here). Anything
 * unrecognized is treated as a named space rather than a DM — the safer
 * direction to guess wrong in, since a DM mislabelled as a space only loses a
 * label, while a space mislabelled as a DM could read as "just the two of
 * you" when it was not.
 *
 * @param {object} space
 * @returns {"space"|"group_chat"|"direct_message"}
 */
export function chatSpaceType(space) {
  const value = String(space?.spaceType ?? "").toUpperCase();
  if (value === "DIRECT_MESSAGE") return "direct_message";
  if (value === "GROUP_CHAT") return "group_chat";
  return "space";
}

/**
 * Is this space's history switched on? Chat's `spaceHistoryState` field is
 * `"HISTORY_ON" | "HISTORY_OFF"`.
 *
 * A response that omits the field entirely (some space kinds do) defaults to
 * **on** — the opposite direction from the privacy engine's own
 * default-private rule, and deliberately so: those are different questions.
 * `visibilityOf` defaults private because an unnamed folder must not become
 * team-readable by omission; this defaults on because refusing to record
 * history off a signal we do not have would manufacture an "unavailable"
 * marker Google never asked for, which is its own kind of dishonesty about
 * what this connection knows.
 *
 * @param {object} space
 * @returns {boolean}
 */
export function isHistoryOn(space) {
  const state = String(space?.spaceHistoryState ?? "").toUpperCase();
  if (!state) return true;
  return state === "HISTORY_ON";
}

/** The space's display name, or "" — Chat never sets one for a DM. */
export function spaceDisplayName(space) {
  return typeof space?.displayName === "string" ? space.displayName : "";
}

/** The fixed label a space with no `displayName` gets, by its type. */
export function fallbackSpaceLabel(space) {
  return chatSpaceType(space) === "direct_message" ? "Direct message" : "Space";
}

/**
 * A short, single-line preview of a message's own text — used as the
 * synthesized `subject` for the *first* message of a thread (chronologically)
 * so a Chat thread heading reads as "what this conversation opened with"
 * rather than the literal string "(no subject)" on every single thread, the
 * way it would if Chat messages carried no subject field at all (they do
 * not). `packages/communications`' `groupIntoThreads` already keys a thread's
 * heading off whichever event it processes first in chronological order, so
 * setting this on every message and letting that module pick is simpler and
 * no less correct than computing "the first message of each thread" here
 * ourselves — two implementations of "which one is first" is how they drift.
 *
 * Deliberately not sanitized here: `renderChannelDayNote` applies `singleLine`
 * and `defangOutsideFence` to every subject it is handed, sender-chosen or
 * not, so double-sanitizing here would be the second copy of a rule this
 * package already owns.
 */
function preview(text) {
  const value = String(text ?? "");
  return value.length > PREVIEW_LENGTH ? `${value.slice(0, PREVIEW_LENGTH)}…` : value;
}

/**
 * One Chat message resource plus the space it arrived in ->
 * one `CommunicationEvent`. Pure: the same message and space produce the same
 * event, which is what makes a resync of the same day byte-identical.
 *
 * `deletionMetadata` present means Chat has deleted the message but a link
 * into it must still resolve — the anchor is unchanged because it is hashed
 * from `message.name`, never from content — so the body becomes a fixed,
 * non-sender-controlled placeholder rather than the message vanishing from
 * the day entirely, which would look like a resync had lost data rather than
 * like a deletion the sender made.
 *
 * @param {{space: object, message: object, account: string}} args
 * @returns {import("../../../../../packages/communications/src/protocol.js").CommunicationEvent}
 */
export function chatMessageToEvent({ space, message, account }) {
  const deleted = Boolean(message?.deletionMetadata);
  const text = deleted ? "" : String(message?.formattedText ?? message?.text ?? "");
  const attachments = Array.isArray(message?.attachment) ? message.attachment : [];
  return {
    channel: "google-chat",
    account: String(account ?? ""),
    messageId: String(message?.name ?? ""),
    threadId: String(message?.thread?.name ?? message?.name ?? ""),
    sentAt: String(message?.createTime ?? ""),
    subject: deleted ? "" : preview(text),
    from: {
      name: String(message?.sender?.displayName ?? ""),
      address: "",
      providerUserId: String(message?.sender?.name ?? ""),
    },
    to: [],
    body: deleted ? "_(This message was deleted.)_" : text,
    attachments: attachments.map((attachment) => ({
      filename: String(attachment?.contentName ?? attachment?.name ?? ""),
      contentType: String(attachment?.contentType ?? ""),
      size: Number.isFinite(attachment?.size) ? attachment.size : undefined,
    })),
    space: {
      key: String(space?.name ?? ""),
      displayName: spaceDisplayName(space),
      type: chatSpaceType(space),
    },
  };
}
