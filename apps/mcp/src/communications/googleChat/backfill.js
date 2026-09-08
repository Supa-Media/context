// The estimate shown before a first Chat backfill runs — the same pattern
// `docs/decisions/communications.md` names for Gmail: a note count and a
// byte range for a bounded window, shown before anything is fetched, because
// the first backfill is the first thing a person waits for and the first
// storage bill they see.
//
// Nothing here calls the Chat API. `sync.js` knows how many messages a space
// actually holds only after paging through it; this is deliberately a
// cheaper, coarser number computed from what a space *listing* alone can
// say (how many spaces this account is in), shown before the person commits
// to a window at all.

/**
 * A rough, stated-rather-than-hidden assumption: how many messages a typical
 * active space produces on a day it is used at all. Real workspaces vary by
 * an order of magnitude either side of this; the number exists so the
 * estimate is a number rather than a shrug, and it is a constant in one
 * place to revise with real measurements, the same way `SPLIT_BYTE_THRESHOLD`
 * is.
 */
export const ASSUMED_MESSAGES_PER_ACTIVE_SPACE_PER_DAY = 6;

/** A short Chat message's rendered size, low and high — the range the byte estimate spans. */
export const ASSUMED_RENDERED_BYTES_PER_MESSAGE = Object.freeze({ low: 80, high: 400 });

/** The windows offered before a first sync. All-time is deliberately absent — see the decision. */
export const BACKFILL_WINDOW_DAYS = Object.freeze([90, 365]);

/**
 * The estimate for one window.
 *
 * `spaceCount` is every space this account belongs to that is not excluded
 * or paused — a caller filters that before calling this, the same "count
 * only what canSee would show" rule `docs/decisions/communications.md`'s
 * search section argues for a different existence-oracle, applied here to a
 * count the *owner themselves* is about to see before they consent to a
 * fetch, so it should already reflect their own choices.
 *
 * @param {{spaceCount: number, days: number}} args
 */
export function estimateChatBackfill({ spaceCount, days }) {
  const count = Number.isFinite(spaceCount) && spaceCount > 0 ? Math.trunc(spaceCount) : 0;
  const window = Number.isFinite(days) && days > 0 ? Math.trunc(days) : 0;
  const estimatedMessages = count * ASSUMED_MESSAGES_PER_ACTIVE_SPACE_PER_DAY * window;
  return {
    days: window,
    spaceCount: count,
    estimatedMessages,
    // One note per active day, never one per space per day — a bundled day
    // is the whole point (`docs/decisions/communications.md`, "A channel-day
    // note is one file"). Capped at the window: this assumes every day sees
    // at least one message somewhere once there is at least one space, which
    // over-counts a quiet account and is the direction an estimate shown
    // before consent should err in.
    estimatedNotes: count > 0 ? window : 0,
    estimatedBytesLow: estimatedMessages * ASSUMED_RENDERED_BYTES_PER_MESSAGE.low,
    estimatedBytesHigh: estimatedMessages * ASSUMED_RENDERED_BYTES_PER_MESSAGE.high,
  };
}

/**
 * The estimate for every offered window, keyed by its length in days as a
 * string — what a connect screen renders directly, so nobody hand-assembles
 * the object `{90: …, 365: …}` in two places with two chances to disagree on
 * which windows are offered.
 *
 * @param {{spaceCount: number}} args
 */
export function estimateChatBackfillWindows({ spaceCount }) {
  const result = {};
  for (const days of BACKFILL_WINDOW_DAYS) result[String(days)] = estimateChatBackfill({ spaceCount, days });
  return result;
}
