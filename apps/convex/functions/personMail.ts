/**
 * Which of a person's Gmail mailboxes an AI may read live, and how much of
 * their synced mail each already holds (`lib/gatewayRoutes/personMail.ts`,
 * `docs/decisions/communications/reading-mail.md`).
 *
 * Synced mail is read from the person's notes like any other note. This is
 * the other half: mail from before a mailbox was connected, or newer than
 * its last successful pass, read from Gmail itself when the notes do not
 * have it. One mutation, so the clearance and the rate limit are one
 * transaction.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { TOKEN_HASH_PATTERN } from "./lib/crypto";
import { contextsForGrant, resolveLiveGrant } from "./lib/controlPlane/liveGrants";
import { defaultGoogleDestinationFolder } from "./lib/googleConnect/validation";
import { tryConsumeRateLimit } from "./lib/rateLimit";

/** Live reads per person per hour: searches and opened messages together. */
export const PERSON_MAIL_READS_PER_HOUR = 120;

const mailbox = v.object({
  connectionId: v.id("googleConnections"),
  address: v.string(),
  folder: v.string(),
  /** When the mailbox was connected: older mail is not in the notes. */
  syncedFrom: v.number(),
  /** The last pass that read mail; newer mail may not be in the notes yet. */
  syncedThrough: v.optional(v.number()),
});

export const claimPersonMailRead = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.string(),
    /** One mailbox by its lowercased address, or null for every one. */
    address: v.union(v.string(), v.null()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), mailboxes: v.array(mailbox) }),
    v.object({
      ok: v.literal(false),
      refused: v.union(v.literal("not_allowed"), v.literal("no_mailbox"), v.literal("rate_limited")),
    }),
  ),
  handler: async (ctx, args) => {
    if (!TOKEN_HASH_PATTERN.test(args.hashedAccessToken)) return { ok: false as const, refused: "not_allowed" as const };
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    if (live === null) return { ok: false as const, refused: "not_allowed" as const };
    /*
      THE OWNER OF THE PERSONAL WORKSPACE, WITH PRIVATE CLEARANCE, AND NOBODY ELSE.

      A mailbox is connected to its person's personal workspace, and its mail is
      as private as anything in it. So the call must address that workspace,
      the grant must hold `context:private`, and the grant's person must own it:
      an editor or member of somebody's personal workspace never reaches its
      mail, and `expectedWorkspaceId` only selects within the grant's own set.
    */
    const covered = (await contextsForGrant(ctx, live)).find(
      (entry) => entry.workspaceId === args.expectedWorkspaceId,
    );
    if (covered === undefined || covered.role !== "owner" || covered.kind !== "personal") {
      return { ok: false as const, refused: "not_allowed" as const };
    }
    if (!live.grant.scopes.includes("context:private")) return { ok: false as const, refused: "not_allowed" as const };
    const workspace = await ctx.db.get(covered.workspaceId as Id<"workspaces">);
    if (workspace === null || workspace.kind !== "personal" || workspace.createdBy !== live.grant.userId) {
      return { ok: false as const, refused: "not_allowed" as const };
    }

    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .take(20);
    const mailboxes = connections
      .filter(
        (row) =>
          row.disconnectedAt === undefined &&
          row.health !== "reconnect_required" &&
          row.products.includes("gmail") &&
          row.gmail !== undefined &&
          (args.address === null || row.address.toLowerCase() === args.address),
      )
      .map((row) => ({
        connectionId: row._id,
        address: row.address.toLowerCase(),
        folder: row.gmail!.destinationFolder ?? defaultGoogleDestinationFolder("gmail", row.gmail!.mailboxSlug),
        syncedFrom: row.createdAt,
        ...(row.gmail!.lastSyncedAt === undefined ? {} : { syncedThrough: row.gmail!.lastSyncedAt }),
      }));
    if (mailboxes.length === 0) return { ok: false as const, refused: "no_mailbox" as const };

    const room = await tryConsumeRateLimit(ctx, {
      key: `person.mail.read:${live.grant.userId}`,
      limit: PERSON_MAIL_READS_PER_HOUR,
      windowMs: 60 * 60 * 1000,
    });
    if (!room) return { ok: false as const, refused: "rate_limited" as const };
    return { ok: true as const, mailboxes };
  },
});
