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
import { internalMutation, type MutationCtx } from "../_generated/server";
import { personalOwnerReadClearance } from "./lib/controlPlane/personalOwner";
import { chatMailClearance, chatsWatching } from "./lib/textGroupMail";
import { defaultGoogleDestinationFolder } from "./lib/googleConnect/validation";
import { aiAccessNeeded, aiScopesOf, canReadProduct } from "./lib/googleConnect/aiScopes";
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
  /** A mailbox shared with a group chat: the Gmail search every read of it is narrowed by (`lib/textGroupMail.ts`). */
  filter: v.optional(v.string()),
  /** A mailbox shared with a group chat: read whole, never through the chat's notes. */
  shared: v.optional(v.literal(true)),
  /** The person's own mailbox that group chats also watch: those chats' workspaces, by slug (`lib/textGroupLooks.ts`). */
  watchedIn: v.optional(v.array(v.string())),
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
    v.object({ ok: v.literal(true), mailboxes: v.array(mailbox), reconnect: v.array(named), aiAccess: v.optional(v.array(v.string())) }),
    v.object({
      ok: v.literal(false),
      refused: v.union(v.literal("not_allowed"), v.literal("no_mailbox"), v.literal("rate_limited"), v.literal("reconnect_required"), v.literal("ai_access_needed")),
      /** Every mailbox the search would have asked, so its notes can answer instead. */
      mailboxes: v.optional(v.array(named)),
      /** Mailboxes whose Google sign-in stopped working: not searched, and not syncing. */
      reconnect: v.optional(v.array(named)),
      /** Mailboxes AI may not read until their owner allows AI access (`aiAccessNeeded`): a reconnect would not mend them. */
      aiAccess: v.optional(v.array(v.string())),
    }),
  ),
  handler: async (ctx, args) => {
    const cleared = await personalOwnerReadClearance(ctx, args);
    if (cleared === null) return await chatMailRead(ctx, args);
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
    // So is one whose AI grant does not read mail (a box left unticked, or AI
    // access not yet allowed once switched on): one more consent fixes both.
    const unreadable = (row: (typeof gmails)[number]) => !canReadProduct("gmail", aiScopesOf(row));
    const needsAiAccess = (row: (typeof gmails)[number]) => row.health !== "reconnect_required" && unreadable(row) && aiAccessNeeded(row);
    const reconnect = gmails
      .filter((row) => row.health === "reconnect_required" || (unreadable(row) && !needsAiAccess(row)))
      .map((row) => ({ address: row.address.toLowerCase(), folder: folderOf(row) }));
    const aiAccess = gmails.filter(needsAiAccess).map((row) => row.address.toLowerCase());
    const allow = aiAccess.length > 0 ? { aiAccess } : {};
    const mailboxes = gmails
      .filter((row) => row.health !== "reconnect_required" && !unreadable(row))
      .map((row) => ({
        connectionId: row._id,
        address: row.address.toLowerCase(),
        folder: folderOf(row),
        syncedFrom: row.createdAt,
        ...(row.gmail!.lastSyncedAt === undefined ? {} : { syncedThrough: row.gmail!.lastSyncedAt }),
      }));
    // Which of them a group chat also watches, so the person's own check-ins leave the chat's mail to it.
    for (const mailbox of mailboxes) {
      const watchedIn = await chatsWatching(ctx, userId, mailbox.address);
      if (watchedIn.length > 0) Object.assign(mailbox, { watchedIn });
    }
    if (mailboxes.length === 0) {
      if (reconnect.length > 0) return { ok: false as const, refused: "reconnect_required" as const, reconnect, ...allow };
      return aiAccess.length > 0
        ? { ok: false as const, refused: "ai_access_needed" as const, aiAccess }
        : { ok: false as const, refused: "no_mailbox" as const };
    }

    const room = await tryConsumeRateLimit(ctx, {
      key: `person.mail.read:${userId}`,
      limit: PERSON_MAIL_READS_PER_HOUR,
      windowMs: 60 * 60 * 1000,
    });
    if (!room) {
      const asked = mailboxes.map(({ address, folder }) => ({ address, folder }));
      return { ok: false as const, refused: "rate_limited" as const, mailboxes: asked, reconnect, ...allow };
    }
    return { ok: true as const, mailboxes, reconnect, ...allow };
  },
});

/**
 * A group chat's read of the mailboxes shared with it (`lib/textGroupMail.ts`):
 * each narrowed by its share's search, each against its own person's hourly
 * reads. Not one, and the answer is the same as for any connection that may
 * read nobody's mail.
 */
async function chatMailRead(
  ctx: MutationCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string; address: string | null },
) {
  const shares = await chatMailClearance(ctx, args);
  const wanted = (shares ?? []).filter(({ share }) => args.address === null || share.address === args.address);
  if (wanted.length === 0) return { ok: false as const, refused: "not_allowed" as const };
  const usable = wanted.filter(({ connection }) => connection.health !== "reconnect_required");
  const reconnect = wanted
    .filter(({ connection }) => connection.health === "reconnect_required")
    .map(({ share }) => ({ address: share.address, folder: CHAT_MAIL_FOLDER }));
  if (usable.length === 0) return { ok: false as const, refused: "reconnect_required" as const, reconnect };
  for (const userId of new Set(usable.map(({ share }) => share.userId))) {
    const room = await tryConsumeRateLimit(ctx, { key: `person.mail.read:${userId}`, limit: PERSON_MAIL_READS_PER_HOUR, windowMs: 60 * 60 * 1000 });
    if (!room) return { ok: false as const, refused: "rate_limited" as const, mailboxes: [], reconnect };
  }
  const mailboxes = usable.map(({ share, connection }) => ({
    connectionId: connection._id,
    address: share.address,
    folder: CHAT_MAIL_FOLDER,
    syncedFrom: connection.createdAt,
    ...(share.query !== undefined ? { filter: share.query } : {}),
    shared: true as const,
  }));
  return { ok: true as const, mailboxes, reconnect };
}

/** No chat keeps a shared mailbox's mail in notes: its stand-in folder holds none. */
const CHAT_MAIL_FOLDER = "tex/groups/mail";
