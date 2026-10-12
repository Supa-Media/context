/**
 * The migration's switch (`nodeMigration`): one row, absent means running.
 *
 * Read in three places, so a pause really stops the work: before a sweep is
 * scheduled (`requestSweep`, `startNodesSweepIfDue`), and at the top of every
 * sweep or re-check that was already scheduled (`runNodesOperation`), which
 * is what stops a running chain at its next pass. A change made while paused
 * marks the tree dirty, so resuming catches it up.
 */

import type { DatabaseReader } from "../../../_generated/server";

export async function migrationPaused(db: DatabaseReader): Promise<boolean> {
  const row = await db.query("nodeMigration").first();
  return row?.paused === true;
}
