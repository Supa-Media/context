/**
 * How one row of a seam observation lands in the tree (`observe.ts` applies
 * the observation; this file says what each row does). Every row is the
 * store seam reporting its own keyed write: it writes a keyed row, or is
 * `taken` because the tree holds something else at that path, and nothing
 * changes. No row is ever taken from a listing of the bucket.
 *
 * Nothing here decides which rows are gone or pruned; that is `observe.ts`.
 */

import { folderChain, isKeyed, nameOf, type NodeRow, type NodeTable, type Observation, type StoredNode } from "./table";

/** Stores one row. Answers `taken` when the tree cannot hold it (`applySeamRow`). */
export async function applyRow(
  table: NodeTable,
  lookup: (path: string) => Promise<StoredNode | null>,
  cache: Map<string, StoredNode | null>,
  obs: Observation,
  path: string,
  row: NodeRow,
): Promise<"taken" | undefined> {
  return await applySeamRow(table, lookup, cache, obs.at, path, row);
}

/**
 * A seam write of a keyed row (`row.keyed` names its note and key). It lands
 * only where the tree can hold it, and otherwise changes nothing and says so:
 *
 * - no row, or a gone file row: the key is written as a file under this note.
 *   Over a gone row it is a NEW note: the row takes the new id and key, and
 *   forgets its old id copy and flip record. A tombstone newer than the write wins.
 * - a live keyed row of the same note: last observation wins, as always.
 * - anything else (a folder, a live unkeyed file, a keyed file of another note,
 *   or a file where a folder of the path must be): taken.
 */
async function applySeamRow(
  table: NodeTable,
  lookup: (path: string) => Promise<StoredNode | null>,
  cache: Map<string, StoredNode | null>,
  at: number,
  path: string,
  row: NodeRow,
): Promise<"taken" | undefined> {
  const keyed = row.keyed;
  // A note's key is never a folder marker (`a/`): a seam write of one has no note to land as.
  if (keyed === undefined || path.endsWith("/")) return "taken";
  let existing = await lookup(path);

  // A folder emptied and retired earlier holds the name only as a tombstone:
  // it gives way to the note, or the name could never be written again in a
  // keyed workspace, which is never pruned.
  // A tombstone folder a privacy rule names keeps its row (`nodes.access`), so it is "taken" below rather than removed.
  if (
    existing !== null &&
    existing.kind === "folder" &&
    existing.goneAt !== undefined &&
    existing.access === undefined &&
    !(await table.hasLiveChild(existing.id))
  ) {
    await table.remove(existing.id);
    cache.set(path, null);
    existing = null;
  }
  if (existing !== null && existing.kind === "folder") return "taken";
  if (existing !== null && existing.goneAt === undefined) {
    if (!isKeyed(existing) || existing.noteId !== keyed.noteId) return "taken";
    if (existing.observedAt > at) return undefined;
    const changed = existing.etag !== row.etag || existing.size !== row.size;
    // A seam write names no upload time; the write is it. Without this a keyed
    // write cleared `uploaded`, and the manifest's `updatedAt` with it, so
    // nothing reading "changed since" (Tex's check-in) ever saw a keyed note change.
    const uploaded = row.uploaded ?? (changed ? at : existing.uploaded);
    const fields = { etag: row.etag, size: row.size, uploaded, observedAt: at };
    await table.patch(existing.id, fields);
    if (changed) await table.logChange?.(path, false);
    cache.set(path, { ...existing, ...fields });
    await reviveChain(table, lookup, cache, path);
    return undefined;
  }

  // No row, or a gone file row.
  if (existing !== null && (existing.observedAt > at || (existing.goneAt !== undefined && existing.goneAt > at))) return undefined;
  if (await fileInFolderPlace(lookup, path)) return "taken";
  const placed = await placeChain(table, lookup, cache, path, at);
  if (placed === null) return "taken";

  if (existing === null) {
    const id = await table.insert({
      path,
      parentId: placed.parentId,
      name: nameOf(path),
      kind: "file",
      etag: row.etag,
      size: row.size,
      uploaded: row.uploaded ?? at,
      observedAt: at,
      noteId: keyed.noteId,
      storageKey: keyed.storageKey,
    });
    cache.set(path, {
      id,
      path,
      parentId: placed.parentId,
      name: nameOf(path),
      kind: "file",
      etag: row.etag,
      size: row.size,
      uploaded: row.uploaded ?? at,
      observedAt: at,
      noteId: keyed.noteId,
      storageKey: keyed.storageKey,
    });
    await table.logChange?.(path, false);
    await reviveChain(table, lookup, cache, path);
    return undefined;
  }
  // A gone row comes back as a new note: its old id copy and flip record described the old bytes.
  const fields = {
    noteId: keyed.noteId,
    storageKey: keyed.storageKey,
    etag: row.etag,
    size: row.size,
    uploaded: row.uploaded ?? at,
    observedAt: at,
    goneAt: undefined,
    idCopy: undefined,
    keyedFrom: undefined,
  };
  await table.patch(existing.id, fields);
  await table.logChange?.(path, false);
  cache.set(path, { ...existing, ...fields });
  await reviveChain(table, lookup, cache, path);
  return undefined;
}

