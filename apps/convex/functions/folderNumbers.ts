/**
 * The one-time rename that takes the sort numbers off built-in folders
 * (`lib/nodes/folderNumbers.ts`; owner, 2026-10-21).
 *
 * Run from the `Folder names without numbers` workflow, first with
 * `dryRun: true`, against staging and then production. `run` takes one page
 * of workspaces and answers with counts and the cursor for the next page;
 * the workflow loops until `done`. Counts only, never a path, an id or a
 * name: this repository is public, and so is that job's log. Running it
 * again renames nothing that was already renamed.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { pinUnkeyed, unpin } from "./lib/oldCopies/folders";
import { type FolderNumbersCounts, dropFolderNumbersIn, folderNumbersPlanValidator, planFolderNumbers } from "./lib/nodes/folderNumbers";
import type { OperationResult } from "./lib/filesFns/operationTypes";
import { rowsAfter } from "./lib/nodes/paths";

const DEFAULT_PAGE = 25;
/** Rows under a folder read per pin page: well inside one mutation's reads. */
const PIN_SCAN = 500;

export const plan = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: folderNumbersPlanValidator,
  handler: async (ctx, { workspaceId }) => await planFolderNumbers(ctx.db, workspaceId),
});

/**
 * Pin one page of the unkeyed file rows under `folder` (their key set to the
 * path their bytes are at, `lib/oldCopies/folders.ts`), so the rename's row
 * move takes them instead of refusing the folder. Answers the rows pinned and
 * where the next page starts.
 */
export const pinPage = internalMutation({
  args: { workspaceId: v.id("workspaces"), folder: v.string(), after: v.optional(v.string()) },
  returns: v.object({ pinned: v.array(v.id("nodes")), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { workspaceId, folder, after }) => {
    const rows = await rowsAfter(ctx.db, workspaceId, folder, after, PIN_SCAN);
    const pinned = await pinUnkeyed(ctx, rows);
    return { pinned, next: rows.length < PIN_SCAN ? null : rows[rows.length - 1].path };
  },
});

/** Take back pins a refused rename did not use. */
export const unpinRows = internalMutation({
  args: { ids: v.array(v.id("nodes")) },
  returns: v.null(),
  handler: async (ctx, { ids }) => {
    await unpin(ctx, ids);
    return null;
  },
});

export const workspacePage = internalQuery({
  args: { cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.object({ workspaceIds: v.array(v.id("workspaces")), cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, { cursor, limit }) => {
    const page = await ctx.db.query("workspaces").paginate({ cursor: cursor ?? null, numItems: limit ?? DEFAULT_PAGE });
    return { workspaceIds: page.page.map((row) => row._id), cursor: page.continueCursor, done: page.isDone };
  },
});

const countsValidator = v.object({
  workspaces: v.number(),
  changed: v.number(),
  renamed: v.number(),
  wouldRename: v.number(),
  twins: v.number(),
  refused: v.record(v.string(), v.number()),
  cursor: v.string(),
  done: v.boolean(),
});

export const run = internalAction({
  args: { dryRun: v.boolean(), cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: countsValidator,
  handler: async (ctx, { dryRun, cursor, limit }) => {
    const page: { workspaceIds: Id<"workspaces">[]; cursor: string; done: boolean } = await ctx.runQuery(
      internal.functions.folderNumbers.workspacePage,
      { ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) },
    );
    const totals = { workspaces: 0, changed: 0, renamed: 0, wouldRename: 0, twins: 0, refused: {} as Record<string, number> };
    for (const workspaceId of page.workspaceIds) {
      const move = async (from: string, to: string): Promise<OperationResult> =>
        (await ctx.runAction(internal.functions.files.runFileOperation, {
          workspaceId,
          scope: "private",
          grantedNames: [],
          operation: { kind: "nodesMoveStart", from, to },
        })) as OperationResult;
      let counts: FolderNumbersCounts;
      try {
        counts = await dropFolderNumbersIn(ctx, workspaceId, move, dryRun);
      } catch {
        totals.workspaces += 1;
        totals.refused.FAILED = (totals.refused.FAILED ?? 0) + 1;
        continue;
      }
      totals.workspaces += 1;
      if (counts.renamed > 0) totals.changed += 1;
      totals.renamed += counts.renamed;
      totals.wouldRename += counts.wouldRename;
      totals.twins += counts.twins;
      for (const [code, n] of Object.entries(counts.refused)) totals.refused[code] = (totals.refused[code] ?? 0) + n;
    }
    return { ...totals, cursor: page.cursor, done: page.done };
  },
});
