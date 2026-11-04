/**
 * The order a folder's rows are drawn in, set by a person (owner, 2026-10-18; replaces
 * number prefixes: `docs/decisions/app-and-console/folder-jobs.md`).
 *
 * "Move up", "Move down" and dragging a row among its siblings send the rows
 * of one level in the order wanted; each gets `order` on its row, in steps of
 * ten (`compareListingEntries` draws folders by it, and `listingSort.cjs`
 * draws every row by it in a folder set to custom order, owner 2026-11-04:
 * `functions/folderSort.ts`). Notes are named beside folders since then. It
 * changes what everybody's list looks like, so it takes an editor, the role
 * renaming takes. A row the caller cannot see is not touched and not named:
 * it keeps the place it had.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { callerId } from "./lib/filesFns/access";
import { clearanceOf } from "./lib/clearance";
import { folderVisibleAtScope } from "./lib/fileOps/listing";
import { requireFolderPath } from "./lib/fileOps/paths";
import { toConvexError } from "./lib/filesFns/operationErrors";
import { FileOpError } from "./lib/fileOps/errors";
import { canSee, type Visibility } from "./lib/privacy";
import { nodeAt } from "./lib/nodes/paths";

/** Rows one call may order: past any real level, a bound on the writes. */
export const FOLDER_ORDER_MAX = 500;

/** The step between two neighbours' `order`, so a later insert has room. */
export const ORDER_STEP = 10;

/** Writes `order` on each named live row directly under `parent`; answers how many it wrote. INTERNAL. */
export const write = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    parent: v.string(),
    /** Every row to order, in order. */
    folders: v.array(v.string()),
    /** Of those, the paths the caller may see as a note, and as a folder; a row is written only as what it is. */
    notes: v.optional(v.array(v.string())),
    visibleFolders: v.optional(v.array(v.string())),
  },
  returns: v.number(),
  handler: async (ctx, { workspaceId, parent, folders, notes, visibleFolders }) => {
    const seeNote = new Set(notes ?? []);
    const seeFolder = new Set(visibleFolders ?? folders);
    let parentId: Id<"nodes"> | undefined;
    if (parent !== "") {
      const row = await nodeAt(ctx.db, workspaceId, parent);
      if (row === null || row.goneAt !== undefined || row.kind !== "folder") return 0;
      parentId = row._id;
    }
    let written = 0;
    for (const [index, path] of folders.entries()) {
      const row = await nodeAt(ctx.db, workspaceId, path);
      if (row === null || row.goneAt !== undefined || row.parentId !== parentId) continue;
      if (!(row.kind === "folder" ? seeFolder.has(path) : seeNote.has(path))) continue;
      const order = index * ORDER_STEP;
      if (row.order !== order) await ctx.db.patch(row._id, { order });
      written += 1;
    }
    return written;
  },
});

/** Draw the rows (folders and notes) under `parent` in the order given. Editor. Rows not named keep their place. */
export const set = action({
  args: {
    workspaceId: v.id("workspaces"),
    parent: v.string(),
    /** The rows of `parent` in the order wanted, folders and notes alike; named `folders` from before notes were. */
    folders: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      const parent = requireFolderPath(args.parent);
      const prefix = parent === "" ? "" : `${parent}/`;
      if (args.folders.length > FOLDER_ORDER_MAX) throw new FileOpError("PATH_INVALID", "That is too many rows to order at once.");
      const folders = args.folders.map((path) => requireFolderPath(path));
      if (
        new Set(folders).size !== folders.length ||
        folders.some((path) => !path.startsWith(prefix) || path.slice(prefix.length).includes("/") || path === parent)
      ) {
        throw new FileOpError("PATH_INVALID", "Each row must sit directly in the folder being ordered, once.");
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
      // Only what the caller can see is ordered; a hidden row is never written to or confirmed. Each path is judged
      // both ways, and the write keeps it only as the kind of row it turns out to be.
      const asFolder = folders.filter((path) => folderVisibleAtScope(path, clearance, rules, overrides));
      const asNote = folders.filter((path) => canSee(path, clearance.scope, rules, overrides, clearance.names));
      await ctx.runMutation(internal.functions.folderOrder.write, {
        workspaceId: args.workspaceId,
        parent,
        folders: folders.filter((path) => asFolder.includes(path) || asNote.includes(path)),
        notes: asNote,
        visibleFolders: asFolder,
      });
      return null;
    } catch (error) {
      throw toConvexError(error);
    }
  },
});
