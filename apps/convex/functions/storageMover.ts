/**
 * Mover tickets: one page of a whole-bucket move, of the managed-storage
 * encryption walk, or one batch of a move into another context, handed to
 * the gateway's mover (`apps/mcp/src/moves/mover.js`). See `moverTickets` in `lib/schema/jobs.ts`
 * for what a ticket is, and `lib/storageMover.ts` for the call that mints and
 * hands one over.
 *
 * Nothing here opens a credential: `managedProvisioning.openMoverPage` spends
 * the ticket through `claimPage` and opens the buckets itself.
 */

import { v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import { MOVER_TICKET_TTL_MS } from "./lib/managedProvisioningFns/constants";

const pagePhase = v.union(
  v.literal("copy"),
  v.literal("verify_source"),
  v.literal("verify_target"),
  v.literal("seal"),
  v.literal("check"),
  v.literal("unseal"),
  v.literal("confirm"),
  v.literal("id_copy"),
  v.literal("id_check"),
  v.literal("cleanup_list"),
  v.literal("cleanup_delete"),
);

const cleanupKeys = v.array(v.string());

const idItems = v.array(v.object({ path: v.string(), key: v.string(), etag: v.string(), size: v.optional(v.number()) }));

/** Store one page's ticket, hashed, and clear this workspace's expired ones. */
export const mintPage = internalMutation({
  args: {
    hashedTicket: v.string(),
    workspaceId: v.id("workspaces"),
    migrationId: v.optional(v.id("managedStorageMigrations")),
    walkRunId: v.optional(v.number()),
    idRunId: v.optional(v.number()),
    idItems: v.optional(idItems),
    cleanupRunId: v.optional(v.number()),
    cleanupKeys: v.optional(cleanupKeys),
    phase: pagePhase,
    expectedCursor: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Exactly one job per ticket, so a spent ticket can never be read as another.
    const jobs = [args.migrationId, args.walkRunId, args.idRunId, args.cleanupRunId].filter((job) => job !== undefined).length;
    if (jobs !== 1) throw new Error("COPY_FAILED");
    // A cleanup ticket names its keys only on a delete page; its list page names none.
    const cleanupPhase = args.phase === "cleanup_list" || args.phase === "cleanup_delete";
    if ((args.cleanupRunId !== undefined) !== cleanupPhase) throw new Error("COPY_FAILED");
    if (args.cleanupKeys !== undefined && args.phase !== "cleanup_delete") throw new Error("COPY_FAILED");
    // An id-copy ticket names its items, and only its own phases carry them.
    const idPhase = args.phase === "id_copy" || args.phase === "id_check";
    if ((args.idRunId !== undefined) !== (args.idItems !== undefined && idPhase)) throw new Error("COPY_FAILED");
    const old = await ctx.db
      .query("moverTickets")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(20);
    for (const row of old) if (row.expiresAt <= args.now) await ctx.db.delete(row._id);
    await ctx.db.insert("moverTickets", {
      hashedTicket: args.hashedTicket,
      workspaceId: args.workspaceId,
      ...(args.migrationId === undefined ? {} : { migrationId: args.migrationId }),
      ...(args.walkRunId === undefined ? {} : { walkRunId: args.walkRunId }),
      ...(args.idRunId === undefined ? {} : { idRunId: args.idRunId, idItems: args.idItems }),
      ...(args.cleanupRunId === undefined ? {} : { cleanupRunId: args.cleanupRunId, cleanupKeys: args.cleanupKeys ?? [] }),
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
      migrationId: v.optional(v.id("managedStorageMigrations")),
      walkRunId: v.optional(v.number()),
      idRunId: v.optional(v.number()),
      idItems: v.optional(idItems),
      cleanupRunId: v.optional(v.number()),
      cleanupKeys: v.optional(cleanupKeys),
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
    // A retired context move's leftover ticket (#2100) is spent, never carried.
    if (row.expiresAt <= args.now || row.phase === "carry") return null;
    return {
      workspaceId: row.workspaceId,
      ...(row.migrationId === undefined ? {} : { migrationId: row.migrationId }),
      ...(row.walkRunId === undefined ? {} : { walkRunId: row.walkRunId }),
      ...(row.idRunId === undefined ? {} : { idRunId: row.idRunId, idItems: row.idItems ?? [] }),
      ...(row.cleanupRunId === undefined ? {} : { cleanupRunId: row.cleanupRunId, cleanupKeys: row.cleanupKeys ?? [] }),
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
