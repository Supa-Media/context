/**
 * `<handle>.ctxlc.site`: a workspace's website on the sites domain.
 *
 * It serves what `context.lc/@handle` serves and nothing more, so it is
 * decided the same way: the handle's name claim names a workspace, and that
 * workspace's website is on. Which pages are then visible is the website
 * resolver's question, asked with the handle exactly as `/@handle` asks it, so
 * `privacy.md` narrows this address the instant it narrows that one. No plan
 * check: a website is not Premium, only its design is, and the resolver
 * already draws an unpaid site in the default look.
 *
 * No row in `customDomains` is involved, and none can be: `hostname.ts`
 * refuses every name on the sites domain.
 */

import type { QueryCtx } from "../../../_generated/server";
import { findName } from "../nameClaims";

export async function sitesDomainBinding(
  ctx: QueryCtx,
  handle: string,
): Promise<{ handle: string; homeSlug: null } | null> {
  const claim = await findName(ctx, handle);
  if (claim?.workspaceId === undefined) return null;
  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", claim.workspaceId!))
    .unique();
  if (state?.state !== "enabled") return null;
  return { handle, homeSlug: null };
}
