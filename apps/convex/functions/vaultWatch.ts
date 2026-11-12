import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

/**
 * For the texting Worker, after Tex texted a link to save a login (Dev2,
 * 2026-10-24: "after adding the email and password Tex should know that i'm
 * done adding"): whether the phone's person has since saved one, so Tex
 * carries on with the task without them texting "done".
 *
 * Times only, never which entry or what was in it. `saved` is the newest add
 * link they used at or after `since`; `waiting` while one they could still use
 * is live; `gone` when none is, or the phone is no longer linked, and the
 * Worker stops looking. A request row lives until it expires
 * (`purgeExpiredVaultRequests`), as long as the link it was texted as.
 *
 * With `links`, the look is for those links alone, by their hashed tokens:
 * the chat that texted a link watches that link, so a save on a link a group
 * chat sent wakes that chat and never the person's 1:1 (Dev2, 2026-11-12:
 * "the link should ... signify this group chat"). A hash that is not this
 * phone's person's add link counts as nothing.
 */
/** Most links one look names: a turn mints a few at most. */
const MAX_LINKS = 5;

export const savedSince = internalQuery({
  args: { phone: v.string(), since: v.number(), links: v.optional(v.array(v.string())) },
  returns: v.union(
    v.object({ status: v.literal("waiting") }),
    v.object({ status: v.literal("gone") }),
    v.object({ status: v.literal("saved"), savedAt: v.number() }),
  ),
  handler: async (ctx, { phone, since, links }) => {
    const link = await ctx.db
      .query("phoneLinks")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (link === null) return { status: "gone" as const };
    const now = Date.now();
    if (links !== undefined) {
      const found = await Promise.all(
        links.slice(0, MAX_LINKS).map((hashedToken) =>
          ctx.db
            .query("vaultRequests")
            .withIndex("by_hashed_token", (q) => q.eq("hashedToken", hashedToken))
            .unique(),
        ),
      );
      const theirs = found.filter((row) => row !== null && row.userId === link.userId && row.kind === "add");
      const usedAt = Math.max(0, ...theirs.map((row) => row!.usedAt ?? 0));
      if (usedAt > 0) return { status: "saved" as const, savedAt: usedAt };
      return theirs.some((row) => row!.expiresAt > now) ? { status: "waiting" as const } : { status: "gone" as const };
    }
    const rows = await ctx.db
      .query("vaultRequests")
      .withIndex("by_user_kind", (q) => q.eq("userId", link.userId).eq("kind", "add"))
      .order("desc")
      .take(20);
    const savedAt = Math.max(0, ...rows.map((row) => row.usedAt ?? 0).filter((at) => at >= since));
    if (savedAt > 0) return { status: "saved" as const, savedAt };
    return rows.some((row) => row.usedAt === undefined && row.expiresAt > now) ? { status: "waiting" as const } : { status: "gone" as const };
  },
});
