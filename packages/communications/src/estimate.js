// The backfill estimator: "how much would this cost" before a single message
// is fetched.
//
// docs/decisions/communications.md, "Default Gmail backfill window and
// included folders": *"the estimator showing the note count and byte range
// for 90 days / 1 year / all mail before anything is fetched"* — a person
// deciding whether to connect a mailbox, and how far back, sees a number
// before they commit to it, not after.
//
// ## What this does NOT need, and why it can still be honest
//
// The only thing a connect flow can cheaply learn before fetching a single
// message is a **count** — Gmail's `messages.list` returns `resultSizeEstimate`
// for a query scoped to a date range, and it costs one call per window. It
// does not return which *days* those messages landed on, and asking for that
// would mean fetching every message header, which is the fetch this screen
// exists to happen before. So the estimator works from three numbers it can
// always have — a message count, the window length in days, and the
// documented per-message size range — and is explicit about the one thing it
// cannot see.
//
// **`estimatedNotes` is a upper bound, not a guess dressed up as one.** A
// channel-day note requires at least one message, so the true count of active
// days can never exceed the message count, and it can never exceed the number
// of calendar days in the window either — `min(messageCount, windowDays)` is
// the tightest bound available without the per-day distribution, and it is
// reported as what it is. A mailbox with one message a day for 90 days and a
// mailbox with 90 messages on one day both produce the same `messageCount`
// and the same bound, and the bound is honest about both: "at most 90 notes."
//
// **The byte range comes from the range this product has already measured**,
// not from this file inventing one: `docs/decisions/communications.md` puts a
// normalized email at 15-40KB rendered. Multiplying by the message count gives
// a range, not a point estimate, because the true answer depends on how heavy
// this particular mailbox's messages are and this function has no way to know
// that before fetching them.

/** Lower bound of rendered bytes per normalized email — see the module doc. */
export const AVERAGE_MESSAGE_BYTES_LOW = 15 * 1024;

/** Upper bound of rendered bytes per normalized email. */
export const AVERAGE_MESSAGE_BYTES_HIGH = 40 * 1024;

/**
 * The estimate for one backfill window.
 *
 * @param {{messageCount: number, windowDays: number}} input
 *   `messageCount` — from `messages.list`'s `resultSizeEstimate` for this
 *   window, scoped to the connection's included folders. `windowDays` — the
 *   number of calendar days the window spans; `Infinity` is accepted for
 *   "all mail" and produces a note-count bound of the message count alone.
 * @returns {{messageCount: number, estimatedNotes: number,
 *            estimatedBytesLow: number, estimatedBytesHigh: number}}
 */
export function estimateMailboxBackfill(input) {
  const messageCount = input?.messageCount;
  const windowDays = input?.windowDays;
  // Never coerced: a caller's string, null or undefined must fail loudly
  // rather than becoming `Number("12") === 12` or `Number(null) === 0`, both
  // of which look like valid input.
  if (typeof messageCount !== "number" || !Number.isFinite(messageCount) || messageCount < 0) {
    throw new TypeError("estimateMailboxBackfill needs a non-negative messageCount");
  }
  if (typeof windowDays !== "number" || Number.isNaN(windowDays) || !(windowDays > 0)) {
    // windowDays === Infinity passes `> 0` and is the "all mail" case; zero,
    // negative and NaN are all refused rather than silently becoming a
    // divide-by-something-wrong later.
    throw new TypeError("estimateMailboxBackfill needs a positive windowDays");
  }

  const count = Math.trunc(messageCount);
  const bound = Number.isFinite(windowDays) ? Math.trunc(windowDays) : count;
  return {
    messageCount: count,
    estimatedNotes: count === 0 ? 0 : Math.min(count, bound),
    estimatedBytesLow: count * AVERAGE_MESSAGE_BYTES_LOW,
    estimatedBytesHigh: count * AVERAGE_MESSAGE_BYTES_HIGH,
  };
}

/**
 * The three windows the connect screen shows, in one call.
 *
 * @param {{
 *   days90: {messageCount: number},
 *   days365: {messageCount: number},
 *   allMail: {messageCount: number},
 * }} counts One `messages.list` result per window, already scoped to the
 *   connection's included folders (Inbox and Sent; Spam and Trash are never
 *   queried — see `docs/decisions/communications.md`).
 * @returns {{
 *   days90: ReturnType<typeof estimateMailboxBackfill>,
 *   days365: ReturnType<typeof estimateMailboxBackfill>,
 *   allMail: ReturnType<typeof estimateMailboxBackfill>,
 * }}
 */
export function estimateBackfillWindows(counts) {
  return {
    days90: estimateMailboxBackfill({ messageCount: counts?.days90?.messageCount, windowDays: 90 }),
    days365: estimateMailboxBackfill({ messageCount: counts?.days365?.messageCount, windowDays: 365 }),
    // "All mail" has no fixed window: the note-count bound falls back to the
    // message count itself, which is still a real bound (one note needs one
    // message) even though it is a much looser one than the dated windows get.
    allMail: estimateMailboxBackfill({ messageCount: counts?.allMail?.messageCount, windowDays: Infinity }),
  };
}
