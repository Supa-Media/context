/**
 * The one-time tidy of Archive (board 10, owner 2026-10-18; "yes to all"):
 * archiving used to file each note under a folder named for the moment
 * (`Archive/2026-10-15T22-16-49-545Z/1-projects/...`). Archive now keeps the
 * workspace's shape (`archiveMirror.cjs`), so each of those date folders is
 * emptied into the matching place, as it would be archived today
 * (`lib/fileOps/archiving.ts`, `tidyArchive`).
 *
 * `catchUp` runs hourly (`crons.ts`) over the keyed workspaces, and schedules
 * `tidyWorkspace` for each whose Archive still holds a date folder. It holds
 * no decision: what moves, and where, is read again inside the operation that
 * moves it, at the owner's clearance, through the same file operation the
 * console uses. Nothing is deleted; the emptied date folders go as any
 * emptied folder does. Once no workspace has a date folder left, every pass is
 * a read of one row per workspace.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, type QueryCtx } from "../_generated/server";
import { isArchiveStamp } from "@context/shared/src/archiveMirror.cjs";
import { folderJobsOf } from "./lib/nodes/folderJobs";

const WORKSPACE_PAGE = 20;
/** Passes one workspace's tidy makes in a row (one date folder each) before leaving the rest to the next hour. */
const PASSES = 100;

/** Whether the folder doing this workspace's Archive job holds a live date folder. */
async function owesTidy(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  const archive = (await folderJobsOf(ctx.db, workspaceId)).jobs.archive;
  if (archive === null) return false;
  const folder = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", archive))
    .unique();
  if (folder === null || folder.goneAt !== undefined) return false;
  // Date folders' names start with the year's digits: only those are read.
  const named = await ctx.db
    .query("nodes")
    .withIndex("by_parent_name", (q) => q.eq("workspaceId", workspaceId).eq("parentId", folder._id).gte("name", "0").lt("name", ":"))
    .take(200);
  return named.some((row) => row.goneAt === undefined && row.kind === "folder" && isArchiveStamp(row.name));
}

export const catchUp = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    if (layout?.mode !== "keys") return null;
    const page = await ctx.db.query("noteIdCopies").paginate({ cursor: cursor ?? null, numItems: WORKSPACE_PAGE });
    for (const copies of page.page) {
      if (copies.keyedAt === undefined) continue;
      if (!(await owesTidy(ctx, copies.workspaceId))) continue;
      await ctx.scheduler.runAfter(0, internal.functions.archiveTidy.tidyWorkspace, { workspaceId: copies.workspaceId });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.functions.archiveTidy.catchUp, { cursor: page.continueCursor });
    return null;
  },
});

/** Tidy one workspace's Archive, a bounded pass at a time, until no date folder is left or the passes run out. */
export const tidyWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ moved: v.number(), left: v.boolean() }),
  handler: async (ctx, { workspaceId }): Promise<{ moved: number; left: boolean }> => {
    let moved = 0;
    for (let pass = 0; pass < PASSES; pass += 1) {
      const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId,
        scope: "private",
        operation: { kind: "archiveTidy" },
      })) as { kind: string; paths?: string[]; queued?: number };
      moved += result.paths?.length ?? 0;
      if (result.queued === undefined) return { moved, left: false };
    }
    return { moved, left: true };
  },
});
