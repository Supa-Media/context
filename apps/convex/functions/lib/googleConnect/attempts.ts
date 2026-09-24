/**
 * The parked half of a connect: who may start one, and the attempt row it
 * waits in until Google sends the person back.
 *
 * Split out of `functions/googleConnect.ts`, which keeps every registered
 * function and wires these handlers to them; this module registers none and opens no credential.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { ATTEMPT_TTL_MS } from "./config";

export const requirePersonalOwnerArgs = { workspaceId: v.id("workspaces"), userId: v.id("users") };

export const requirePersonalOwnerReturns = v.boolean();

/**
 * Owner of the workspace, AND the workspace is a personal context. Both, in
 * one query, so a caller cannot connect a Google account into a shared
 * context they happen to own — ownership of a shared workspace is not the
 * permission this checks.
 */
export async function requirePersonalOwnerHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof requirePersonalOwnerArgs>,
) {
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null || workspace.kind !== "personal") return false;
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", args.workspaceId).eq("userId", args.userId),
    )
    .unique();
  return membership?.role === "owner";
}

export const parkAttemptArgs = {
  hashedState: v.string(),
  hashedCompletion: v.string(),
  encryptedVerifier: v.string(),
  workspaceId: v.id("workspaces"),
  startedBy: v.id("users"),
  redirectUri: v.string(),
  flow: v.optional(
    v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"), v.literal("google")),
  ),
  products: v.array(v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"))),
  backfillDays: v.number(),
  folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
  attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
  attachmentRetentionDays: v.union(v.number(), v.literal("forever")),
};

export const parkAttemptReturns = v.null();

export async function parkAttemptHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof parkAttemptArgs>,
) {
  const now = Date.now();
  const stale = await ctx.db
    .query("googleConnectAttempts")
    .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
    .take(20);
  for (const row of stale) await ctx.db.delete(row._id);

  await ctx.db.insert("googleConnectAttempts", {
    hashedState: args.hashedState,
    hashedCompletion: args.hashedCompletion,
    encryptedVerifier: args.encryptedVerifier,
    workspaceId: args.workspaceId,
    startedBy: args.startedBy,
    redirectUri: args.redirectUri,
    flow: args.flow,
    products: args.products,
    backfillDays: args.backfillDays,
    folders: args.folders,
    // Not in the schema's `googleConnectAttempts` — see `exchangeAndBind`,
    // which reads these off the same two args this attempt already
    // carries rather than a third place. Kept here as plain fields on the
    // attempt row so they survive the redirect the same way backfillDays
    // and folders do.
    attachmentMode: args.attachmentMode,
    attachmentRetentionDays:
      args.attachmentRetentionDays === "forever" ? undefined : args.attachmentRetentionDays,
    attachmentRetentionForever: args.attachmentRetentionDays === "forever",
    expiresAt: now + ATTEMPT_TTL_MS,
    createdAt: now,
  });
  return null;
}
