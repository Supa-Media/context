/**
 * The console's file tree, read live from Convex (phase 2 of
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * A query, so every open tab is subscribed: a change anybody makes (a
 * colleague, an agent, a captured email) redraws each tab that shows the
 * folder as soon as the tree records it, with no walk of the bucket.
 *
 * `null` means "not served": the workspace's tree is not `ready` yet
 * (`treeServesNow`), and the caller is refused `NOT_SERVED`. Nothing here
 * falls back to the bucket, and Pause stops copying work only (decided by the
 * owner).
 *
 * Who may read is decided first, by the same `resolveFileAccess` the bucket
 * listing uses, so a stranger is refused whether or not the tree serves; and
 * which names they see is `listFolder`'s own decision (`lib/nodes/listing.ts`).
 */

import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import { clearanceOf } from "./lib/clearance";
import { callerId, resolveFileAccess } from "./lib/filesFns/access";
import { listingValidator } from "./lib/filesFns/validators";
import { listFolderFromNodes, treeServesNow } from "./lib/nodes/listing";
import { nodeAt } from "./lib/nodes/paths";

/** One folder's contents at the caller's clearance, or `null` while the tree does not serve. */
export const listFolder = query({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.union(v.null(), listingValidator),
  handler: async (ctx, { workspaceId, path }) => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await resolveFileAccess(ctx, { actorUserId, workspaceId, minimum: "member" });
    if (!(await treeServesNow(ctx.db, workspaceId))) return null;
    const listing = await listFolderFromNodes(ctx, workspaceId, path, clearanceOf(scope, grantedNames));
    return { kind: "listing" as const, ...listing };
  },
});

/**
 * The same listing for the file-operation barrier's `list` (shared folder
 * links, share cards, routines and plugins), which has already decided who is
 * asking and at what clearance. `null` while the tree does not serve, and the
 * barrier answers `NOT_SERVED`.
 */
export const listServed = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    scope: v.union(v.literal("private"), v.literal("team")),
    grantedNames: v.optional(v.array(v.string())),
  },
  returns: v.union(v.null(), listingValidator),
  handler: async (ctx, { workspaceId, path, scope, grantedNames }) => {
    if (!(await treeServesNow(ctx.db, workspaceId))) return null;
    const listing = await listFolderFromNodes(ctx, workspaceId, path, clearanceOf(scope, grantedNames ?? []));
    return { kind: "listing" as const, ...listing };
  },
});

/** The most paths one `editedAt` call reads: more than a search page ever holds. */
const EDITED_AT_CAP = 100;

/**
 * When each of these notes was last written, for search's rows ("edited Sep
 * 12"), from the tree rows' `uploaded`. `null` where the tree has no live row.
 *
 * INTERNAL, and only ever asked for paths a search has already passed through
 * the caller's `canSee`: a time is a fact about a note somebody may see, and
 * this never decides who that is. Capped, because a page is a few dozen rows.
 */
export const editedAt = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.array(v.union(v.number(), v.null())),
  handler: async (ctx, { workspaceId, paths }) =>
    await Promise.all(
      paths.slice(0, EDITED_AT_CAP).map(async (path) => {
        const row = await nodeAt(ctx.db, workspaceId, path);
        return row === null || row.goneAt !== undefined || row.kind !== "file" ? null : (row.uploaded ?? null);
      }),
    ),
});
