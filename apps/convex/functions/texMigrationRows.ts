/**
 * The tree's side of moving Tex's existing notes into their person's Durable
 * Object (decided by the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/tex-durable-objects.md`; the steps are in
 * `lib/texMigration/run.ts`, run by `functions/texMigration.ts`).
 *
 * Kept apart from the action that opens the bucket: the analyzer treats every
 * export of a module that imports a decrypting helper as decrypting, and these
 * read and write only the tree, never a credential.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { texKeyFor } from "../../mcp/src/store/texRouting.js";
import { nodePaths } from "./lib/nodes/paths";
import { idKeyFor } from "./lib/nodes/noteIds";
import { texFolderPath } from "./lib/noteIds/texHome";

/** Tree rows read per page of one workspace's Tex folder. */
const ROWS_PER_PAGE = 100;

const rowValidator = v.object({
  id: v.id("nodes"),
  path: v.string(),
  noteId: v.optional(v.string()),
  storageKey: v.string(),
  etag: v.optional(v.string()),
});

/**
 * The keyed live file rows of one personal workspace's Tex folder, after
 * `after`, one page at a time. `tex` is false for a shared workspace or one
 * with no Tex folder, and then there are no rows.
 */
export const rowsPage = internalQuery({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()) },
  returns: v.object({ tex: v.boolean(), rows: v.array(rowValidator), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { workspaceId, after }) => {
    const workspace = await ctx.db.get(workspaceId);
    if (workspace === null || workspace.kind !== "personal") return { tex: false, rows: [], next: null };
    const folder = await texFolderPath(ctx.db, workspaceId);
    if (folder === null) return { tex: false, rows: [], next: null };
    const paths = await nodePaths(ctx.db, workspaceId);
    const rows: Array<{ id: Id<"nodes">; path: string; noteId?: string; storageKey: string; etag?: string }> = [];
    let scanned = 0;
    for await (const row of paths.rows(folder, after)) {
      scanned += 1;
      if (row.kind === "file" && row.goneAt === undefined && row.storageKey !== undefined) {
        rows.push({
          id: row._id,
          path: row.path,
          ...(row.noteId === undefined ? {} : { noteId: row.noteId }),
          storageKey: row.storageKey,
          ...(row.etag === undefined ? {} : { etag: row.etag }),
        });
      }
      if (scanned >= ROWS_PER_PAGE) return { tex: true, rows, next: row.path };
    }
    return { tex: true, rows, next: null };
  },
});

/**
 * Switches one row's key from its bucket id key to the Tex form, when the row
 * still names that bucket key and is still at the version the copy was read
 * from. The row keeps its id, path and name; only its key and its version
 * change, and the body is the same bytes, so no change is logged. The bucket
 * copy is deleted by the caller, after this has landed.
 */
export const switchKey = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    id: v.id("nodes"),
    from: v.string(),
    to: v.string(),
    etag: v.string(),
    toEtag: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, id, from, to, etag, toEtag }) => {
    const workspace = await ctx.db.get(workspaceId);
    if (workspace === null || workspace.kind !== "personal") return false;
    const row = await ctx.db.get(id);
    if (row === null || row.workspaceId !== workspaceId || row.kind !== "file" || row.goneAt !== undefined) return false;
    if (row.storageKey !== from || row.etag !== etag || row.noteId === undefined) return false;
    if (from !== idKeyFor(row.noteId, row.path) || to !== texKeyFor(`person:${workspaceId}`, from)) return false;
    await ctx.db.patch(row._id, {
      storageKey: to,
      etag: toEtag,
      idCopy: undefined,
      ...(row.parsed === etag ? { parsed: toEtag } : {}),
    });
    return true;
  },
});
