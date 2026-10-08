/**
 * What changed in a context's tree since a device last synced, from
 * `tree_log` (`table.js`, "What changed since").
 *
 * Rows, not decisions: whether a row may be shown to a reader is the
 * console's call (`treeChanges.ts`), by `canSee` for a key that is there and
 * by the audiences recorded when it left for one that is not.
 */

import { TOMBSTONE_MS } from "./table.js";

/** Log rows one read returns. */
export const CHANGE_PAGE_ROWS = 2_000;

/**
 * How far behind the database's clock a finished catch-up resumes. A write
 * reads the clock inside its batch and commits a moment later, so a reader
 * between the two would step past it; going back this far reads it next time.
 * Every row is an upsert or a removal, so reading one twice changes nothing.
 */
export const CHANGE_OVERLAP_MS = 60_000;

/**
 * Whether a catch-up from `since` can be answered from the log, given the
 * table's state: the log must reach back that far, and not past pruning.
 */
export function changesReachBack(state, since) {
  if (!state.ready || state.unsupported) return false;
  if (state.logFrom === null || state.now === null) return false;
  if (!Number.isFinite(since) || since < state.logFrom) return false;
  return since > state.now - TOMBSTONE_MS + CHANGE_OVERLAP_MS;
}

/**
 * One page of the log after `(since, after)`, in `(at, path)` order, each row
 * with the key's current version where the table still holds it.
 */
export async function listTreeChanges(client, { since, after = "", limit = CHANGE_PAGE_ROWS }) {
  const rows = await client.query(
    `SELECT l.path AS path, l.at AS at, l.gone AS gone, l.audiences AS audiences,
            t.etag AS etag, t.size AS size, t.uploaded AS uploaded, t.path IS NOT NULL AS present
     FROM tree_log AS l LEFT JOIN tree AS t ON t.path = l.path
     WHERE l.at > ?1 OR (l.at = ?1 AND l.path > ?2)
     ORDER BY l.at, l.path LIMIT ?3`,
    [since, after, Math.max(1, Math.min(limit, CHANGE_PAGE_ROWS))],
  );
  return rows.map((row) => ({
    path: String(row.path),
    at: Number(row.at),
    gone: Number(row.gone) === 1 || Number(row.present) !== 1,
    audiences: parseAudiences(row.audiences),
    ...(typeof row.etag === "string" && row.etag !== "" ? { etag: row.etag } : {}),
    ...(Number.isFinite(Number(row.size)) && row.size !== null ? { size: Number(row.size) } : {}),
    ...(Number.isFinite(Number(row.uploaded)) && row.uploaded !== null ? { uploaded: Number(row.uploaded) } : {}),
  }));
}

/** Which of these folders still hold any key, by the table. */
export async function foldersStillHeld(client, folders) {
  if (folders.length === 0) return new Set();
  const rows = await client.query(
    `SELECT f.value AS folder FROM json_each(?1) AS f
     WHERE EXISTS (SELECT 1 FROM tree AS t WHERE t.path >= f.value || '/' AND t.path < f.value || '0')`,
    [JSON.stringify(folders)],
  );
  return new Set(rows.map((row) => String(row.folder)));
}

function parseAudiences(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : null;
  } catch {
    return null;
  }
}
