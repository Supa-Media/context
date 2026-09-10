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
 * Which products the loop can actually advance today.
 *
 * Gmail, and the loop is deliberately built around the *account* rather than
 * around Gmail: one row, one grant, one claim, one report. Calendar and Chat
 * join by being added here and given a pass in `functions/files.ts` — they do
 * not need a second cron, a second claim, or a second set of status fields.
 * See `docs/decisions/communications.md` for what each of them still needs.
 */
export const ENGINE_PRODUCTS = ["gmail"] as const;

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
  connection: { lastSyncAt?: number; syncIntervalMinutes?: number },
  now: number,
): boolean {
  if (connection.lastSyncAt === undefined) return true;
  return now >= connection.lastSyncAt + syncIntervalMinutesOf(connection) * 60_000;
}

/** The schedule as the console reads it. One implementation, two readers. */
export function syncStatusOf(connection: Doc<"googleConnections">): {
  intervalMinutes: number;
  everSynced: boolean;
  lastAttemptAt?: number;
  nextDueAt?: number;
  lastFailureAt?: number;
  lastFailureCode?: string;
  lastFailure?: string;
} {
  const intervalMinutes = syncIntervalMinutesOf(connection);
  return {
    intervalMinutes,
    /*
      The distinction the product has been missing. A connection that has never
      synced and one syncing fine were the same screen, and this is the field
      that separates them: it is about mail actually read, so a pass that was
      skipped or that failed does not make it true.
    */
    everSynced: connection.gmail?.lastSyncedAt !== undefined,
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
