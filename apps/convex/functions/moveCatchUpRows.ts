/**
 * The tree's side of a storage move's catch-up (`lib/moveCatchUp.ts`).
 *
 * A late version of a note that differs from the new bucket's is kept beside
 * it. A note's bytes live at its id key and its name is a tree row, so keeping
 * a version means a new note: its own id and key, and a row named
 * `<name> (saved during the move).md` in the same folder. A copy with no row
 * is a file nobody can open, which would lose the late edit after all.
 *
 * The copy carries the original's own access (its base and the owner's list)
 * in the same mutation that gives it its row: a private note's late version
 * is never readable by the team, not even for a moment. A share is the
 * owner's share of that one note and is not copied; the copy is only ever as
 * open as the original, or narrower.
 *
 * INTERNAL: only the catch-up passes call these (`moveCatchUp.ts`).
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { besideNames, noteIdOfKey } from "./lib/moveCatchUp";
import { refreshSnapshot } from "./lib/nodes/accessBackfill";
import { located } from "./lib/nodes/paths";
import { nodeAt } from "./lib/noteIds/state";
import { adoptKeyedRow } from "./noteIdsKeyed";

/** The live row keyed at `key`, at its path now, or null. */
async function liveRowAt(ctx: QueryCtx, workspaceId: Id<"workspaces">, key: string) {
  const noteId = noteIdOfKey(key);
  if (noteId === null) return null;
  const holders = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_noteId", (q) => q.eq("workspaceId", workspaceId).eq("noteId", noteId))
    .take(4);
  for (const row of holders) {
    if (row.goneAt !== undefined || row.kind !== "file" || row.storageKey !== key) continue;
    const at = await located(ctx.db, row);
    if (at !== null) return at;
  }
  return null;
}

const slotValidator = v.union(
  v.object({ free: v.literal(true) }),
  v.object({ free: v.literal(false), key: v.union(v.string(), v.null()) }),
);

/** Where the note keyed at `key` is, and what holds each name beside it. */
export const besideOf = internalQuery({
  args: { workspaceId: v.id("workspaces"), key: v.string() },
  returns: v.union(v.null(), v.object({ path: v.string(), slots: v.array(slotValidator) })),
  handler: async (ctx, { workspaceId, key }) => {
    const row = await liveRowAt(ctx, workspaceId, key);
    if (row === null) return null;
    const slots = [];
    for (const name of besideNames(row.path)) {
      const there = await nodeAt(ctx.db, workspaceId, name);
      if (there === null || there.goneAt !== undefined) slots.push({ free: true as const });
      else slots.push({ free: false as const, key: there.storageKey ?? null });
    }
    return { path: row.path, slots };
  },
});

/**
 * Gives a late version written at `key` its row at `path`, beside the note
 * keyed at `original`, with that note's access. False, and nothing written,
 * when the original is gone, `path` is not one of its beside names, or the
 * name is taken.
 */
export const adoptLateCopy = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    original: v.string(),
    path: v.string(),
    noteId: v.string(),
    key: v.string(),
    etag: v.string(),
    size: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, original, path, noteId, key, etag, size }) => {
    const source = await liveRowAt(ctx, workspaceId, original);
    if (source === null || !besideNames(source.path).includes(path)) return false;
    const there = await nodeAt(ctx.db, workspaceId, path);
    if (there !== null && there.goneAt === undefined) return false;

    const answer = await adoptKeyedRow(ctx, { workspaceId, path, noteId, key, etag, size, at: Date.now() });
    if (!answer.adopted) return false;
    const copy = await nodeAt(ctx.db, workspaceId, path);
    if (copy === null) return false;

    const grants = (
      await ctx.db
        .query("nodeAccess")
        .withIndex("by_node", (q) => q.eq("nodeId", source._id))
        .collect()
    ).filter((grant) => grant.source === "owner");
    if (source.access === undefined && grants.length === 0) return true;
    if (source.access !== undefined) await ctx.db.patch(copy._id, { access: source.access });
    const at = Date.now();
    for (const { _id, _creationTime, nodeId: _from, ...grant } of grants) {
      await ctx.db.insert("nodeAccess", { ...grant, nodeId: copy._id, at });
    }
    await refreshSnapshot(ctx, workspaceId);
    return true;
  },
});
