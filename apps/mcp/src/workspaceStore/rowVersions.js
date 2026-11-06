/**
 * A note row's version, made the one its own body here has.
 *
 * A row's `etag` is the version every listing reports (`ws.rows.files`, `ws.rows.listing`, the manifest), and a reader
 * compares it with the version a read returns. Rows copied in from the control plane carry the bucket's etag, and a
 * body copied in carries this object's own (`texStore/objects.js` hashes the bytes; the bucket does not hash them the
 * same way, `apps/convex/functions/lib/workspaceObjects/repair.ts`). Until a note is written again, the two never
 * match, so a reader that keeps a copy (the app's offline mirror, `apps/mobile/features/offline/mirrorSync.ts`) takes
 * every untouched note as changed and reads it again on every pass: on 2026-11-06 that was 3,000 to 6,000 reads every
 * ten minutes per workspace (`docs/decisions/observability/call-counts.md`).
 *
 * So, in a workspace whose notes live here, each live file row whose body this object holds takes that body's etag,
 * as an object-originated change (`rows.originate`), so a row pushed later from the control plane cannot put the
 * bucket's back. Bounded per call; a listing runs it before it answers, so the rows it lists are already stamped.
 */

/** Rows one call re-stamps; the next listing takes the rest. */
export const RESTAMP_LIMIT = 500;

/**
 * Re-stamp up to `limit` drifted rows. Returns how many changed. Never throws: a listing still answers.
 * @param {{exec: (query: string, ...args: unknown[]) => {toArray: () => Array<Record<string, unknown>>}}} sql
 * @param {{originate: (change: {id: string, fields: object}, now: number) => unknown}} rows
 */
export function restampRowVersions(sql, rows, now = Date.now(), { limit = RESTAMP_LIMIT, objectsTable = "objects" } = {}) {
  try {
    const drifted = sql
      .exec(
        `SELECT r.id AS id, o.etag AS etag FROM ws_rows r JOIN ${objectsTable} o ON o.key = r.storage_key
          WHERE r.gone = 0 AND r.kind = 'file' AND (r.etag IS NULL OR r.etag != o.etag) LIMIT ?`,
        limit,
      )
      .toArray();
    let changed = 0;
    for (const row of drifted) {
      if (typeof row.id !== "string" || typeof row.etag !== "string" || row.etag === "") continue;
      if (rows.originate({ id: row.id, fields: { etag: row.etag } }, now) !== null) changed += 1;
    }
    return changed;
  } catch {
    return 0;
  }
}
