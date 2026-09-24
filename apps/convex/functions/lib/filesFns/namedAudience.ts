/**
 * Whether a name a rule would point at is a group or a member of this context.
 *
 * The handler body of `namedAudience`, which `functions/files.ts` registers;
 * moved verbatim. `resolveNamedAudience` there is the only caller.
 */

import type { QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { resolveAddressedUser } from "../identities";

export async function namedAudienceHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces">; name: string },
) {
  const group = await ctx.db
    .query("workspaceGroups")
    .withIndex("by_name", (q) => q.eq("name", args.name))
    .unique();
  if (group !== null) {
    return group.workspaceId === args.workspaceId ? group.name : null;
  }

  // Not a group, so it may be a person. `resolveAddressedUser` is the only
  // thing that decides who a handle belongs to — a `names` claim of
  // `kind: "user"`, or the sole owner of a PERSONAL workspace with that slug
  // — and every ambiguity there is already `null`.
  const userId = await resolveAddressedUser(ctx, { kind: "name", value: args.name });
  if (userId === null) return null;

  // A rule naming somebody who is not a member reaches nobody, because
  // `grantedNamesFor` intersects with membership. Refused rather than
  // written, for the reason `addGroupMember` refuses a stranger: it would sit
  // in the owner's manifest looking like access somebody had been given.
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", args.workspaceId).eq("userId", userId),
    )
    .unique();
  return membership === null ? null : args.name;
}
