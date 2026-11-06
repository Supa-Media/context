/**
 * After a change to what a person's texting record says (a phone linked or unlinked, a pause, their Tex style), push
 * the record to their person object again (`functions/textingObjects.ts`), so an unlink or a pause revokes the tokens
 * it opened at once. Convex also re-checks every session the object opens, so a push that is late is never unsafe.
 * Nothing for a person whose texting is not answered by their object.
 */

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { personalWorkspaceOf } from "./faces/people";

export async function refreshTexting(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const workspace = await personalWorkspaceOf(ctx, userId);
  if (workspace === null) return;
  const row = await ctx.db
    .query("workspaceObjectHomes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .unique();
  if (row?.texting !== "object") return;
  await ctx.scheduler.runAfter(0, internal.functions.textingObjects.push, { workspaceId: workspace._id });
}
