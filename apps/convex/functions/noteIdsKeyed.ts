/**
 * The keyed rows' functions (`lib/noteIds/keyed.ts` says what the answers
 * are). Internal only: the gateway reaches them through `lib/noteIds/http.ts`,
 * the console through `lib/noteIds/consoleLayer.ts`, and both have already
 * decided who may ask.
 *
 * - `notesFor` answers each path's row, and whether the workspace is keyed.
 *   Unfiltered by `canSee`: the store seam resolves a note's key whoever the
 *   reader is, and the tools decide what a person may see (as with path keys).
 * - `adoptKeyed` gives a note its row at its own id key, when the name is free.
 * - `recordKeyed` and `removeKeyed` move a keyed row's version or retire it, and
 *   only for the key the row holds.
 *
 * All three writes are seam observations (`observe.ts`), so the tree's rules
 * for a keyed row are the ones that already hold: a row is taken, not
 * overwritten, when the name is someone else's.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { isPlumbing } from "./lib/privacy";
import { convexNodeTable } from "./lib/nodes/convexTable";
import { applyObservation } from "./lib/nodes/observe";
import { idKeyFor, isNoteId } from "./lib/nodes/noteIds";
import type { Observation } from "./lib/nodes/table";
import { clampAt, entryOf, noteEntryValidator, type NoteEntry } from "./lib/noteIds/keyed";
import { keyedWorkspace } from "./lib/noteIds/keyedState";
import { nodeAt } from "./lib/noteIds/state";
import { canonicalJobPath } from "./lib/nodes/folderJobs";

const adoptResultValidator = v.union(
  v.object({ adopted: v.literal(true) }),
  v.object({ adopted: v.literal(false), taken: v.union(noteEntryValidator, v.null()) }),
);

/**
 * What the tree says about each of `paths` (one entry per path with a row,
 * in the order given): `keyed` is whether the workspace is keyed. INTERNAL.
 */
export const notesFor = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.object({ keyed: v.boolean(), notes: v.array(noteEntryValidator) }),
  handler: async (ctx, { workspaceId, paths }) => {
    const keyed = await keyedWorkspace(ctx.db, workspaceId);
    const notes: NoteEntry[] = [];
    for (const path of [...new Set(paths)]) {
      // A built-in folder's default name reaches the folder doing that job now (`folderJobs.ts`),
      // answered under the path asked, which is the one the caller looks it up by.
      const row = await nodeAt(ctx.db, workspaceId, keyed ? await canonicalJobPath(ctx.db, workspaceId, path) : path);
      if (row === null) continue;
      const entry = entryOf(row);
      if (entry !== null) notes.push({ ...entry, path });
    }
    return { keyed, notes };
  },
});

/** Whether another row of the workspace already holds this note id, at any path. */
async function noteIdHeldElsewhere(ctx: MutationCtx, workspaceId: Id<"workspaces">, noteId: string, path: string): Promise<boolean> {
  const holders = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_noteId", (q) => q.eq("workspaceId", workspaceId).eq("noteId", noteId))
    .take(2);
  return holders.some((row) => row.path !== path);
}

/** A seam observation of one keyed row, at `at`. */
function seamWrite(path: string, at: number, row: { etag: string; size?: number; noteId: string; storageKey: string }): Observation {
  return {
    at,
    rows: [
      {
        path,
        etag: row.etag,
        ...(row.size === undefined ? {} : { size: row.size }),
        keyed: { noteId: row.noteId, storageKey: row.storageKey },
      },
    ],
    gone: [],
    vanishedUnder: [],
    source: "seam",
  };
}

/**
 * Gives a new note its row, at the id key it was written to. Refused (taken
 * null) unless the note id is a UUIDv7, the key is that id's key for the path,
 * the path is not plumbing, the workspace is keyed, and no other row holds the
 * note id. Otherwise the write is applied, and the answer is read back from the
 * row: adopted only when that row is live, keyed, and this note's. Otherwise
 * `taken` is whatever holds the name (or null, when nothing readable does).
 * INTERNAL.
 */
export const adoptKeyed = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    noteId: v.string(),
    key: v.string(),
    etag: v.string(),
    size: v.optional(v.number()),
    at: v.number(),
  },
  returns: adoptResultValidator,
  handler: async (ctx, { workspaceId, path: asked, noteId, key, etag, size, at }) => {
    const refused = { adopted: false as const, taken: null };
    const path = await canonicalJobPath(ctx.db, workspaceId, asked);
    if (!isNoteId(noteId) || key !== idKeyFor(noteId, path) || isPlumbing(path)) return refused;
    if (!(await keyedWorkspace(ctx.db, workspaceId))) return refused;
    if (await noteIdHeldElsewhere(ctx, workspaceId, noteId, path)) return refused;

    await applyObservation(convexNodeTable(ctx, workspaceId), seamWrite(path, clampAt(at), { etag, size, noteId, storageKey: key }));
    const row = await nodeAt(ctx.db, workspaceId, path);
    if (row !== null && row.goneAt === undefined && row.storageKey !== undefined && row.noteId === noteId) {
      return { adopted: true as const };
    }
    const taken = row === null ? null : entryOf(row);
    return { adopted: false as const, taken: taken === null ? null : { ...taken, path: asked } };
  },
});

/**
 * Records the key's new version of a keyed note: `etag` and `size` of the key,
 * when the live row at `path` is keyed at exactly `key`. Answers whether the
 * row now holds `etag` (an older write, arriving late, leaves it as it was).
 * INTERNAL.
 */
export const recordKeyed = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    key: v.string(),
    etag: v.string(),
    size: v.optional(v.number()),
    at: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, path: asked, key, etag, size, at }) => {
    const path = await canonicalJobPath(ctx.db, workspaceId, asked);
    const row = await nodeAt(ctx.db, workspaceId, path);
    if (row === null || row.goneAt !== undefined || row.storageKey !== key || row.noteId === undefined) return false;
    await applyObservation(convexNodeTable(ctx, workspaceId), seamWrite(path, clampAt(at), { etag, size, noteId: row.noteId, storageKey: key }));
    return (await nodeAt(ctx.db, workspaceId, path))?.etag === etag;
  },
});

/**
 * Retires a keyed note: its row is gone from `at`, when the live row at `path`
 * is keyed at exactly `key`. Answers whether the row is gone now. INTERNAL.
 */
export const removeKeyed = internalMutation({
  args: { workspaceId: v.id("workspaces"), path: v.string(), key: v.string(), at: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, path: asked, key, at }) => {
    const path = await canonicalJobPath(ctx.db, workspaceId, asked);
    const row = await nodeAt(ctx.db, workspaceId, path);
    if (row === null || row.goneAt !== undefined || row.storageKey !== key) return false;
    await applyObservation(convexNodeTable(ctx, workspaceId), {
      at: clampAt(at),
      rows: [],
      gone: [path],
      vanishedUnder: [],
      source: "seam",
    });
    return (await nodeAt(ctx.db, workspaceId, path))?.goneAt !== undefined;
  },
});
