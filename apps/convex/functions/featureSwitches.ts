/**
 * The admin console's Features tab: built features staff open to everyone,
 * or close again, without a deploy. The list is `lib/featureSwitches.ts`; the
 * gateway reads the states on `/gateway/binding` (`features`), so a switch
 * takes effect on the next request.
 */

import { ConvexError, v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import { mutation } from "./lib/rowWatch/mutations";
import { requireAdmin } from "./lib/admin";
import { recordAdminAudit } from "./lib/adminFns/audit";
import { toConvexError } from "./lib/adminFns/errors";
import { FEATURES, featureStates, isFeatureKey } from "./lib/featureSwitches";

const featureValidator = v.object({
  key: v.string(),
  label: v.string(),
  description: v.string(),
  on: v.boolean(),
  updatedAt: v.union(v.number(), v.null()),
});

/** Every switch, in the list's order. Staff only. */
export const listFeatureSwitches = query({
  args: {},
  returns: v.array(featureValidator),
  handler: async (ctx) => {
    await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    const rows = await ctx.db.query("featureSwitches").collect();
    return FEATURES.map((feature) => {
      const row = rows.find((r) => r.key === feature.key);
      return {
        key: feature.key,
        label: feature.label,
        description: feature.description,
        on: row?.on ?? false,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  },
});

/** Turn one feature on or off for everyone. Staff only, audited. */
export const setFeatureSwitch = mutation({
  args: { key: v.string(), on: v.boolean() },
  returns: v.object({ key: v.string(), on: v.boolean() }),
  handler: async (ctx, args) => {
    let actor;
    try {
      actor = await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }
    if (!isFeatureKey(args.key)) throw new ConvexError({ code: "INVALID_ARGUMENT", message: "There is no such feature." });
    const row = await ctx.db
      .query("featureSwitches")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    const fields = { on: args.on, updatedAt: Date.now(), updatedBy: actor.userId };
    if (row === null) await ctx.db.insert("featureSwitches", { key: args.key, ...fields });
    else await ctx.db.patch(row._id, fields);
    await recordAdminAudit(ctx, actor, "feature.switched", args.key, { on: args.on });
    return { key: args.key, on: args.on };
  },
});

/** The states as `/gateway/binding` carries them. INTERNAL. */
export const gatewayFeatures = internalQuery({
  args: {},
  returns: v.object({ vaultKeyUse: v.boolean() }),
  handler: async (ctx) => await featureStates(ctx),
});
