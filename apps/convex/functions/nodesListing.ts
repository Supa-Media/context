/**
 * The console's file tree, read live from Convex (phase 2 of
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * A query, so every open tab is subscribed: a change anybody makes (a
 * colleague, an agent, a captured email) redraws each tab that shows the
 * folder as soon as the tree records it, with no walk of the bucket.
 *
 * `null` means "ask the bucket": the tree is not one a parity check has
 * proved, or staff paused the migration (`treeServes`). The console then
 * calls `files.listFiles` exactly as before, so nothing depends on this being
 * on, and Pause in admin › Search › Indexes switches every reader back.
 *
 * Who may read is decided first, by the same `resolveFileAccess` the bucket
 * listing uses, so a stranger is refused whether or not the tree serves; and
 * which names they see is `listFolder`'s own decision (`lib/nodes/listing.ts`).
 */

import { v } from "convex/values";
import { query } from "../_generated/server";
import { clearanceOf } from "./lib/clearance";
import { callerId, resolveFileAccess } from "./lib/filesFns/access";
import { listingValidator } from "./lib/filesFns/validators";
import { listFolderFromNodes, treeServesNow } from "./lib/nodes/listing";

/** One folder's contents at the caller's clearance, or `null` when the bucket must answer. */
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
