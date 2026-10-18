/** Whether a person is asked for Google's write scopes (`lib/googleWriteTesters.ts`). */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { isGoogleWriteTester } from "./lib/googleWriteTesters";

export const isWriteTester = internalQuery({
  args: { userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, args) => isGoogleWriteTester(await ctx.db.get(args.userId)),
});
