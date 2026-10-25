/**
 * The order folders are drawn in, set by a person (owner, 2026-10-18; replaces
 * number prefixes: `docs/decisions/app-and-console/folder-jobs.md`).
 *
 * "Move up", "Move down" and dragging a folder among its siblings send the
 * folders of one level in the order wanted; each gets `order` on its row, in
 * steps of ten (`compareListingEntries` draws by it). It changes what
 * everybody's folder list looks like, so it takes an editor, the role
 * renaming takes. A folder the caller cannot see is not touched and not
 * named: it keeps the place it had.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalMutation } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import { clearanceOf } from "./lib/clearance";
import { folderVisibleAtScope } from "./lib/fileOps/listing";
import { requireFolderPath } from "./lib/fileOps/paths";
import { toConvexError } from "./lib/filesFns/operationErrors";
import { FileOpError } from "./lib/fileOps/errors";
import type { Visibility } from "./lib/privacy";
import { nodeAt } from "./lib/nodes/paths";

/** Folders one call may order: past any real level, a bound on the writes. */
export const FOLDER_ORDER_MAX = 200;

/** The step between two neighbours' `order`, so a later insert has room. */
export const ORDER_STEP = 10;

/** Writes `order` on each named live folder directly under `parent`; answers how many it wrote. INTERNAL. */
export const write = internalMutation({
  args: { workspaceId: v.id("workspaces"), parent: v.string(), folders: v.array(v.string()) },
  returns: v.number(),
  handler: async (ctx, { workspaceId, parent, folders }) => {
    let parentId: Id<"nodes"> | undefined;
    if (parent !== "") {
      const row = await nodeAt(ctx.db, workspaceId, parent);
      if (row === null || row.goneAt !== undefined || row.kind !== "folder") return 0;
      parentId = row._id;
    }
    let written = 0;
    for (const [index, path] of folders.entries()) {
      const row = await nodeAt(ctx.db, workspaceId, path);
      if (row === null || row.goneAt !== undefined || row.kind !== "folder" || row.parentId !== parentId) continue;
      const order = index * ORDER_STEP;
      if (row.order !== order) await ctx.db.patch(row._id, { order });
      written += 1;
    }
    return written;
  },
});

/** Draw the folders under `parent` in the order given. Editor. Folders not named keep their place. */
export const set = action({
  args: { workspaceId: v.id("workspaces"), parent: v.string(), folders: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      const parent = requireFolderPath(args.parent);
      const prefix = parent === "" ? "" : `${parent}/`;
      if (args.folders.length > FOLDER_ORDER_MAX) throw new FileOpError("PATH_INVALID", "That is too many folders to order at once.");
      const folders = args.folders.map((path) => requireFolderPath(path));
      if (
        new Set(folders).size !== folders.length ||
        folders.some((path) => !path.startsWith(prefix) || path.slice(prefix.length).includes("/") || path === parent)
      ) {
        throw new FileOpError("PATH_INVALID", "Each folder must sit directly in the folder being ordered, once.");
      }
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
      // Only what the caller can see is ordered; a hidden folder is never written to or confirmed.
      const visible = folders.filter((path) => folderVisibleAtScope(path, clearance, rules, overrides));
      await ctx.runMutation(internal.functions.folderOrder.write, { workspaceId: args.workspaceId, parent, folders: visible });
      return null;
    } catch (error) {
      throw toConvexError(error);
    }
  },
});
