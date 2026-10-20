/**
 * Winding billing down: Context is free (decided by the owner, 2026-10-20).
 *
 * The owner asked for every existing subscription to be cancelled while the
 * people on them keep using Context as before. Nothing here touches a note, a
 * bucket or a plan's choices; it only names the subscriptions Stripe could
 * still charge, for `billingStripe.ts` to count and cancel. Run by hand, from
 * `.github/workflows/billing-wind-down.yml`, which prints counts and never an
 * id: this repository and its logs are public.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

/** Every subscription a plan row still holds that Stripe has not ended. */
export const liveSubscriptionIds = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const ids: string[] = [];
    for await (const plan of ctx.db.query("workspacePlans")) {
      if (plan.stripeSubscriptionId === undefined) continue;
      const stripeStatus = plan.stripeStatus ?? plan.status;
      if (stripeStatus === "canceled" || stripeStatus === "none") continue;
      ids.push(plan.stripeSubscriptionId);
    }
    return ids;
  },
});
