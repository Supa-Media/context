/**
 * The tree's side of moving Tex's existing notes into their Durable Object:
 * a person's Tex folder into the person's, and each group chat's home in the
 * pinned workspace into that chat's (decided by the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/tex-durable-objects.md`; the steps are in
 * `lib/texMigration/run.ts`, run by `functions/texMigration.ts`).
 *
 * Kept apart from the action that opens the bucket: the analyzer treats every
 * export of a module that imports a decrypting helper as decrypting, and these
 * read and write only the tree, never a credential.
 */

import { v } from "convex/values";
import { CHAT_HOMES_FOLDER } from "@context/shared";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { texKeyFor } from "../../mcp/src/store/texRouting.js";
import { nodePaths } from "./lib/nodes/paths";
import { idKeyFor } from "./lib/nodes/noteIds";
import { chatKeyOfHome, texFolderPath } from "./lib/noteIds/texHome";
import { pinnedContextWorkspace } from "./lib/pinnedContext";

/** Tree rows read per page of one workspace's Tex folder. */
const ROWS_PER_PAGE = 100;

const rowValidator = v.object({
  id: v.id("nodes"),
  path: v.string(),
  noteId: v.optional(v.string()),
  storageKey: v.string(),
  etag: v.optional(v.string()),
  /** The object the row's note belongs in (`person:<workspaceId>` or `chat:<groupKey>`); absent when it belongs in none. */
  owner: v.optional(v.string()),
});

/**
 * Where a workspace's Tex rows are, and whose object each belongs in: a
 * personal workspace's Tex folder, all the person's; the pinned workspace's
 * chat homes, each its chat's (`lib/noteIds/texHome.ts`). Any other
 * workspace has none.
 */
async function texScope(
  ctx: QueryCtx,
  workspace: Doc<"workspaces"> | null,
): Promise<{ folder: string; ownerOf: (path: string) => Promise<string | null> } | null> {
  if (workspace === null) return null;
  if (workspace.kind === "personal") {
    const folder = await texFolderPath(ctx.db, workspace._id);
    if (folder === null) return null;
    const owner = `person:${workspace._id}`;
    return { folder, ownerOf: async () => owner };
  }
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null || pinned._id !== workspace._id) return null;
  const chats = new Map<string, string | null>();
  return {
    folder: CHAT_HOMES_FOLDER,
    ownerOf: async (path) => {
      const home = path.slice(CHAT_HOMES_FOLDER.length + 1).split("/")[0] ?? "";
      if (!chats.has(home)) chats.set(home, await chatKeyOfHome(ctx.db, path));
      const chat = chats.get(home) ?? null;
      return chat === null ? null : `chat:${chat}`;
    },
  };
}

/**
 * The keyed live file rows of one workspace's Tex rows (`texScope`), after
 * `after`, one page at a time, each with the object it belongs in. `tex` is
 * false for a workspace with none, and then there are no rows.
 */
export const rowsPage = internalQuery({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()) },
  returns: v.object({ tex: v.boolean(), rows: v.array(rowValidator), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { workspaceId, after }) => {
    const scope = await texScope(ctx, await ctx.db.get(workspaceId));
    if (scope === null) return { tex: false, rows: [], next: null };
    const paths = await nodePaths(ctx.db, workspaceId);
    const rows: Array<{ id: Id<"nodes">; path: string; noteId?: string; storageKey: string; etag?: string; owner?: string }> = [];
    let scanned = 0;
    for await (const row of paths.rows(scope.folder, after)) {
      scanned += 1;
      if (row.kind === "file" && row.goneAt === undefined && row.storageKey !== undefined) {
        const owner = await scope.ownerOf(row.path);
        rows.push({
          id: row._id,
          path: row.path,
          ...(row.noteId === undefined ? {} : { noteId: row.noteId }),
          storageKey: row.storageKey,
          ...(row.etag === undefined ? {} : { etag: row.etag }),
          ...(owner === null ? {} : { owner }),
        });
      }
      if (scanned >= ROWS_PER_PAGE) return { tex: true, rows, next: row.path };
    }
    return { tex: true, rows, next: null };
  },
});

/** The workspace a handle names, for a run on its notes alone: a personal one, or the pinned one (its chat homes); `null` otherwise. */
export const migrationWorkspaceBySlug = internalQuery({
  args: { slug: v.string() },
  returns: v.union(v.id("workspaces"), v.null()),
  handler: async (ctx, { slug }) => {
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (workspace === null) return null;
    if (workspace.kind === "personal") return workspace._id;
    const pinned = await pinnedContextWorkspace(ctx);
    return pinned !== null && pinned._id === workspace._id ? workspace._id : null;
  },
});

/**
 * Switches one row's key from its bucket id key to the Tex form of the object
 * the tree says it belongs in (`texScope`), when the row
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
    const scope = await texScope(ctx, await ctx.db.get(workspaceId));
    if (scope === null) return false;
    const row = await ctx.db.get(id);
    if (row === null || row.workspaceId !== workspaceId || row.kind !== "file" || row.goneAt !== undefined) return false;
    if (row.storageKey !== from || row.etag !== etag || row.noteId === undefined) return false;
    if (row.path !== scope.folder && !row.path.startsWith(`${scope.folder}/`)) return false;
    // The owner is the tree's answer for this row now, never the caller's.
    const owner = await scope.ownerOf(row.path);
    if (owner === null || from !== idKeyFor(row.noteId, row.path) || to !== texKeyFor(owner, from)) return false;
    await ctx.db.patch(row._id, {
      storageKey: to,
      etag: toEtag,
      idCopy: undefined,
      ...(row.parsed === etag ? { parsed: toEtag } : {}),
    });
    return true;
  },
});
