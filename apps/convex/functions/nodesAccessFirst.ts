/**
 * The share dialog's list write, told to the workspace's object first (`lib/rowWatch/objectFirst.ts`).
 *
 * `nodesAccess.setGrantees` is a mutation, and a mutation cannot call an object, so a list the app shortened was
 * served from the object's older rows until its push landed. This action opens a mark in the object, then runs the
 * same write as the caller (the signed-in person travels with `runMutation`), then answers once the object has it.
 * The mutation stays for app builds that still call it; its narrowings are logged as unmarked.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalMutation, internalQuery } from "./lib/rowWatch/mutations";
import { granteeRequestValidator, setGranteesAnswerValidator, setGranteesHandler, type SetGranteesAnswer } from "./lib/nodes/setGrantees";
import { objectFirst } from "./lib/rowWatch/objectFirst";
import { getAuthUserId } from "./lib/signedIn";
import { requireWorkspaceRole } from "./lib/workspaceAuth";

const setGranteesArgs = {
  workspaceId: v.id("workspaces"),
  path: v.string(),
  grantees: v.array(granteeRequestValidator),
  base: v.optional(v.union(v.literal("private"), v.literal("team"), v.literal("inherit"))),
  expectedVersion: v.optional(v.number()),
};

/** Whether the signed-in caller owns the workspace: only an owner's write may open a mark in its object. */
export const callerOwns = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return false;
    try {
      await requireWorkspaceRole(ctx, workspaceId, userId, "owner");
      return true;
    } catch {
      return false;
    }
  },
});

/** `nodesAccess.setGrantees`, run for the signed-in caller this action carries. */
export const setGranteesAsCaller = internalMutation({
  args: setGranteesArgs,
  returns: setGranteesAnswerValidator,
  handler: async (ctx, args) => await setGranteesHandler(ctx, args),
});

/**
 * The owner's list on one row (`nodesAccess.setGrantees`), answered only once the workspace's object has it. A
 * caller who does not own the workspace opens nothing there, and gets the mutation's own refusal.
 */
export const setGrantees = action({
  args: setGranteesArgs,
  returns: setGranteesAnswerValidator,
  handler: async (ctx, args): Promise<SetGranteesAnswer> => {
    const write = () => ctx.runMutation(internal.functions.nodesAccessFirst.setGranteesAsCaller, args);
    if (!(await ctx.runQuery(internal.functions.nodesAccessFirst.callerOwns, { workspaceId: args.workspaceId }))) return await write();
    return await objectFirst(ctx, args.workspaceId, write);
  },
});
