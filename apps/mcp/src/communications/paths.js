// Path recognisers for notes an automated pipeline writes on its own
// schedule — a connected mailbox's day, a meeting, a saved coding session —
// as opposed to a note a person sat down and wrote or edited themselves.
//
// `orient`'s recency list is the one consumer today: it uses `classifyCaptureKind`
// to collapse every one of these into at most one summary line per kind,
// rather than letting automation's own paperwork answer "where has the
// user's attention been" (docs/decisions/communications.md,
// "A firehose is not attention"). Written once here, relative-imported by
// `src/index.js`, rather than duplicated at the one call site — the same
// reason `packages/meetings/src/paths.js` exists as its own module.
//
// `packages/communications` is the decided home for the channel-day shape
// once that package exists (docs/decisions/communications.md, "The prototype
// of this layout is `packages/communications`"); it does not exist yet, so
// this lives in the gateway and should move wholesale into that package's
// `paths.js` the day it lands, the way `isMeetingNotePath` already did for
// meetings.
//
// EVERY RECOGNISER HERE IS A PATH PREDICATE AND NOTHING ELSE, and that is a
// limit worth stating rather than discovering. There is no writer-identity
// signal anywhere in this stack that could do better: object storage records
// an etag and a modified time, not who wrote it, and the audit trail only
// ever hears about a write that went through a gateway tool — an ingestion
// worker's `store.put` and a person's own edit made in Obsidian or through
// `write_note` both reach the bucket the same way and look identical to
// everything below `canSee`. So a channel-day note a person has since
// rewritten by hand is, structurally, still a channel-day note, and stays
// collapsed rather than being promoted back to an individual entry. That is
// argued in full, and tested, in `test/orientation.test.mjs` under "a
// person's edit to a channel-day note stays collapsed".

import { isMeetingNotePath } from "../../../../packages/meetings/src/paths.js";

/**
 * `0-inbox/email/<mailbox-slug>/YYYY-MM-DD[-part-N].md` — a connected
 * mailbox's day (docs/decisions/communications.md, "A channel lands in
 * `0-inbox`", "An oversized day splits by rendered bytes").
 *
 * Deliberately NOT `0-inbox/email/<fingerprint>.md`: that flat shape is the
 * forwarded-capture folder this layout leaves untouched, one message per
 * file, named by a 24-hex fingerprint with no folder underneath it. A
 * connected mailbox is always a *folder*, so the two shapes cannot collide —
 * this pattern requires a folder segment and the capture shape has none.
 */
const EMAIL_CHANNEL_DAY = /^0-inbox\/email\/[^/]+\/\d{4}-\d{2}-\d{2}(?:-part-\d+)?\.md$/;

/**
 * `0-inbox/google-chat/…` and `0-inbox/imessage/…` — no per-account folder in
 * the decided layout, because today's scope is one account per channel.
 */
const FLAT_CHANNEL_DAY = /^0-inbox\/(?:google-chat|imessage)\/\d{4}-\d{2}-\d{2}(?:-part-\d+)?\.md$/;

/** Is this key a channel-day note: a connected mailbox, Google Chat, or iMessage day? */
export function isChannelDayNotePath(path) {
  return typeof path === "string" && (EMAIL_CHANNEL_DAY.test(path) || FLAT_CHANNEL_DAY.test(path));
}

/**
 * `0-inbox/sessions/<platform>/<timestamp>[-<8hex>].md` — see
 * `uniqueSessionPath` and `defaultSessionFolder` in `src/index.js`.
 *
 * Only the unrouted `0-inbox/sessions/` default. Never `4-archive/chat-history`
 * and never a destination a person named in their own `## Save context`
 * procedure in `index.md`: both of those are somewhere the *person* chose to
 * route their sessions, and `defaultSessionFolder`'s whole argument is that a
 * customer who wants sessions filed under `4-archive` already declared that
 * folder — a note landing exactly where they asked is as much "attention" as
 * any other note they filed on purpose. It is only the note arriving in the
 * inbox with nobody having chosen anywhere else that is automated paperwork
 * rather than a decision.
 */
const SESSION_FILE = /^0-inbox\/sessions\/[a-z0-9][a-z0-9-]{0,31}\/[^/]+\.md$/;

/** Is this key a saved session note filed at the default, unrouted location? */
export function isSavedSessionNotePath(path) {
  return typeof path === "string" && SESSION_FILE.test(path);
}

/**
 * Which automated-capture kind, if any, wrote this note — the three kinds
 * `orient`'s recency list collapses. `null` means "authored": written by a
 * person, or by an agent through an ordinary tool call on their behalf, and
 * never collapsed.
 *
 * The three shapes cannot overlap — a meeting is always under
 * `0-inbox/meetings/`, a channel day never is, a session's platform segment
 * is never a date — so the order checked here is for readability only, not
 * correctness.
 *
 * @param {string} path
 * @returns {"meeting" | "channel-day" | "session" | null}
 */
export function classifyCaptureKind(path) {
  if (isMeetingNotePath(path)) return "meeting";
  if (isChannelDayNotePath(path)) return "channel-day";
  if (isSavedSessionNotePath(path)) return "session";
  return null;
}
