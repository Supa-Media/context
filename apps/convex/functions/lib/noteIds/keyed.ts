/**
 * What the tree says about one path, in the shape the gateway's store seam
 * reads (`apps/mcp/src/store/idLayout.js`, `controlPlane/noteIds.js`), and the
 * clock rule the keyed writes share.
 *
 * Four states, one per kind of row a path can name:
 *  - `keyed`: a live file whose bytes live only at `key` (`storageKey`);
 *  - `path`: a live unkeyed file, with the id copy the copy pass made of it;
 *  - `gone`: a tombstone, or a retired folder, which a new note may take over;
 *  - `folder`: a live folder.
 * A path with no row is not an entry at all.
 */

import { v, type Infer } from "convex/values";
import type { Doc } from "../../../_generated/dataModel";
import { copyIsFresh, idKeyFor } from "../nodes/noteIds";

export const noteEntryValidator = v.union(
  v.object({
    path: v.string(),
    state: v.literal("keyed"),
    noteId: v.string(),
    key: v.string(),
    etag: v.string(),
    size: v.optional(v.number()),
    /** The path etag the row was keyed from, while the key still holds the version it was keyed at. */
    legacyEtag: v.optional(v.string()),
  }),
  v.object({
    path: v.string(),
    state: v.literal("path"),
    key: v.string(),
    etag: v.union(v.string(), v.null()),
    keyEtag: v.union(v.string(), v.null()),
    fresh: v.boolean(),
  }),
  v.object({ path: v.string(), state: v.literal("gone") }),
  v.object({ path: v.string(), state: v.literal("folder") }),
);

export type NoteEntry = Infer<typeof noteEntryValidator>;

/**
 * The entry for a row, or `null` when the row cannot be answered: a live file
 * with no id, or a keyed row with no version, which nothing can address.
 */
export function entryOf(row: Doc<"nodes">): NoteEntry | null {
  if (row.goneAt !== undefined) return { path: row.path, state: "gone" };
  if (row.kind === "folder") return { path: row.path, state: "folder" };
  if (row.noteId === undefined) return null;
  if (row.storageKey !== undefined) {
    if (row.etag === undefined) return null;
    const legacy = row.keyedFrom !== undefined && row.etag === row.keyedFrom.keyEtag ? row.keyedFrom.pathEtag : undefined;
    return {
      path: row.path,
      state: "keyed",
      noteId: row.noteId,
      key: row.storageKey,
      etag: row.etag,
      ...(row.size === undefined ? {} : { size: row.size }),
      ...(legacy === undefined ? {} : { legacyEtag: legacy }),
    };
  }
  return {
    path: row.path,
    state: "path",
    key: idKeyFor(row.noteId, row.path),
    etag: row.idCopy?.etag ?? null,
    keyEtag: row.idCopy?.keyEtag ?? null,
    fresh: copyIsFresh(row),
  };
}

/**
 * A write's time, never later than the server's clock: a store that stamps a
 * row in the future would keep it from every observation that follows.
 */
export function clampAt(at: number, now: number = Date.now()): number {
  return Math.min(at, now);
}
