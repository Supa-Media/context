/**
 * How Tex talks (`lib/texStyle.ts`, Dev2, 2026-10-28): a person's own style,
 * set in the app or by texting "Tex, settings", and a group chat's, set by any
 * member there. A group uses only its own; nobody's personal style reaches a
 * shared chat.
 *
 * The app's two functions name no user: the caller is the only key, as
 * `appearance.ts`. The Worker's sets come through `lib/gatewayRoutes/texStyle.ts`
 * behind the agent Worker's secret, keyed by the phone that texted.
 */

import { v } from "convex/values";
import { getAuthUserId, requireAuthId } from "./lib/signedIn";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { hashToken } from "./lib/crypto";
import { consumeRateLimit } from "./lib/rateLimit";
import { mergeTexStyle, readTexStyle, texStyleValidator, type TexStyle } from "./lib/texStyle";
import { isPhoneNumber } from "./textLinks";

/** Generous for someone trying every option, small for a client stuck in a loop. */
const WRITES_PER_HOUR = 120;
const TEX_STYLE_WINDOW_MS = 60 * 60 * 1000;

async function rowOf(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("texStylePreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

async function save(ctx: MutationCtx, userId: Id<"users">, texStyle: TexStyle): Promise<number> {
  await consumeRateLimit(ctx, { key: `texstyle:${userId}`, limit: WRITES_PER_HOUR, windowMs: TEX_STYLE_WINDOW_MS });
  const updatedAt = Date.now();
  const row = await rowOf(ctx, userId);
  if (row === null) await ctx.db.insert("texStylePreferences", { userId, texStyle, updatedAt });
  else await ctx.db.patch(row._id, { texStyle, updatedAt });
  return updatedAt;
}

/** The caller's own style (every default is `{}`), or null signed out. */
export const myTexStyle = query({
  args: {},
  returns: v.union(texStyleValidator, v.null()),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    return (await rowOf(ctx, userId))?.texStyle ?? {};
  },
});

/** Replace the caller's own style. Refused whole when any value is off its closed set. */
export const setMyTexStyle = mutation({
  args: { texStyle: texStyleValidator },
  returns: v.number(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const texStyle = readTexStyle(args.texStyle);
    if (texStyle === null) throw new Error("That isn't a Tex setting.");
    return await save(ctx, userId, mergeTexStyle({}, texStyle));
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

/** The style a 1:1 texted turn uses: the linked person's own, `{}` when unset or unlinked. */
export const textsStyle = internalQuery({
  args: { phone: v.string() },
  returns: texStyleValidator,
  handler: async (ctx, args) => {
    const userId = await linkedUser(ctx, args.phone);
    return userId === null ? {} : ((await rowOf(ctx, userId))?.texStyle ?? {});
  },
});

/** "Tex, settings" in a 1:1 chat: `patch` laid over the linked person's style. The merged style, or null unlinked. */
export const setTextsStyle = internalMutation({
  args: { phone: v.string(), patch: texStyleValidator },
  returns: v.union(texStyleValidator, v.null()),
  handler: async (ctx, args) => {
    const userId = await linkedUser(ctx, args.phone);
    if (userId === null) return null;
    const texStyle = mergeTexStyle((await rowOf(ctx, userId))?.texStyle, args.patch);
    await save(ctx, userId, texStyle);
    return texStyle;
  },
});

/** "Tex, settings" in a group: `patch` laid over the chat's style, with who set it, as `setGroupEngagement`. */
export const setGroupTexStyle = internalMutation({
  args: { groupKey: v.string(), patch: texStyleValidator, setBy: v.string() },
  returns: v.union(texStyleValidator, v.null()),
  handler: async (ctx, args) => {
    const chat = await ctx.db
      .query("textGroups")
      .withIndex("by_key", (q) => q.eq("groupKey", args.groupKey))
      .unique();
    if (chat === null) return null;
    await consumeRateLimit(ctx, { key: `texstyle:group:${args.groupKey}`, limit: WRITES_PER_HOUR, windowMs: TEX_STYLE_WINDOW_MS });
    const texStyle = mergeTexStyle(chat.texStyle, args.patch);
    const setBy = isPhoneNumber(args.setBy) ? await hashToken(`${args.groupKey}:${args.setBy}`) : args.setBy;
    await ctx.db.patch(chat._id, { texStyle, texStyleSetBy: setBy, texStyleSetAt: Date.now() });
    return texStyle;
  },
});
