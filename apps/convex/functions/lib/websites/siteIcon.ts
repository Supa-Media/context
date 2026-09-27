/**
 * A website's favicon: the workspace's own icon, once the owner turned the
 * site on. See `docs/decisions/websites.md`, "The workspace icon is the
 * site's favicon".
 *
 * Split in two for the reason the resolver is: the plan is a query, so every
 * refusal is decided from the database before a bucket credential opens, and
 * only a photo on an enabled site reaches the action's bucket read.
 */

import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../../../_generated/server";
import { internal } from "../../../_generated/api";
import { findName } from "../nameClaims";
import type { OperationResult } from "../filesFns/operationTypes";
import { PUBLICATION_CLEARANCE } from "./publication";
import { normalizedHandle } from "./resolver";

export type SiteIconPlan =
  | null
  | { kind: "emoji"; emoji: string }
  | { kind: "photo"; workspaceId: Id<"workspaces">; leaf: string };

export type SiteIcon =
  | null
  | { kind: "emoji"; emoji: string }
  | { kind: "photo"; bytes: ArrayBuffer; contentType: string };

/**
 * `null` for every absence — a malformed handle, an unclaimed one, a site that
 * is off, a workspace with no icon — so a visitor cannot use this to learn that
 * a workspace exists, or what it looks like, before its owner published it.
 * The gate is the resolver's own: a website state of `enabled`.
 */
export async function siteIconPlanHandler(
  ctx: QueryCtx,
  args: { handle: string },
): Promise<SiteIconPlan> {
  const handle = normalizedHandle(args.handle);
  if (handle === null) return null;
  const claim = await findName(ctx, handle);
  if (claim?.workspaceId === undefined) return null;
  const workspace = await ctx.db.get(claim.workspaceId);
  if (workspace === null) return null;
  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .unique();
  if (state?.state !== "enabled") return null;
  const icon = workspace.icon;
  if (icon === undefined) return null;
  if (icon.kind === "emoji") return { kind: "emoji", emoji: icon.emoji };
  return { kind: "photo", workspaceId: workspace._id, leaf: icon.leaf };
}

/**
 * **This reads a customer's bucket for an anonymous caller**, and what bounds
 * it is the same shape `files.workspaceIconPhoto` relies on: the caller names
 * a handle, never an object. The leaf comes off the workspace row, where only
 * the owner's `setWorkspaceIconPhoto` puts it (derived from the bytes), and
 * `readImage` applies the gateway's own leaf rule to it again. So the set of
 * objects this can return is at most one per workspace, chosen by its owner.
 *
 * Read at the publication clearance, like every other byte a website serves,
 * rather than at an owner's: nothing about a visitor's request borrows a
 * member's standing.
 */
export async function siteIconHandler(
  ctx: ActionCtx,
  args: { handle: string },
): Promise<SiteIcon> {
  const plan = await ctx.runQuery(internal.functions.websites.siteIconPlan, {
    handle: args.handle,
  });
  if (plan === null || plan.kind === "emoji") return plan;
  try {
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: plan.workspaceId,
      ...PUBLICATION_CLEARANCE,
      operation: { kind: "readImage", leaf: plan.leaf },
    })) as OperationResult;
    if (result.kind !== "image") return null;
    /*
      From the extension, for the reason `workspaceIconPhoto` gives: an adapter
      is not obliged to hand a type back. The leaf came off our own row and
      through `readImage`'s gate, so the extension is one of the icon types.
    */
    const extension = plan.leaf.slice(plan.leaf.lastIndexOf(".") + 1).toLowerCase();
    return {
      kind: "photo",
      bytes: result.bytes,
      contentType: extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`,
    };
  } catch {
    // A deleted object, a revoked key, a store that is down: the site draws
    // the Context favicon, the same answer as a workspace with no icon.
    return null;
  }
}
