/**
 * The owner's delete of hidden old copies (`oldCopies.deleteCopies`) where the workspace's notes live in its object:
 * the object removes `.context/old-copies` a page at a time (`ws.write.erase`), Convex's rows follow through the
 * mirror, and each page's files go to the trash's bucket half as `erasePage`'s do
 * (`docs/decisions/storage-and-credentials/background-tree-writers.md`). INTERNAL.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type ActionCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { OLD_COPIES_ROOT } from "./lib/fileOps/store";
import { keysOf, pageOf, type ObjectEraser } from "./lib/trash/objectErase";
import { consoleWorkspaceClient } from "./lib/workspaceObjects/door";

/** Object calls one run makes before it hands the rest to a fresh run (each page is at most 400 rows). */
const PAGES_PER_RUN = 25;
/** How long a run that could not reach the object waits before it tries again. */
const RETRY_MS = 5 * 60_000;

/** Whether the owner's delete is still under way: a run that finds it otherwise has nothing to do. */
export const deleting = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }) => {
    const record = await ctx.db.query("oldCopyHides").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
    return record?.state === "deleting";
  },
});

/** The last page went: the old copies are deleted, and the bucket half starts. */
export const finish = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const record = await ctx.db.query("oldCopyHides").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
    if (record === null || record.state !== "deleting") return null;
    await ctx.db.patch(record._id, { state: "deleted", deletedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.functions.trashEmptying.eraseWorkspace, { workspaceId });
    return null;
  },
});

/**
 * One run's pages: `done` once the last page went (or nothing was left), `more` when the run's pages ran out first,
 * `retry` when the object could not be reached or refused. The record is made before the first call
 * (`trashObject.begin`), so a run that stops anywhere loses no key.
 */
export async function deleteInObject(ctx: ActionCtx, workspaceId: Id<"workspaces">, client: ObjectEraser): Promise<"done" | "more" | "retry"> {
  let files = 0;
  const record = await ctx.runMutation(internal.functions.trashObject.begin, { workspaceId, folder: OLD_COPIES_ROOT });
  for (let pages = 0; pages < PAGES_PER_RUN; pages += 1) {
    let answer: unknown;
    try {
      answer = await client.write.erase({ path: OLD_COPIES_ROOT });
    } catch {
      return "retry";
    }
    const page = pageOf(answer);
    // Nothing left at the name: every copy is already gone.
    if (page === null && (answer as { code?: unknown } | null)?.code === "NOT_FOUND") {
      await ctx.runMutation(internal.functions.trashObject.append, { id: record, keys: [], done: true, audit: false, files });
      await ctx.runMutation(internal.functions.oldCopiesObject.finish, { workspaceId });
      return "done";
    }
    if (page === null) {
      console.error("old_copies.object_erase_refused", { workspaceId });
      return "retry";
    }
    files += page.files.length;
    // The owner's press already wrote the audit line (`deleteCopies`).
    await ctx.runMutation(internal.functions.trashObject.append, { id: record, keys: keysOf(page.files), done: !page.more, audit: false, files });
    if (!page.more) {
      await ctx.runMutation(internal.functions.oldCopiesObject.finish, { workspaceId });
      return "done";
    }
  }
  return "more";
}

export const erase = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    if (!(await ctx.runQuery(internal.functions.oldCopiesObject.deleting, { workspaceId }))) return null;
    const client = consoleWorkspaceClient(ctx, workspaceId, { caller: "oldCopiesObject" });
    const outcome = client === null ? "retry" : await deleteInObject(ctx, workspaceId, client);
    if (outcome !== "done") await ctx.scheduler.runAfter(outcome === "more" ? 0 : RETRY_MS, internal.functions.oldCopiesObject.erase, { workspaceId });
    return null;
  },
});
