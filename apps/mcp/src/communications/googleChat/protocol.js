// Constants for the Google Chat sync — the numbers a decision was made
// about, kept in one place so a reviewer changes one line rather than
// hunting through the module for a repeated literal.
//
// Nothing here does I/O or holds a credential. This module is a sibling of
// `packages/communications/src/protocol.js`, at the same remove from the
// network: it is the contract the rest of `googleChat/` agrees with.

/**
 * Chat is forward-only. A space with no cursor starts at the current sync
 * moment rather than asking Google for old messages, because message backfills
 * burn shared quota quickly and do not belong in workspace-style sync.
 */
export const DEFAULT_BACKFILL_DAYS = 0;

/**
 * How far behind the last-seen cursor a resync re-reads, in days.
 *
 * `spaces.messages.list` pages by `createTime`, which never moves for an
 * edited or deleted message — only `lastUpdateTime` does, and Chat's list
 * filter cannot page by that field. So a cursor that only ever moves forward
 * would never see an edit or a deletion land in a day it already wrote. This
 * constant is the trade: every sync re-reads (and re-renders, byte for byte
 * if nothing changed) the last two days of already-synced history, which is
 * cheap, bounded, and catches the case that matters — an edit or a deletion
 * that happens soon after the message was sent, which is the common case for
 * both. An edit made a month later is not caught until the affected day is
 * regenerated some other way (a manual resync of that range); this is stated
 * rather than hidden, the same way `docs/decisions/communications.md` states
 * the split's late-arrival cost rather than engineering it away.
 */
export const REGEN_LOOKBACK_DAYS = 2;

/**
 * User-authorization scopes this sync needs, recorded verbatim against
 * Google's own restricted/sensitive-scope lists
 * (`1-projects/context-lc-personal-communications-inbox/google-verification-steps.md`,
 * checked 2026-09-07). `chat.messages.readonly` is **restricted** — the same
 * class as `gmail.readonly` — because this product stores what it reads,
 * server-side, in the customer's own bucket; `chat.spaces.readonly` is
 * **sensitive**. Recorded here so the two products' verification submission
 * has one place to read scope strings from rather than retyping them.
 */
export const CHAT_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
]);

/**
 * Per-space sync state, stored on the connection. `"included"` is the
 * default for a space this connection has never been told about — a newly
 * joined space starts visible, the same way a newly connected mailbox starts
 * private-by-folder-default rather than being asked about before anything
 * syncs (`docs/decisions/communications.md`, "Default private"). `"excluded"`
 * and `"paused"` are both "do not sync," kept as two words rather than one
 * because they answer different questions later: an excluded space's cursor
 * is meaningless and can be discarded, a paused one is meant to resume
 * exactly where it left off.
 */
export const SPACE_STATES = Object.freeze(["included", "excluded", "paused"]);

export const DAY_MS = 24 * 60 * 60 * 1000;
