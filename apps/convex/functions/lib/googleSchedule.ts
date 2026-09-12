/**
 * The scheduling arithmetic behind the Google forward sync loop.
 *
 * A LEAF: this module imports nothing from `functions/`, and that is the whole
 * reason it exists. `functions/googleSync.ts` owns the loop and needs the
 * connect module's helpers; `functions/googleConnect.ts` owns the console's
 * listing and needs the loop's status view. Putting the shared half in either
 * of them makes the two import each other, and a cycle in the Convex module
 * graph does not fail loudly — it fails as an export that is *sometimes*
 * missing, depending on which module the loader happened to enter first. That
 * is not a hypothetical: it showed up as `revokeGoogleGrant` resolving to "no
 * such export" in roughly one full-suite run in six, in a test about deleting
 * an account, which has nothing to do with either file.
 *
 * Everything here is a pure function of a row. See `functions/googleSync.ts`
 * for what the numbers mean and `docs/decisions/communications.md` for why
 * they are what they are.
 */

import type { Doc } from "../../_generated/dataModel";

/**
 * The lowest interval this deployment will accept, in minutes — **refused
 * server-side**, not merely absent from a picker. A client that posts 1 is
 * refused with the same error as one that posts 0 or 4.5.
 */
export const MIN_SYNC_INTERVAL_MINUTES = 5;

/** The interval a connection has when its owner has never chosen one. */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 15;

/**
 * The longest interval, one day. Not a policy about attention — a bound on
 * cursor expiry: Gmail drops a `historyId` after about a week, and under a
 * forward-only policy an expired cursor is mail nobody ever fetches.
 */
export const MAX_SYNC_INTERVAL_MINUTES = 24 * 60;

/**
 * How long a claimed pass may be silent before another may start.
 *
 * The same fifteen minutes, and the same argument, as
 * `fastSearch.sweepStalledBackfills`: a pass that is still running must never
 * be overtaken by a second one, and the only evidence a mutation has of a
 * running action is that something wrote to the row recently. `syncStartedAt`
 * is that heartbeat — set when the pass is claimed, cleared when it reports.
 */
export const SYNC_STALL_MS = 15 * 60 * 1000;

/**
 * The floor on how soon a *failed* pass is retried, whatever the interval.
 *
 * A connection Google is rate-limiting, or one whose grant has been revoked,
 * would otherwise be retried every five minutes forever by whoever chose the
 * floor — which is the request pattern most likely to keep it rate-limited.
 */
export const SYNC_FAILURE_BACKOFF_MS = 15 * 60 * 1000;

/**
 * The ceiling on that backoff: six hours.
 *
 * A ladder with no cap turns a fortnight of failures into a connection nobody
 * ever checks again, and the failures this actually meets — a revoked grant, a
 * daily quota, a bucket somebody has to reconnect — are all fixed by a person
 * doing something, after which the next pass should be hours away rather than
 * days.
 */
export const MAX_SYNC_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * How long to wait after a failure: the interval, or the ladder, whichever is
 * longer — plus a per-connection spread so a deployment's connections do not
 * all wake in the same minute after a Google outage ends.
 *
 * The spread is derived from the row id rather than drawn at random, because
 * this is computed inside a mutation and a value a test cannot predict is a
 * value a test cannot pin.
 */
export function failureBackoffMs(
  intervalMs: number,
  failures: number,
  connectionId: string,
): number {
  const step = Math.max(0, Math.min(Math.floor(failures) - 1, 8));
  const ladder = Math.min(MAX_SYNC_BACKOFF_MS, SYNC_FAILURE_BACKOFF_MS * 2 ** step);
  return Math.max(intervalMs, ladder) + spreadMs(connectionId);
}

/** Up to a minute, stable for one connection, different between connections. */
function spreadMs(connectionId: string): number {
  let hash = 0;
  for (let index = 0; index < connectionId.length; index += 1) {
    hash = (hash * 31 + connectionId.charCodeAt(index)) % 60_000;
  }
  return hash;
}

/**
 * Which products the loop can actually advance today.
 *
 * Gmail, and the loop is deliberately built around the *account* rather than
 * around Gmail: one row, one grant, one claim, one report. Calendar and Chat
 * join by being added here and given a pass in `functions/files.ts` — they do
 * not need a second cron, a second claim, or a second set of status fields.
 * See `docs/decisions/communications.md` for what each of them still needs.
 */
