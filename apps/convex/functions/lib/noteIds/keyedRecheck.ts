/**
 * One diagnosis for every keyed workspace whose rows may have fallen behind
 * their keys before the walks learned to say so (`checkAfterRewrite`).
 *
 * A keyed row's version is the one a row move checks a caller against, and a
 * reader is handed the key's (`idLayout.js`). The managed-encryption walk used
 * to seal keys with no row told, so a workspace keyed and sealed before then
 * can hold rows that refuse their own notes' archive, trash and moves until
 * something checks them. The diagnosis does (`recordKeyedCheckPage`); this
 * runs it once per such workspace, from the cron, a few workspaces a tick.
 */

import type { Doc } from "../../../_generated/dataModel";

/** Diagnoses finished before this may have left keyed rows behind their keys. */
export const KEYED_RECHECK_SINCE = Date.UTC(2026, 9, 20);

/** At most this many workspaces start the recheck in one cron tick, so a deploy does not fan out every bucket at once. */
export const KEYED_RECHECKS_PER_TICK = 20;

/** Whether `row`'s workspace is keyed and has had no diagnosis, and no recheck, since rows could be left behind. */
export function keyedRecheckOwed(row: Doc<"noteIdCopies">): boolean {
  if (row.status !== "done") return false;
  if (row.keyedRecheckAt !== undefined) return false;
  return (row.diagnosis?.checkedAt ?? 0) < KEYED_RECHECK_SINCE;
}
