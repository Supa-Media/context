import { v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import { catchUpFoundingPremium } from "./lib/billing/founding";

/**
 * Grant founding Premium to the accounts still owed it, oldest first
 * (`lib/billing/founding.ts`). Every new account schedules this; an operator
 * may run it too, to reach the accounts that existed before it shipped
 * without waiting for the next sign-up. Idempotent.
 */
export const catchUp = internalMutation({
  args: {},
  returns: v.object({ granted: v.number() }),
  handler: async (ctx) => ({ granted: await catchUpFoundingPremium(ctx) }),
});