export const ENGINE_PRODUCTS = ["gmail", "chat"] as const;

/** The interval in force for a row: the owner's choice, or the default, never below the floor. */
export function syncIntervalMinutesOf(connection: { syncIntervalMinutes?: number }): number {
  const chosen = connection.syncIntervalMinutes;
  if (typeof chosen !== "number" || !Number.isFinite(chosen)) {
    return DEFAULT_SYNC_INTERVAL_MINUTES;
  }
  return Math.max(MIN_SYNC_INTERVAL_MINUTES, Math.floor(chosen));
}

/** Products on this row the loop can sync. Empty means there is nothing to poll for. */
export function syncableProductsOf(connection: { products: string[] }): string[] {
  return ENGINE_PRODUCTS.filter((product) => connection.products.includes(product));
}

/**
 * Is this connection due, by the contract the cron is written against:
 * `now >= lastSyncAt + interval`.
 *
 * Derived from `lastSyncAt` rather than read from `nextSyncAt`, on purpose.
 * `nextSyncAt` exists so the sweep can ask an index for candidates instead of
 * reading every connection in the deployment; it is a materialized copy, and a
 * copy is the thing that can be stale. The answer comes from the two facts it
 * was computed from.
 */
export function isDue(
  connection: {
    products: string[];
    gmail?: { lastSyncedAt?: number };
    chat?: { lastSyncedAt?: number };
    lastSyncAt?: number;
    syncIntervalMinutes?: number;
    syncCatchUp?: boolean;
  },
  now: number,
): boolean {
  /*
    A pass that ran out of pages is due again at once, whatever the interval.
    The interval is how often to *ask whether anything changed*; this
    connection is not asking, it is draining a backlog it has already seen the
    edge of, and every pass makes real progress because the cursor moved to the
    last record walked.
  */
  if (connection.syncCatchUp === true) return true;
  const products = syncableProductsOf(connection);
  const completedAt = products.map((product) =>
    product === "gmail"
      ? connection.gmail?.lastSyncedAt
      : connection.chat?.lastSyncedAt,
  );
  // A product newly added to an already-running Google account has never had
  // a chance to establish its own cursor. The account's recent Gmail pass
  // must not make that new Chat product look current.
  if (
    completedAt.length > 1 &&
    completedAt.some((at) => at !== undefined) &&
    completedAt.some((at) => at === undefined)
  ) {
    return true;
  }
  if (completedAt.length === 0) return false;
  if (completedAt.every((at) => at === undefined)) {
    if (connection.lastSyncAt === undefined) return true;
    return now >= connection.lastSyncAt + syncIntervalMinutesOf(connection) * 60_000;
  }
  return now >= Math.min(...(completedAt as number[])) + syncIntervalMinutesOf(connection) * 60_000;
}

/** The schedule as the console reads it. One implementation, two readers. */
export function syncStatusOf(connection: Doc<"googleConnections">): {
  intervalMinutes: number;
  everSynced: boolean;
  cursorReady: boolean;
  catchingUp: boolean;
  lastAttemptAt?: number;
  nextDueAt?: number;
  lastFailureAt?: number;
  lastFailureCode?: string;
  lastFailure?: string;
} {
  const intervalMinutes = syncIntervalMinutesOf(connection);
  const products = syncableProductsOf(connection);
  const productLastSyncedAt = products.map((product) =>
    product === "gmail"
      ? connection.gmail?.lastSyncedAt
      : connection.chat?.lastSyncedAt,
  );
  return {
    intervalMinutes,
    /* A successful provider read, not merely a connected grant. */
    everSynced: productLastSyncedAt.some((at) => at !== undefined),
    /* Gmail has an explicit history cursor. Chat's successful first pass
       establishes its per-space baselines, including the valid zero-space case. */
    cursorReady:
      connection.gmail?.historyId !== undefined ||
      connection.chat?.lastSyncedAt !== undefined,
    catchingUp: connection.syncCatchUp === true,
    lastAttemptAt: connection.lastSyncAt,
    nextDueAt:
      connection.disconnectedAt !== undefined
        ? undefined
        : (connection.nextSyncAt ??
          (connection.lastSyncAt === undefined
            ? undefined
            : connection.lastSyncAt + intervalMinutes * 60_000)),
    lastFailureAt: connection.lastSyncFailureAt,
    lastFailureCode: connection.lastSyncFailureCode,
    lastFailure: connection.lastSyncFailure,
  };
}
