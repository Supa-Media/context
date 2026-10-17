/**
 * The first-connect Gmail import's bookkeeping on the connection row: how many
 * tries it gets, and what one pass's outcome makes of it.
 *
 * A leaf: no `ctx`, no registered function, no credential. The import itself
 * runs inside `runFileOperation` (`lib/filesFns/gmailRecentImport.ts`); the
 * argument for it is in `docs/decisions/communications/gmail-and-sync-loop.md`,
 * "A first connect reads the last fifty messages, and that is not a backfill".
 */

import type { Doc } from "../../../_generated/dataModel";

/**
 * Failed passes an import may take before it is given up. It runs instead of
 * the forward pass on its turn, so an import that can never succeed would
 * otherwise hold Gmail's sync behind it forever. Three tries on the failure
 * ladder (fifteen minutes, then thirty) span about three quarters of an hour:
 * long enough for a transient Google error, short enough that a broken import
 * costs a new connection its first hour and nothing after.
 */
export const RECENT_IMPORT_MAX_ATTEMPTS = 3;

export type RecentImportState = NonNullable<NonNullable<Doc<"googleConnections">["gmail"]>["recentImport"]>;

export type RecentImportOutcome = { outcome: "done"; messages: number } | { outcome: "failed" };

/**
 * The row's next import state. Only a `pending` import moves: a report
 * arriving for one already finished or given up — a retried pass, a race with
 * a reconnect — changes nothing, so the import can never be re-armed by a
 * late result.
 */
export function nextRecentImport(
  current: RecentImportState | undefined,
  report: RecentImportOutcome | undefined,
  now: number,
): RecentImportState | undefined {
  if (current === undefined || report === undefined || current.status !== "pending") return current;
  if (report.outcome === "done") {
    return { status: "done", attempts: current.attempts, completedAt: now, messages: report.messages };
  }
  const attempts = current.attempts + 1;
  return attempts >= RECENT_IMPORT_MAX_ATTEMPTS
    ? { status: "abandoned", attempts, completedAt: now }
    : { status: "pending", attempts };
}
