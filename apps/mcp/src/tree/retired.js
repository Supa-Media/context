/**
 * The search database's tree tables, retired.
 *
 * Each context's search database once kept a copy of its tree beside the
 * search projection: the keys (`tree`, `tree_gone`), their links
 * (`tree_links`, `tree_link_sources`), their front matter (`tree_props`) and
 * the chaos score per folder (`tree_chaos`, with its daily history in
 * `index_state`). The Convex control plane holds all of that now, and the
 * gateway asks it (`tree/served.js`, `tree/facts.js`), so phase 7 of
 * `docs/decisions/app-and-console/convex-tree.md` stops the gateway writing
 * or reading any of it. The database itself stays: it is the fast search
 * index.
 *
 * These statements remove what an older build left behind. Every one is
 * idempotent, so they ride along with the search projection's own write
 * (`search/writeProjection.js`) rather than needing a migration step, and
 * that write drops them from its retry, so retiring a derivative can never
 * cost a search write. `index_state` itself is the search backfill's and the
 * history's too, so only the tree's and the chaos score's keys leave it.
 */

/** Every `index_state` key the tree tables and the chaos score kept. */
export const RETIRED_STATE_KEYS = Object.freeze([
  "tree_ready",
  "tree_swept_at",
  "tree_cursor",
  "tree_started_at",
  "tree_lease_at",
  "tree_dirty",
  "tree_unsupported",
  "tree_error",
  "tree_error_at",
  "tree_log_start",
  "tree_links_ready",
  "tree_props_ready",
  "chaos_ready",
  "chaos_daily",
]);

/** The tables, dropped with their indexes, and their keys, deleted. */
export const RETIRED_TREE_STATEMENTS = Object.freeze([
  "DROP TABLE IF EXISTS tree",
  "DROP TABLE IF EXISTS tree_gone",
  "DROP TABLE IF EXISTS tree_log",
  "DROP TABLE IF EXISTS tree_links",
  "DROP TABLE IF EXISTS tree_link_sources",
  "DROP TABLE IF EXISTS tree_props",
  "DROP TABLE IF EXISTS tree_chaos",
  // Part of the provisioned schema; made here only so a database missing it
  // cannot turn the delete below into an error.
  `CREATE TABLE IF NOT EXISTS index_state (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `DELETE FROM index_state WHERE key IN (${RETIRED_STATE_KEYS.map((key) => `'${key}'`).join(", ")})`,
]);
