/**
 * How Tex talks (`lib/texInstructions.ts`, Dev2, 2026-11-01): a person's own
 * instructions and progress updates, set in the app or by texting, and a group
 * chat's, set by any member there. A group uses only its own; nobody's personal
 * instructions reach a shared chat.
 *
 * The app's two functions name no user: the caller is the only key, as
 * `appearance.ts`. The Worker's sets come through `lib/gatewayRoutes/texStyle.ts`
 * behind the agent Worker's secret, keyed by the phone that texted.
 */

import { v } from "convex/values";
import { getAuthUserId, requireAuthId } from "./lib/signedIn";
import type { Id } from "../_generated/dataModel";
import { internalQuery, query, type QueryCtx } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { hashToken } from "./lib/crypto";
import { instructionsChangeValidator, QUICK_PICKS, texUpdatesValidator } from "./lib/texInstructions";
import { personRow, setChatSettings, setPersonSettings, settingsOf } from "./lib/texChatRules";
import { isPhoneNumber } from "./textLinks";

const settingsValidator = v.object({ instructions: v.optional(v.string()), updates: v.optional(texUpdatesValidator) });
/** A change refused, by why: a pick nobody made, too long, or nothing to undo. */
const savedValidator = v.union(settingsValidator, v.object({ refused: v.union(v.literal("bad_request"), v.literal("too_long"), v.literal("nothing_to_undo")) }));
const askValidator = { change: v.optional(instructionsChangeValidator), updates: v.optional(texUpdatesValidator) };

/** The caller's own settings and the quick picks to offer, or null signed out. */
export const myTexStyle = query({
  args: {},
  returns: v.union(v.object({ instructions: v.optional(v.string()), updates: v.optional(texUpdatesValidator), picks: v.array(v.object({ id: v.string(), label: v.string() })) }), v.null()),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    return { ...settingsOf((await personRow(ctx, userId)) ?? {}), picks: QUICK_PICKS.map(({ id, label }) => ({ id, label })) };
  },
});

/** Change the caller's own instructions or progress updates. A change off its rules is refused whole. */
export const setMyTexStyle = mutation({
  args: askValidator,
  returns: savedValidator,
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    return await setPersonSettings(ctx, userId, args);
  },
});

async function linkedUser(ctx: QueryCtx, phone: string): Promise<Id<"users"> | null> {
  if (!isPhoneNumber(phone)) return null;
  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
  return link?.userId ?? null;
}

/** The settings a 1:1 texted turn uses: the linked person's own, `{}` when unset or unlinked. */
export const textsStyle = internalQuery({
  args: { phone: v.string() },
  returns: settingsValidator,
  handler: async (ctx, args) => {
    const userId = await linkedUser(ctx, args.phone);
    return userId === null ? {} : settingsOf((await personRow(ctx, userId)) ?? {});
  },
});

/** "Tex, settings" in a 1:1 chat: the linked person's settings changed. Their settings now, or null unlinked. */
export const setTextsStyle = internalMutation({
  args: { phone: v.string(), ...askValidator },
  returns: v.union(savedValidator, v.null()),
  handler: async (ctx, { phone, ...ask }) => {
    const userId = await linkedUser(ctx, phone);
    if (userId === null) return null;
    return await setPersonSettings(ctx, userId, ask);
  },
});

/** "Tex, settings" in a group: the chat's settings changed, with who set them, as `setGroupEngagement`. */
export const setGroupTexStyle = internalMutation({
  args: { groupKey: v.string(), setBy: v.string(), ...askValidator },
  returns: v.union(savedValidator, v.null()),
  handler: async (ctx, { groupKey, setBy: given, ...ask }) => {
    const chat = await ctx.db
      .query("textGroups")
      .withIndex("by_key", (q) => q.eq("groupKey", groupKey))
      .unique();
    if (chat === null) return null;
    const setBy = isPhoneNumber(given) ? await hashToken(`${groupKey}:${given}`) : given;
    return await setChatSettings(ctx, chat, ask, setBy);
  },
});
