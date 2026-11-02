/**
 * What each access table should hold, read from Convex, for the copy and the
 * parity check (`accessObjects.ts`; rows built in `lib/accessObjects/expected.ts`
 * to the contract's shapes). Queries only, internal; never a credential.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { connectionsOf, invitesOf, membersPage, reachOf, sharedToMeOf } from "./lib/accessObjects/expected";

const rowsValidator = v.object({ rows: v.array(v.any()), skipped: v.number() });

/** One page of a workspace's members. */
export const membersPageOf = internalQuery({
  args: { workspaceId: v.id("workspaces"), cursor: v.union(v.string(), v.null()), now: v.number() },
  returns: v.object({ rows: v.array(v.any()), skipped: v.number(), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { workspaceId, cursor, now }) => await membersPage(ctx, workspaceId, cursor, now),
});

/** A workspace's pending invitations. */
export const invites = internalQuery({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: rowsValidator,
  handler: async (ctx, { workspaceId, now }) => await invitesOf(ctx, workspaceId, now),
});

/** A person's reach, "shared with me" and connections. */
export const person = internalQuery({
  args: { userId: v.id("users"), now: v.number() },
  returns: v.object({ reach: rowsValidator, sharedToMe: rowsValidator, connections: rowsValidator }),
  handler: async (ctx, { userId, now }) => ({
    reach: await reachOf(ctx, userId, now),
    sharedToMe: await sharedToMeOf(ctx, userId, now),
    connections: await connectionsOf(ctx, userId, now),
  }),
});
