// Path recognisers for notes an automated pipeline writes on its own
// schedule — a connected mailbox's day, a meeting, a saved coding session —
// as opposed to a note a person sat down and wrote or edited themselves.
//
// `orient`'s recency list is the one consumer today: it uses `classifyCaptureKind`
// to collapse every one of these into at most one summary line per kind,
// rather than letting automation's own paperwork answer "where has the
// user's attention been" (docs/decisions/communications.md,
// "A firehose is not attention").
//
// ## The channel-day shape lives in `packages/communications`, and this file
// ## does what its first version said it would
//
// The first version of this file carried its own regexes and said so out loud:
// *"`packages/communications` is the decided home for the channel-day shape
// once that package exists … it does not exist yet, so this lives in the
// gateway and should move wholesale into that package's `paths.js` the day it
// lands, the way `isMeetingNotePath` already did for meetings."* The package
// has landed, so this is that move.
//
// It is not tidiness. The two recognisers **disagreed on nine of fourteen
// keys**, always in the same direction — the regex was the looser of the two,
// and every disagreement was a note this file called automated mail that the
// package refuses to call a channel day at all:
//
//   - `0-inbox/email/Work_Box/2026-09-08.md` — a folder somebody made by hand
//     in Obsidian inside the mail folder. `[^/]+` matched it; `isMailboxSlug`
//     does not, because nothing this product writes could be named that.
//   - `0-inbox/email/.hidden/2026-09-07.md` and `0-inbox/email/../2026-09-07.md`
//     — a dot segment and a traversal, matched by `[^/]+` and refused by the
//     `[a-z0-9-]` shape the slug function *produces*.
//   - `0-inbox/email/x/2026-02-30.md` — a day that does not exist. The regex
//     checks the pattern; `isCalendarDate` round-trips it.
//   - `0-inbox/imessage/2026-09-07-part-1.md` and `…-part-02.md` — part
//     numbers this product never writes, since part 1 is the plain name.
//
// The consequence was live and pointed the wrong way: `list_channel_days`
// (built on the package) correctly refuses to list `Work_Box` as a mailbox
// day, while `orient` (built on the regex) collapsed it out of "Recently
// updated" as automated capture. A note a person filed by hand disappeared
// from the front page whose entire job is to say what they have been doing,
// and the two answers came from two recognisers of one shape.
//
// So there is now one, and `test/communications.test.mjs` asserts they are
// the same function rather than two that currently agree.
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
import { isChannelDayNotePath } from "../../../../packages/communications/src/paths.js";

/**
 * `0-inbox/email/<mailbox-slug>/YYYY-MM-DD[-part-N].md`, and the flat
 * `0-inbox/<google-chat|imessage>/YYYY-MM-DD[-part-N].md` — re-exported from
 * the package that owns the shape, so the gateway and the renderer cannot
 * drift.
 *
 * Deliberately NOT `0-inbox/email/<fingerprint>.md`: that flat shape is the
 * forwarded-capture folder this layout leaves untouched, one message per
 * file, named by a 24-hex fingerprint with no folder underneath it. A
 * connected mailbox is always a *folder*, so the two shapes cannot collide.
 */
export { isChannelDayNotePath };

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
 *
 * This one stays here: a saved session is the gateway's own shape, written by
 * `uniqueSessionPath` a few thousand lines away, and it has no package.
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
