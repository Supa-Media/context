/**
 * An answer held from a group chat, and the asker's yes that shares it (privacy rulebook rules 3 and 4, Dev2,
 * 2026-11-25 and 2026-11-26).
 *
 * A group turn reads the asker's own workspaces. When its answer carries what it read from one that someone in the chat
 * can't open, the gateway holds it (`packages/tex/gateway/agent/roomCheck.js`) and the draft goes to the asker alone, in
 * their own chat with Tex. Here the hold is recorded on the chat's row, with the people present then (keyed hashes of
 * their numbers, as the control plane saw them when it minted that turn's token), and the asker's yes from their own chat marks it shared. From then on those workspaces may be said in
 * that chat while everyone in it was there when it was shared; anyone new, and the room is locked again (rule 4: "an
 * unlock sticks to the room for the people present then; a newcomer starts locked").
 *
 *  - `recordHold`: the group turn's own token, on the tagger's own tag only; the tagger is the one who asked.
 *  - `shareHold`: the asker's own 1:1 texting token only, for a hold they asked for, in workspaces they are still in;
 *    with no id, their newest hold in that chat not yet shared.
 *  - `unlockedSlugs`: which slugs a chat's turn may treat as open, for the people in it now.
 *
 * Nothing here reads or keeps a word of the answer: the draft travels only through the asker's own 1:1.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { resolveLiveGrant, texChatIdOf } from "./lib/controlPlane/liveGrants";
import { ownTagOf } from "./lib/controlPlane/session";
import { getMembership } from "./lib/workspaceAuth";
import { workspaceBySlug } from "./lib/textGroupInvited";
import { TEXTS_CLIENT_ID } from "./textLinks";
import { TEXTS_GROUP_CLIENT_ID } from "./textGroups";

/** Holds kept per chat, newest first; older ones fall off. */
export const MAX_HOLDS = 20;
/** A hold not shared within this long can't be shared any more. */
export const HOLD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOLD_ID = /^h[a-z0-9]{8,40}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The group chat and its tagger a group turn's token stands for, on their own tag only; else null. */
async function taggedChat(ctx: QueryCtx, hashedAccessToken: string) {
  const live = await resolveLiveGrant(ctx, hashedAccessToken);
  if (live === null || live.grant.clientId !== TEXTS_GROUP_CLIENT_ID || live.grant.texGroup === undefined) return null;
  const chatKey = await texChatIdOf(ctx, live);
  const tagger = ownTagOf(live, chatKey, hashedAccessToken).texTaggerId;
  if (tagger === undefined) return null;
  const chat = await ctx.db.get(live.grant.texGroup.groupId);
  return chat === null ? null : { chat, tagger, people: live.grant.texGroup.ownTagPresent ?? [] };
}

export const recordHold = internalMutation({
  args: { hashedAccessToken: v.string(), id: v.string(), slugs: v.array(v.string()) },
  returns: v.union(v.literal("held"), v.literal("refused"), v.literal("bad_request")),
  handler: async (ctx, args) => {
    const slugs = [...new Set(args.slugs.map((slug) => slug.trim().replace(/^@/, "").toLowerCase()))].filter((slug) => SLUG.test(slug)).slice(0, 10);
    if (!HOLD_ID.test(args.id) || slugs.length === 0) return "bad_request";
    const found = await taggedChat(ctx, args.hashedAccessToken);
    if (found === null) return "refused";
    // Who was there is what the control plane saw when it minted this turn's token, never numbers the caller names.
    const people = found.people;
    if (people.length === 0) return "bad_request";
    const now = Date.now();
    const kept = (found.chat.holds ?? []).filter((hold) => hold.id !== args.id && (hold.sharedAt !== undefined || now - hold.at <= HOLD_TTL_MS));
    await ctx.db.patch(found.chat._id, { holds: [{ id: args.id, slugs, people, by: found.tagger, at: now }, ...kept].slice(0, MAX_HOLDS) });
    return "held";
  },
});

export const shareHold = internalMutation({
  args: { hashedAccessToken: v.string(), groupKey: v.string(), id: v.optional(v.string()) },
  returns: v.union(
    v.object({ status: v.literal("shared"), slugs: v.array(v.string()) }),
    v.object({ status: v.union(v.literal("refused"), v.literal("not_found"), v.literal("expired"), v.literal("not_member")) }),
  ),
  handler: async (ctx, args) => {
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    // Their own chat with Tex only: a group chat's token never shares anything held, its tagger's included.
    if (live === null || live.grant.clientId !== TEXTS_CLIENT_ID || live.grant.texGroup !== undefined) return { status: "refused" as const };
    const userId: Id<"users"> = live.grant.userId;
    const chat = await ctx.db
      .query("textGroups")
      .withIndex("by_key", (q) => q.eq("groupKey", args.groupKey))
      .unique();
    const now = Date.now();
    // Named, that hold; else their newest one there not yet shared and still in time. Holds are kept newest first.
    const hold =
      args.id !== undefined
        ? chat?.holds?.find((entry) => entry.id === args.id)
        : chat?.holds?.find((entry) => entry.by === userId && entry.sharedAt === undefined && now - entry.at <= HOLD_TTL_MS);
    // Somebody else's hold reads as no hold at all, so a token can't learn what another person asked.
    if (chat === null || hold === undefined || hold.by !== userId) return { status: "not_found" as const };
    if (hold.sharedAt === undefined && now - hold.at > HOLD_TTL_MS) return { status: "expired" as const };
    // Only what they can still open: a member who left a workspace can't share it.
    for (const slug of hold.slugs) {
      const workspace = await workspaceBySlug(ctx, slug);
      if (workspace === null || (await getMembership(ctx, workspace._id, userId)) === null) return { status: "not_member" as const };
    }
    await ctx.db.patch(chat._id, { holds: (chat.holds ?? []).map((entry) => (entry.id === hold.id ? { ...entry, sharedAt: entry.sharedAt ?? now } : entry)) });
    return { status: "shared" as const, slugs: hold.slugs };
  },
});
