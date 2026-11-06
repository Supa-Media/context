/**
 * The handles this workspace object has been told resolve to whom: `@name` → `{kind: "user" | "group", id}`, as the
 * control plane resolved them (`apps/convex/functions/gatewayHandles.ts`), so adding people by name to a note's list
 * is decided here without asking the control plane again (`accessWrite.js`, `handles`).
 *
 * Only the control plane's answers are kept, and only a name it resolved: a name it did not is asked again every time.
 * A name is released only with its account or its group, so an entry can go stale only toward someone who no longer
 * exists, which grants nobody. It is still kept for `HANDLE_TTL_MS` only, so a person who re-joins under their old
 * name is resolved afresh within the hour. A disposable cache: nothing is lost with it.
 */

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ws_handles (handle TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL)",
];

/** How long a resolved handle is taken without asking again. */
export const HANDLE_TTL_MS = 60 * 60 * 1000;
/** The most handles kept; past it the oldest go. */
const MAX_HANDLES = 1000;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/** A handle as names are kept: lower-case, without `@`; `null` for anything that is not a plain name. */
export function handleKey(handle) {
  if (typeof handle !== "string") return null;
  const name = handle.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,64}$/.test(name) ? name : null;
}

export function workspaceHandles(sql) {
  for (const statement of SCHEMA) sql.exec(statement);
  return {
    /** The grantee a handle resolved to, while fresh, or null. */
    get(handle, now) {
      const key = handleKey(handle);
      if (key === null) return null;
      const row = all(sql.exec("SELECT kind, id, at FROM ws_handles WHERE handle = ?", key))[0];
      if (!row || row.at < now - HANDLE_TTL_MS) return null;
      return { kind: row.kind, id: row.id };
    },
    /** Keep what the control plane resolved. A malformed entry is refused. Inside the caller's transaction. */
    put(entries, now) {
      for (const entry of entries) {
        const key = handleKey(entry?.handle);
        if (key === null || (entry.kind !== "user" && entry.kind !== "group") || typeof entry.id !== "string" || !ID.test(entry.id)) {
          return false;
        }
      }
      for (const entry of entries) {
        sql.exec(
          "INSERT INTO ws_handles (handle, kind, id, at) VALUES (?, ?, ?, ?) ON CONFLICT(handle) DO UPDATE SET kind = excluded.kind, id = excluded.id, at = excluded.at",
          handleKey(entry.handle), entry.kind, entry.id, now,
        );
      }
      sql.exec("DELETE FROM ws_handles WHERE handle NOT IN (SELECT handle FROM ws_handles ORDER BY at DESC LIMIT ?)", MAX_HANDLES);
      return true;
    },
  };
}
