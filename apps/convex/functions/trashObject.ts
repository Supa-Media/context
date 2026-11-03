/**
 * Emptying the trash of a workspace whose notes live in its object (`lib/trash/objectErase.ts`), and the owner's
 * delete of its old copies (`oldCopiesObject.ts`): the control plane names the folder, the object removes its rows
 * (`ws.write.erase`), and this records what the bucket half still deletes. The rows themselves reach Convex through the
 * mirror, never from here (`docs/decisions/storage-and-credentials/background-tree-writers.md`). INTERNAL.
 *
 * The record is written before the object erases (`begin`), with every key the mirror holds under the folder, and is
 * held back from the bucket half (`objectPending`) until the erase is known to have happened: the object answered the
 * folder's last page (`append` with `done`), or a later pass finds the folder gone from the mirror (`settle`). So a run
 * that dies between the object's answer and its own record still leaves the keys to delete, and a run that dies before
 * the object erased anything deletes nothing a restore could still want.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery, type DatabaseReader } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { recordAudit } from "./lib/audit";
import { nodeAt, rowsAfter } from "./lib/nodes/paths";
import { GROUP_SCAN, stampFolders, TRASH_KEEP_DAYS } from "./lib/trash/bin";

/** The oldest stamp folder past its date, as the mirror holds it, or `null` when none is due at `now`. */
export const dueFolder = internalQuery({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { workspaceId, now }) => (await stampFolders(ctx.db, workspaceId)).find((stamp) => stamp.eraseAt <= now)?.folder ?? null,
});

async function pendingFor(db: DatabaseReader, workspaceId: Id<"workspaces">, folder: string) {
  const rows = await db.query("trashErasures").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
  return rows.find((row) => row.objectPending === true && row.folder === folder) ?? null;
}

/** The record for erasing `folder` in the object, made once with the keys the mirror holds under it. */
export const begin = internalMutation({
  args: { workspaceId: v.id("workspaces"), folder: v.string() },
  returns: v.id("trashErasures"),
  handler: async (ctx, { workspaceId, folder }) => {
    const held = await pendingFor(ctx.db, workspaceId, folder);
    if (held !== null) return held._id;
    // Bounded: the object's answers add what a folder bigger than this holds.
    const rows = await rowsAfter(ctx.db, workspaceId, folder, undefined, GROUP_SCAN);
    const keys = [...new Set(rows.flatMap((row) => (row.kind === "file" && row.storageKey !== undefined ? [row.storageKey] : [])))];
    return await ctx.db.insert("trashErasures", {
      workspaceId,
      folder,
      path: folder,
      keys,
      histories: [],
      claimedAt: Date.now(),
      attempts: 0,
      objectPending: true,
    });
  },
});

/** One erased page's keys, added to the record. On the folder's last page (`done`) the record goes to the bucket half. */
export const append = internalMutation({
  args: { id: v.id("trashErasures"), keys: v.array(v.string()), done: v.boolean(), audit: v.boolean(), files: v.number() },
  returns: v.null(),
  handler: async (ctx, { id, keys, done, audit, files }) => {
    const row = await ctx.db.get(id);
    if (row === null) return null;
    await ctx.db.patch(id, { keys: [...new Set([...row.keys, ...keys])], ...(done ? { objectPending: undefined } : {}) });
    if (done && audit) {
      await recordAudit(ctx, {
        workspaceId: row.workspaceId,
        action: "file.delete",
        paths: [row.folder],
        details: { files, erasedFromTrash: true, keptDays: TRASH_KEEP_DAYS },
      });
    }
    return null;
  },
});

/** A record whose folder the mirror no longer holds, nor anything under it, was erased by a run that did not live to say so: it goes to the bucket half. */
export const settle = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.number(),
  handler: async (ctx, { workspaceId }) => {
    let settled = 0;
    for (const row of await ctx.db.query("trashErasures").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect()) {
      if (row.objectPending !== true) continue;
      const held = await nodeAt(ctx.db, workspaceId, row.folder);
      if (held !== null && held.goneAt === undefined) continue;
      // The object removes a folder's deepest rows first and the folder itself last, so a missing folder row means the
      // erase finished; a row still under it (a folder the mirror never held a row for) says it did not.
      if ((await rowsAfter(ctx.db, workspaceId, row.folder, undefined, 1)).length > 0) continue;
      await ctx.db.patch(row._id, { objectPending: undefined });
      settled += 1;
    }
    return settled;
  },
});
