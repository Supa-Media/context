/**
 * Keeping one workspace's Google passes back to back.
 *
 * The sweep runs one pass per workspace at a time (the shared-writer lock in
 * `sweepDueGoogleSyncs`), one product per pass. Waiting for the five-minute
 * cron between passes meant a person with three accounts, each with Gmail,
 * Calendar and Chat, got one pass every five minutes for all nine: a pushed
 * email could wait most of an hour behind routine polls. So the sweep serves
 * pushed connections first.
 *
 * A reported pass used to queue the next sweep at once. With copying stopped
 * (owner, 2026-10-21) nothing schedules the sweep, and that chain was what
 * kept passes already in flight at the stop starting each other a day later,
 * still writing mail under the Inbox (2026-10-22). Adding a kind back on
 * purpose means deciding again how its passes are started.
 */

import type { Doc } from "../../../_generated/dataModel";
import { productBackingOff, syncableProductsOf } from "../googleSchedule";

type Row = Doc<"googleConnections">;

/** Google told us something changed for this row, on a product not waiting out a failure. */
export function pushedNow(row: Row, now: number): boolean {
  const pending = row.push?.pending;
  if (pending === undefined) return false;
  return syncableProductsOf(row).some(
    (product) => pending[product] !== undefined && !productBackingOff(row, product, now),
  );
}

/**
 * The sweep's order: pushed connections first, then by due time as the index
 * gave them. Stable, so the index's order holds within each half.
 */
export function pushedFirst(rows: Row[], now: number): Row[] {
  return [...rows.filter((row) => pushedNow(row, now)), ...rows.filter((row) => !pushedNow(row, now))];
}
