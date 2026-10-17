import { internal } from "../../../_generated/api";
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

/**
 * Turn a context's plan on without Stripe: what the upgrade buys
 * (`storeSelectionAtUpgrade`), `active`, and the
 * managed bucket where one is chosen and not yet bound. Shared by the staging
 * and CUJ test upgrade and by founding Premium (`founding.ts`), so the two
 * cannot drift apart. `null` where the plan was already active. Callers
 * decide who may, and audit it.
 */
export async function activateWithoutStripe(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  extra: { founding?: true } = {},
): Promise<{ selected: Entitlements } | null> {
  if ((await planFor(ctx, workspaceId))?.status === "active") return null;
  const { plan, selected } = await storeSelectionAtUpgrade(ctx, workspaceId);
  await ctx.db.patch(plan._id, { status: "active", ...extra, updatedAt: Date.now() });
  if (selected.managedStorage) {
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (!bindingIsManaged(binding, workspaceId)) {
      await ctx.db.patch(plan._id, { managedProvisioning: "running" });
      await ctx.scheduler.runAfter(
        0,
        internal.functions.managedProvisioning.provisionManagedStorage,
        { workspaceId },
      );
    }
  }
  return { selected };
}
