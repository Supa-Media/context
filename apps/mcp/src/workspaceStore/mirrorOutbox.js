/**
 * The changes a workspace object has taken and not yet mirrored to the control plane
 * (`docs/decisions/storage-and-credentials/object-row-writes.md`, "Convex keeps a mirror, written behind").
 * One row per change, in the object's own SQLite, written in the same storage transaction as the change it
 * describes (`workspaceStore/serveWrites.js`), so a change is queued if and only if it landed. Pure over a `sql`
 * with the Durable Object's shape (`exec(query, ...binds)` → cursor with `toArray()`), like `rows.js`.
 *
 * Counters (`skipped`, `failures`) are kept beside the queue for the app's and the operator's readout only.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ws_mirror (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    change TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ws_mirror_meta (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
];

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

export function mirrorOutbox(sql) {
  for (const statement of SCHEMA) sql.exec(statement);
  const counter = (name) => Number(all(sql.exec("SELECT value FROM ws_mirror_meta WHERE name = ?", name))[0]?.value ?? 0);
  const bump = (name, by) => sql.exec("INSERT INTO ws_mirror_meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value", name, by);

  const outbox = {
    /** Queue one change for `workspaceId`; returns its sequence number (the order the mirror applies them in). */
    enqueue(workspaceId, change, now) {
      if (typeof workspaceId !== "string" || workspaceId === "") throw new TypeError("a mirrored change names its workspace");
      if (!change || typeof change !== "object") throw new TypeError("a mirrored change is an object");
      if (!Number.isFinite(now)) throw new TypeError("a mirrored change carries its clock");
      sql.exec("INSERT INTO ws_mirror (workspace_id, change, at) VALUES (?, ?, ?)", workspaceId, JSON.stringify(change), now);
      // Read back inside the caller's transaction, so no other write can land between the insert and this read.
      return Number(all(sql.exec("SELECT MAX(seq) AS seq FROM ws_mirror"))[0].seq);
    },

    /** The oldest queued changes, in the order they were taken: `[{seq, workspaceId, change}]`. */
    pending(limit = 100) {
      return all(sql.exec("SELECT seq, workspace_id, change FROM ws_mirror ORDER BY seq LIMIT ?", limit)).map((row) => ({
        seq: Number(row.seq),
        workspaceId: row.workspace_id,
        change: JSON.parse(row.change),
      }));
    },

    /** Forget changes the mirror has applied (or refused for good). */
    drop(seqs) {
      for (const seq of seqs) sql.exec("DELETE FROM ws_mirror WHERE seq = ?", seq);
    },

    count() {
      return Number(all(sql.exec("SELECT COUNT(*) AS n FROM ws_mirror"))[0].n);
    },

    noteSkipped(n) {
      if (n > 0) bump("skipped", n);
    },

    noteFailure() {
      bump("failures", 1);
    },

    stats() {
      return { pending: outbox.count(), skipped: counter("skipped"), failures: counter("failures") };
    },
  };
  return outbox;
}
