/**
 * Jev smarts: the gate and the meter every Jev-using feature goes through.
 *
 * Internal only. Features reach these through `withJev` (`lib/jev/client.ts`);
 * staff read usage and flip switches through `functions/admin.ts`
 * (`jevUsageReport`, `setJevSwitch`). How to add a feature: `lib/jev/README.md`.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { JEV_FEATURES, type JevFeatureName } from "./lib/jev/features";
import { addUsage, gate as gateFor } from "./lib/jev/meter";

const featureValidator = v.union(
  ...(Object.keys(JEV_FEATURES) as JevFeatureName[]).map((name) => v.literal(name)),
) as unknown as ReturnType<typeof v.literal<JevFeatureName>>;

export const gate = internalQuery({
  args: { feature: featureValidator, workspaceId: v.id("workspaces") },
  returns: v.union(
    v.object({ allowed: v.literal(true), remaining: v.number() }),
    v.object({
      allowed: v.literal(false),
      reason: v.union(v.literal("disabled"), v.literal("switched_off"), v.literal("not_premium"), v.literal("daily_cap")),
    }),
  ),
  handler: async (ctx, args) => await gateFor(ctx, args.feature, args.workspaceId, Date.now()),
});

export const recordUsage = internalMutation({
  args: {
    feature: featureValidator,
    workspaceId: v.id("workspaces"),
    calls: v.number(),
    failed: v.number(),
    refused: v.number(),
    questions: v.number(),
    tokens: v.number(),
    ms: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { feature, workspaceId, ...delta }) => {
    await addUsage(ctx, feature, workspaceId, delta, Date.now());
    return null;
  },
});
