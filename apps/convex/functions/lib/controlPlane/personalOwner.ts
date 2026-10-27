/**
 * Who may read a person's own Google data live, their mail or their calendar
 * (`functions/personMail.ts`, `functions/personCalendar.ts`).
 *
 * THE OWNER OF THE PERSONAL WORKSPACE, WITH PRIVATE CLEARANCE, AND NOBODY ELSE.
 *
 * A Google account is connected to its person's personal workspace, and what
 * it holds is as private as anything in it. So the call must address that
 * workspace, the grant must hold `context:private`, and the grant's person
 * must own it: an editor or member of somebody's personal workspace never
 * reaches their mail or calendar, and `expectedWorkspaceId` only selects
 * within the grant's own set.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { TOKEN_HASH_PATTERN } from "../crypto";
import { contextsForGrant, resolveLiveGrant } from "./liveGrants";

export type PersonalOwner = { workspace: Doc<"workspaces">; userId: Id<"users"> };

export async function personalOwnerReadClearance(
  ctx: QueryCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string },
): Promise<PersonalOwner | null> {
  if (!TOKEN_HASH_PATTERN.test(args.hashedAccessToken)) return null;
  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  if (live === null) return null;
  const covered = (await contextsForGrant(ctx, live)).find((entry) => entry.workspaceId === args.expectedWorkspaceId);
  if (covered === undefined || covered.role !== "owner" || covered.kind !== "personal") return null;
  if (!live.grant.scopes.includes("context:private")) return null;
  const workspace = await ctx.db.get(covered.workspaceId as Id<"workspaces">);
  if (workspace === null || workspace.kind !== "personal" || workspace.createdBy !== live.grant.userId) return null;
  return { workspace, userId: live.grant.userId };
}
