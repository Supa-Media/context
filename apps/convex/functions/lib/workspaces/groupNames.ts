/**
 * The group names one person is named in, in one workspace — and dropping
 * them when that person rejoins.
 *
 * `workspaceGroupMembers` rows are deliberately **kept** when somebody is
 * removed from a workspace: `resolveGroupMembers` intersects them with live
 * membership, so a left-behind row reaches nothing while they are out, and the
 * owner's list still shows who the group named. `functions/groups.ts` states
 * it ("a membership row grants nothing by itself") and `groups.test.ts`
 * asserts it ("the row survives — the group still NAMES them").
 *
 * That property holds only while they are out. The intersection turns every
 * left-behind row live again the instant a membership row exists, so an
 * invitation accepted by somebody who was in `@supa-leads` before restores
 * every folder `privacy.md` points at that name — at whatever role the new
 * invitation carried, read-only `member` included, with no act by the owner
 * and nothing on a screen they would look at, because the group list is
 * owner-only and they have just sent an invitation, not opened it.
 *
 * `team` means named people the owner granted access to, so rejoining starts
 * from no names. Naming them again is a deliberate act with an audited
 * invitation behind it and a row of its own.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";

/**
 * How many of a workspace's groups this will walk.
 *
 * Mirrors `MAX_GROUPS_PER_WORKSPACE` in `functions/groups.ts` rather than
 * importing it, the way `lib/grantedNames.ts` mirrors it as
 * `MAX_NAMES_SCANNED`: a lib module does not import from a module that
 * registers Convex functions. A workspace cannot hold more groups than that
 * ceiling, so this is the whole set.
 */
const MAX_GROUPS_WALKED = 100;

/**
 * Drop every group of `workspaceId` that names `userId`.
 *
 * Walks the **workspace's** groups rather than the person's rows, though the
 * person has a `by_user` index and the workspace's groups cost one read each.
 * `by_user` spans every workspace they are in and would have to be windowed
 * the way `grantedNamesFor` windows it — and a window that deletes from its
 * own page lets the row behind it slide into view, so a `take` there can leave
 * exactly the row this exists to remove. The workspace's groups are capped by
 * `MAX_GROUPS_PER_WORKSPACE`, mirrored below, which makes this the whole set
 * and not a page.
 */
export async function clearGroupNames(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<void> {
  const groups = await ctx.db
    .query("workspaceGroups")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(MAX_GROUPS_WALKED);
  for (const group of groups) {
    const row = await ctx.db
      .query("workspaceGroupMembers")
      .withIndex("by_group_user", (q) => q.eq("groupId", group._id).eq("userId", userId))
      .unique();
    if (row !== null) await ctx.db.delete(row._id);
  }
}
