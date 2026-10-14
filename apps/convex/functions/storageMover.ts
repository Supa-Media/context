/**
 * Mover tickets: one page of a whole-bucket move handed to the gateway's
 * mover (`apps/mcp/src/moves/mover.js`). See `moverTickets` in
 * `lib/schema/jobs.ts` for what a ticket is, and `lib/storageMover.ts` for the
 * call that mints and hands one over.
 *
 * Nothing here opens a credential: `managedProvisioning.openMoverPage` spends
 * the ticket through `claimPage` and opens the buckets itself.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { MOVER_TICKET_TTL_MS } from "./lib/managedProvisioningFns/constants";

const pagePhase = v.union(v.literal("copy"), v.literal("verify_source"), v.literal("verify_target"));

/** Store one page's ticket, hashed, and clear this workspace's expired ones. */
export const mintPage = internalMutation({
  args: {
    hashedTicket: v.string(),
    workspaceId: v.id("workspaces"),
    migrationId: v.id("managedStorageMigrations"),
    phase: pagePhase,
    expectedCursor: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const old = await ctx.db
      .query("moverTickets")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(20);
    for (const row of old) if (row.expiresAt <= args.now) await ctx.db.delete(row._id);
    await ctx.db.insert("moverTickets", {
      hashedTicket: args.hashedTicket,
      workspaceId: args.workspaceId,
      migrationId: args.migrationId,
      phase: args.phase,
      ...(args.expectedCursor === undefined ? {} : { expectedCursor: args.expectedCursor }),
      createdAt: args.now,
      expiresAt: args.now + MOVER_TICKET_TTL_MS,
    });
    return null;
  },
});

/** Spend a ticket: it is deleted whether or not it was still good. */
export const claimPage = internalMutation({
  args: { hashedTicket: v.string(), now: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      migrationId: v.id("managedStorageMigrations"),
      phase: pagePhase,
      expectedCursor: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("moverTickets")
      .withIndex("by_hashed_ticket", (q) => q.eq("hashedTicket", args.hashedTicket))
      .unique();
    if (row === null) return null;
    await ctx.db.delete(row._id);
    if (row.expiresAt <= args.now) return null;
    return {
      workspaceId: row.workspaceId,
      migrationId: row.migrationId,
      phase: row.phase,
      ...(row.expectedCursor === undefined ? {} : { expectedCursor: row.expectedCursor }),
    };
  },
});

/** Drop a ticket the mover never spent (it failed, or timed out). */
export const dropPage = internalMutation({
  args: { hashedTicket: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("moverTickets")
      .withIndex("by_hashed_ticket", (q) => q.eq("hashedTicket", args.hashedTicket))
      .unique();
    if (row !== null) await ctx.db.delete(row._id);
    return null;
  },
});
