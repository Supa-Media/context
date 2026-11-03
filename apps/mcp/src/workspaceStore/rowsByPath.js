/**
 * The live row at a path, read from the object's own rows (`workspaceStore/rows.js` keeps them in `ws_rows`).
 * A write op names a file by its path; this is the one lookup it needs, so `rows.js` stays as its parallel
 * owner left it. `null` when no live row has the path.
 */
export function liveRowByPath(sql, path) {
  const cursor = sql.exec("SELECT id, kind, path, storage_key FROM ws_rows WHERE path = ? AND gone = 0 ORDER BY id LIMIT 1", path);
  const row = typeof cursor?.toArray === "function" ? cursor.toArray()[0] : undefined;
  return row ? { id: row.id, kind: row.kind, path: row.path, storageKey: row.storage_key ?? null } : null;
}
