/**
 * The five starting folders for a workspace set up by text, laid out the
 * moment its managed bucket first answers.
 *
 * In the app, "Start fresh" waits for the bucket to verify and then asks for
 * the standard layout (`useOnboarding.layOutFreshBucket`). Somebody set up by
 * text has no screen waiting, so the verification itself does it, through
 * the same `applyStructureHandler` and every guard in it: owner only, a connected
 * binding, never over a bucket that holds a context or was laid out already.
 *
 * Only for a `layout` row `startTextedStorage` left, only on our own bucket
 * for that workspace, and only when the probe found it `empty`. The row goes
 * whatever happens, so this runs once. A refusal never fails the
 * verification it rides on: the console offers the layout again (`SetupPrompt`).
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { applyStructureHandler } from "../workspaces/structure";

export async function layOutTextedWorkspace(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  scaffoldReason: string | undefined,
): Promise<void> {
  const row = await ctx.db
    .query("textSetups")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .first();
  if (row === null || row.stage !== "layout" || row.userId === undefined) return;
  await ctx.db.delete(row._id);
  if (scaffoldReason !== "empty") return;
  try {
    await applyStructureHandler(ctx, row.userId, { workspaceId, template: "para" });
  } catch {
    // Every refusal there throws before it writes; the console offers it again.
    console.log(JSON.stringify({ event: "text_setup_layout_refused", workspaceId }));
  }
}
