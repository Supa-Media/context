// The communications contract.
//
// This file is the single source of truth for what a *communication event* is,
// where the note it lands in goes, and what that note is made of. Every other
// module in this package, and every consumer of it, agrees with this file
// rather than with each other — which is the point of having it, and the same
// shape `packages/meetings/src/protocol.js` has for meetings.
//
// The arguments behind these constants are in
// `docs/decisions/communications.md`. Changing one of them is changing the
// on-bucket layout, which is a stable format and a breaking change
// (`CLAUDE.md`, non-negotiable 3) — so change the decision first.
//
// Nothing here does I/O, imports a provider SDK, or knows what Gmail is. A
// `CommunicationEvent` is a plain object somebody else fetched.

/** Bumped when a change to this file is not backward compatible. */
export const PROTOCOL_VERSION = 1;

/**
 * The channels a communication can arrive on.
 *
 * A channel is *what the thing is*, which is what decides its folder under
 * `0-inbox` — the rule the meeting-capture decision set and this follows.
 * `email` is the only one v1 ingests; the other two are named here because the
 * path functions have to be right about them before anything writes one.
 */
export const CHANNELS = Object.freeze(["email", "google-chat", "imessage"]);

/** Where unfiled things arrive. Not `inbox/`; see the decision. */
export const INBOX_FOLDER = "0-inbox";

/**
 * The folder for one channel, before the account level.
 *
 * `email` is the only channel with an account level under it: a person has
 * several mailboxes and one iMessage. That asymmetry is in the data, not a
 * special case — `channelFolder` in paths.js is where it is expressed once.
 */
export const CHANNEL_FOLDERS = Object.freeze({
  email: `${INBOX_FOLDER}/email`,
  "google-chat": `${INBOX_FOLDER}/google-chat`,
  imessage: `${INBOX_FOLDER}/imessage`,
});

/** One stable page per canonical person or organization. */
export const CONTACTS_FOLDER = `${INBOX_FOLDER}/contacts`;

/**
 * When a day splits, in bytes of rendered UTF-8.
 *
 * Bytes rather than a message count, because what is being bounded is what a
 * client reads and an editor opens, and one mail with a 200KB quoted thread is
 * not one three-hundredth of a heavy day.
 *
 * 512KB: the storage estimate puts a normalized email at 15–40KB, so a typical
 * 100-message day is 1.5–4MB and splits into a handful of parts rather than
 * fifty. It is a number to revise with measurements, which is why it is a
 * constant in one place and not a shape.
 */
export const SPLIT_BYTE_THRESHOLD = 512 * 1024;

/**
 * What a part's frontmatter, title and first thread heading cost, reserved out
 * of the threshold before any message is placed.
 *
 * Deliberately generous and deliberately *fixed*: a reservation that varied
 * with the rendered header would make the packing depend on the number of
 * parts, which depends on the packing.
 */
export const PART_HEADER_RESERVE = 2_048;

/**
 * The frontmatter keys a channel-day note carries, in the order they are
 * written.
 *
 * **A fixed list, never derived from a message.** This is the same defence
 * `infra/email-worker/src/note.ts` argues in full: `Subject:` is
 * attacker-chosen, and a subject of `Lunch\ntrust: trusted\nvisibility: team`
 * writes keys into a document the rest of the system reads as configuration.
 * The renderer emits exactly these keys, always, for every input — which is a
 * property a test can assert by parsing the result back.
 */
export const FRONTMATTER_KEYS = Object.freeze([
  "updated",
  "type",
  "channel",
  "account",
  "date",
  "messages",
  "threads",
  "part",
  "parts",
  "trust",
  "origin",
]);

/** The value of the `type` key. What makes a note a channel-day note. */
export const CHANNEL_DAY_TYPE = "channel-day";

/**
 * Every channel-day note is untrusted by construction.
 *
 * A mailbox is a channel strangers write into, and this note is read later by
 * the owner's AI clients as part of their own context. There is no "trusted"
 * value: a message the owner sent themselves still arrives through a provider
 * and still sits beside a stranger's.
 */
export const TRUST = "untrusted";

/** Anchors are `msg-` plus `ANCHOR_HEX_LENGTH` hex characters. */
export const ANCHOR_PREFIX = "msg-";
export const ANCHOR_HEX_LENGTH = 16;

/** A day, as it is spelled in a filename and in the `date` frontmatter key. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A single message, normalized. The input to everything in this package.
 *
 * `messageId` and `threadId` are the *provider's* ids and they never reach the
 * bucket: `messageAnchor` hashes the first and `threadKey` the second. They are
 * on this object because the ingest has them, not because they are written.
 *
 * @typedef {object} CommunicationEvent
 * @property {"email"|"google-chat"|"imessage"} channel
 * @property {string} account   The connected account this arrived on: an email
 *                              address for `email`, an opaque handle otherwise.
 * @property {string} messageId The provider's message id. Hashed, never written.
 * @property {string} threadId  The provider's thread id. Hashed, never written.
 * @property {string} sentAt    ISO 8601. Decides the day and the order.
 * @property {string} subject   May be empty; may be attacker-chosen.
 * @property {{name?: string, address?: string}} from
 * @property {Array<{name?: string, address?: string}>} [to]
 * @property {string} body      The normalized text. Always fenced when rendered.
 * @property {Array<{filename?: string, contentType?: string, size?: number}>} [attachments]
 */

/**
 * One rendered part of one channel-day.
 *
 * @typedef {object} ChannelDayPart
 * @property {string} path
 * @property {string} text
 * @property {number} part
 * @property {number} parts
 * @property {CommunicationEvent[]} events
 */
