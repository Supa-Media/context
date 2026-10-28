import { getAuthUserId as userIdFromToken } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { liveSessionOf } from "./lib/emailProof";

/**
 * Whether the caller's session is still live, for an action that has no
 * database of its own (`lib/signedIn.ts`). It runs under the action's
 * identity, so it answers for the same token.
 */
export const isLive = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const userId = await userIdFromToken(ctx);
    if (userId === null) return false;
    return (await liveSessionOf(ctx, userId)) !== null;
  },
});
