/**
 * A folder's Sort setting: how its rows are drawn, for everybody in the workspace (owner, 2026-11-04;
 * `docs/decisions/app-and-console/folder-sort.md`, the rules in `listingSort.cjs`).
 *
 * The setting is on the folder's row (`nodes.sort`), so it follows the folder through every rename and move and
 * reaches the workspace's object with the rest of the row. The top level has no row: its setting, which a folder
 * with none of its own also draws by, is the workspace's (`workspaces.treeSort`), set from the sort button at the
 * top of the tree. It changes what everybody sees, so it takes an editor, the role reordering takes. A folder the
 * caller cannot see is refused as not found, and never written to.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalQuery, query } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { callerId } from "./lib/filesFns/access";
import { clearanceOf } from "./lib/clearance";
import { folderVisibleAtScope } from "./lib/fileOps/listing";
import { requireFolderPath } from "./lib/fileOps/paths";
import { toConvexError } from "./lib/filesFns/operationErrors";
import { FileOpError } from "./lib/fileOps/errors";
import type { Visibility } from "./lib/privacy";
import { located, nodeAt } from "./lib/nodes/paths";
import { getAuthUserId } from "./lib/signedIn";
import { getMembership } from "./lib/workspaceAuth";
import { isListingSort, LISTING_SORTS } from "@context/shared/src/listingSort.cjs";

/** Folders beneath one folder whose own setting "Apply to folders inside" clears in one call. */
export const FOLDER_SORT_INSIDE_MAX = 2_000;

const sortValidator = v.union(v.string(), v.null());

/** The workspace's own setting, for a member; null for none, or for somebody who is not one. */
export const workspaceSort = query({
  args: { workspaceId: v.id("workspaces") },
  returns: sortValidator,
  handler: async (ctx, { workspaceId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    if ((await getMembership(ctx, workspaceId, userId)) === null) return null;
    const workspace = await ctx.db.get(workspaceId);
    return workspace !== null && isListingSort(workspace.treeSort) ? workspace.treeSort : null;
  },
});

/** The folders beneath `folder` (`""`: all) with a setting of their own, at their paths now. INTERNAL. */
export const heldInside = internalQuery({
  args: { workspaceId: v.id("workspaces"), folder: v.string() },
  returns: v.array(v.object({ id: v.id("nodes"), path: v.string() })),
  handler: async (ctx, { workspaceId, folder }) => {
    const prefix = folder === "" ? "" : `${folder}/`;
    const found: Array<{ id: Id<"nodes">; path: string }> = [];
    // One exact range per setting: the rows that hold one, never the whole tree.
    for (const sort of LISTING_SORTS) {
      const held = ctx.db
        .query("nodes")
        .withIndex("by_workspace_sort", (q) => q.eq("workspaceId", workspaceId).eq("sort", sort));
      for await (const row of held) {
        if (row.goneAt !== undefined || row.kind !== "folder") continue;
        const here = await located(ctx.db, row);
        if (here === null || here.path === folder || !here.path.startsWith(prefix)) continue;
        if (found.length === FOLDER_SORT_INSIDE_MAX) throw new FileOpError("PATH_INVALID", "There are too many folders inside to change at once.");
        found.push({ id: row._id, path: here.path });
      }
    }
    return found;
  },
});

/**
 * Writes the setting on `folder` (`""`: the workspace's), or clears it with null, and clears the setting of each
 * folder in `clear` (the ones beneath that the caller can see, for "Apply to folders inside"). INTERNAL: `set` has
 * judged the caller and every folder.
 */
export const write = internalMutation({
  args: { workspaceId: v.id("workspaces"), folder: v.string(), sort: sortValidator, clear: v.array(v.id("nodes")) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, folder, sort, clear }) => {
    const next = sort === null ? undefined : sort;
    if (folder === "") {
      await ctx.db.patch(workspaceId, { treeSort: next });
    } else {
      const row = await nodeAt(ctx.db, workspaceId, folder);
      if (row === null || row.goneAt !== undefined || row.kind !== "folder") throw new FileOpError("FILE_NOT_FOUND", "That folder is not there any more.");
      if (row.sort !== next) await ctx.db.patch(row._id, { sort: next });
    }
    for (const id of clear) {
      const row = await ctx.db.get(id);
      if (row === null || row.workspaceId !== workspaceId || row.goneAt !== undefined || row.sort === undefined) continue;
      await ctx.db.patch(id, { sort: undefined });
    }
    return null;
  },
});

/** Sort `folder` (`""`: the top level) by `sort`, or back to the order with no setting (null). Editor. */
export const set = action({
  args: {
    workspaceId: v.id("workspaces"),
    folder: v.string(),
    sort: sortValidator,
    /** Also clear the setting of every folder beneath, so they draw by this one ("Apply to folders inside"). */
    inside: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      const folder = requireFolderPath(args.folder);
      if (args.sort !== null && !isListingSort(args.sort)) throw new FileOpError("PATH_INVALID", "That is not a way to sort.");
      const actorUserId = await callerId(ctx);
      const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
        actorUserId,
        workspaceId: args.workspaceId,
        minimum: "editor",
      });
      const clearance = clearanceOf(scope, grantedNames ?? []);
      const held = await ctx.runQuery(internal.functions.nodesPrivacy.readerRules, { workspaceId: args.workspaceId });
      const rules = held.rules.map((rule) => ({ prefix: rule.prefix, vis: rule.vis as Visibility }));
      const overrides = new Map(held.overrides.map((note): [string, Visibility] => [note.path, note.vis as Visibility]));
      const visible = (path: string) => folderVisibleAtScope(path, clearance, rules, overrides);
      // A folder the caller cannot see answers as an absent one: never written to, never confirmed.
      if (folder !== "" && !visible(folder)) throw new FileOpError("FILE_NOT_FOUND", "That folder is not there any more.");
      const inside =
        args.inside === true
          ? await ctx.runQuery(internal.functions.folderSort.heldInside, { workspaceId: args.workspaceId, folder })
          : [];
      await ctx.runMutation(internal.functions.folderSort.write, {
        workspaceId: args.workspaceId,
        folder,
        sort: args.sort,
        // Only the folders beneath that the caller can see: a hidden one keeps its setting.
        clear: inside.filter((row) => visible(row.path)).map((row) => row.id),
      });
      return null;
    } catch (error) {
      throw toConvexError(error);
    }
  },
});
