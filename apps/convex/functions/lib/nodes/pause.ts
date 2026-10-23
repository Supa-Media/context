/**
 * The migration's switch (`nodeMigration`): one row, absent means running.
 *
 * Read where the facts fill is started (`nodesMigration`), and at the top of
 * every facts-fill pass (`runNodesOperation`), which is what stops a running
 * chain at its next pass. Resuming starts what is due. The icons, emoji and
 * forwarding files and the privacy export are not paused by it.
 */

import type { DatabaseReader } from "../../../_generated/server";

export async function migrationPaused(db: DatabaseReader): Promise<boolean> {
  const row = await db.query("nodeMigration").first();
  return row?.paused === true;
}