/**
 * Creates or finds each folder of `path`, outermost first. `null` when a file
 * sits in one of those places: the row cannot be placed, and nothing above
 * that place is judged here.
 */
async function placeChain(
  table: NodeTable,
  lookup: (path: string) => Promise<StoredNode | null>,
  cache: Map<string, StoredNode | null>,
  path: string,
  at: number,
): Promise<{ parentId: string | undefined } | null> {
  let parentId: string | undefined;
  for (const folder of folderChain(path)) {
    parentId = await ensureFolder(table, lookup, cache, folder, parentId, at);
    if (parentId === undefined) return null;
  }
  return { parentId };
}

/** Whether a non-folder row sits at one of `path`'s folder places, so a seam write there is taken without any change. */
async function fileInFolderPlace(lookup: (path: string) => Promise<StoredNode | null>, path: string): Promise<boolean> {
  for (const folder of folderChain(path)) {
    const node = await lookup(folder);
    if (node !== null && node.kind !== "folder") return true;
  }
  return false;
}

/**
 * A live file sits under every folder in its chain, so none of them is gone,
 * whatever an emptier observation said about them.
 */
async function reviveChain(
  table: NodeTable,
  lookup: (path: string) => Promise<StoredNode | null>,
  cache: Map<string, StoredNode | null>,
  path: string,
): Promise<void> {
  for (const folder of folderChain(path)) {
    const node = await lookup(folder);
    if (node === null || node.kind !== "folder" || node.goneAt === undefined) continue;
    await table.patch(node.id, { goneAt: undefined });
    cache.set(folder, { ...node, goneAt: undefined });
  }
}

/**
 * The id of the folder at `path`, created if absent. `undefined` when a file
 * already sits at that key: a tree cannot hold both, and the caller skips the
 * row rather than guess which one the bucket means.
 */
async function ensureFolder(
  table: NodeTable,
  lookup: (path: string) => Promise<StoredNode | null>,
  cache: Map<string, StoredNode | null>,
  path: string,
  parentId: string | undefined,
  at: number,
): Promise<string | undefined> {
  const existing = await lookup(path);
  if (existing === null) {
    const id = await table.insert({ path, parentId, name: nameOf(path), kind: "folder", observedAt: at });
    cache.set(path, { id, path, parentId, name: nameOf(path), kind: "folder", observedAt: at });
    return id;
  }
  if (existing.kind !== "folder") return undefined;
  // Whether the folder is gone is decided by the row placed in it (`reviveChain`),
  // never by the walk to it: an older observation of a file that has since
  // gone must not bring its emptied folder back.
  if (existing.observedAt < at) {
    await table.patch(existing.id, { observedAt: at });
    cache.set(path, { ...existing, observedAt: at });
  }
  return existing.id;
}
