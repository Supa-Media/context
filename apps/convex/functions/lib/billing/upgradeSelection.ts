import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { selectionAtUpgrade, type Entitlements } from "../premium";
import { bindingIsManaged, planFor, selectionOf, statusOf } from "./plan";

/**
 * Fill in and store what an upgrade buys, before a checkout (or the test
 * upgrade) freezes it. `selectionAtUpgrade` decides; this reads the binding it
 * needs and writes the plan row, creating it for a context that never had one.
 */
export async function storeSelectionAtUpgrade(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<{ plan: Doc<"workspacePlans">; selected: Entitlements }> {
  const plan = await planFor(ctx, workspaceId);
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  const selected = selectionAtUpgrade(
    selectionOf(plan),
    statusOf(plan),
    bindingIsManaged(binding, workspaceId),
  );
  const now = Date.now();
  if (plan === null) {
    const id = await ctx.db.insert("workspacePlans", {
      workspaceId,
      ...selected,
      status: "none",
      createdAt: now,
      updatedAt: now,
    });
    return { plan: (await ctx.db.get(id))!, selected };
  }
  const current = selectionOf(plan);
  if (
    current.managedStorage !== selected.managedStorage ||
    current.fastSearch !== selected.fastSearch
  ) {
    await ctx.db.patch(plan._id, { ...selected, updatedAt: now });
  }
  return { plan: { ...plan, ...selected }, selected };
}
