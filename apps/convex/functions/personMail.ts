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
import { internalMutation } from "../_generated/server";
import { personalOwnerReadClearance } from "./lib/controlPlane/personalOwner";
import { defaultGoogleDestinationFolder } from "./lib/googleConnect/validation";
import { tryConsumeRateLimit } from "./lib/rateLimit";

/** Live reads per person per hour: searches and opened messages together. */
export const PERSON_MAIL_READS_PER_HOUR = 300;

const mailbox = v.object({
  connectionId: v.id("googleConnections"),
  address: v.string(),
  folder: v.string(),
  /** When the mailbox was connected: older mail is not in the notes. */
  syncedFrom: v.number(),
  /** The last pass that read mail; newer mail may not be in the notes yet. */
  syncedThrough: v.optional(v.number()),
});

/** A mailbox's address and the folder its synced day notes are in. */
const named = v.object({ address: v.string(), folder: v.string() });

export const claimPersonMailRead = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.string(),
    /** One mailbox by its lowercased address, or null for every one. */
    address: v.union(v.string(), v.null()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), mailboxes: v.array(mailbox), reconnect: v.array(named) }),
    v.object({
      ok: v.literal(false),
      refused: v.union(v.literal("not_allowed"), v.literal("no_mailbox"), v.literal("rate_limited"), v.literal("reconnect_required")),
      /** Every mailbox the search would have asked, so its notes can answer instead. */
      mailboxes: v.optional(v.array(named)),
      /** Mailboxes whose Google sign-in stopped working: not searched, and not syncing. */
      reconnect: v.optional(v.array(named)),
    }),
  ),
  handler: async (ctx, args) => {
    const cleared = await personalOwnerReadClearance(ctx, args);
    if (cleared === null) return { ok: false as const, refused: "not_allowed" as const };
    const { workspace, userId } = cleared;

    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .take(20);
    const gmails = connections.filter(
      (row) =>
        row.disconnectedAt === undefined &&
        row.products.includes("gmail") &&
        row.gmail !== undefined &&
        (args.address === null || row.address.toLowerCase() === args.address),
    );
    const folderOf = (row: (typeof gmails)[number]) =>
      row.gmail!.destinationFolder ?? defaultGoogleDestinationFolder("gmail", row.gmail!.mailboxSlug);
    // A mailbox whose sign-in Google stopped honouring is named, so the person
    // is told to reconnect it rather than its mail silently missing (2026-10-20).
    const reconnect = gmails
      .filter((row) => row.health === "reconnect_required")
      .map((row) => ({ address: row.address.toLowerCase(), folder: folderOf(row) }));
    const mailboxes = gmails
      .filter((row) => row.health !== "reconnect_required")
      .map((row) => ({
        connectionId: row._id,
        address: row.address.toLowerCase(),
        folder: folderOf(row),
        syncedFrom: row.createdAt,
        ...(row.gmail!.lastSyncedAt === undefined ? {} : { syncedThrough: row.gmail!.lastSyncedAt }),
      }));
    if (mailboxes.length === 0) {
      return reconnect.length > 0
        ? { ok: false as const, refused: "reconnect_required" as const, reconnect }
        : { ok: false as const, refused: "no_mailbox" as const };
    }

    const room = await tryConsumeRateLimit(ctx, {
      key: `person.mail.read:${userId}`,
      limit: PERSON_MAIL_READS_PER_HOUR,
      windowMs: 60 * 60 * 1000,
    });
    if (!room) {
      const asked = mailboxes.map(({ address, folder }) => ({ address, folder }));
      return { ok: false as const, refused: "rate_limited" as const, mailboxes: asked, reconnect };
    }
    return { ok: true as const, mailboxes, reconnect };
  },
});
