/**
 * The person's own name on their account, changed after sign-up (Dev2, 2026-11-25: a group asked Tex for someone's
 * last name, and the account held only the first name typed at sign-up, with no way to change it).
 *
 * `users.name` is what Tex answers a contact ask with (`packages/tex/gateway/agent/askPersonalTex.js`) and what
 * people see beside a note. It was written once, by `accountSetup.finishSetup`. Now it changes two ways, both on the
 * person's own account only:
 *  - in the app: Settings › Profile › Name (`setMyName`);
 *  - by text: their own chat with Tex (`gatewayRoutes/accountName.ts`, the person taken off the turn's own texting
 *    grant, never from a group chat, where someone else's words could rename them).
 */

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./lib/rowWatch/mutations";
import type { Id } from "../_generated/dataModel";
import { getAuthUserId, requireAuthId } from "./lib/signedIn";
import { resolveLiveGrant } from "./lib/controlPlane/liveGrants";
import { MAX_DISPLAY_NAME_LENGTH } from "./lib/workspaces/constants";
import { TEXTS_CLIENT_ID } from "./textLinks";

/** A name as saved: trimmed, inner runs of space made one, 1 to 80 characters; null when it isn't one. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= MAX_DISPLAY_NAME_LENGTH ? name : null;
}

/** The signed-in person's name, or null when signed out. */
export const myName = query({
  args: {},
  returns: v.union(v.null(), v.object({ name: v.union(v.string(), v.null()) })),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (user === null) return null;
    return { name: user.name?.trim() ? user.name.trim() : null };
  },
});

/** Settings › Profile › Name. Their own account only. */
export const setMyName = mutation({
  args: { name: v.string() },
  returns: v.object({ name: v.string() }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const name = cleanName(args.name);
    if (name === null) throw new ConvexError({ code: "INVALID", message: `A name is 1 to ${MAX_DISPLAY_NAME_LENGTH} characters.` });
    await ctx.db.patch(userId, { name });
    return { name };
  },
});

/** The person a token's own chat with Tex belongs to: a person's texting grant, never a group chat's; else null. */
export const textedOwner = internalQuery({
  args: { hashedAccessToken: v.string() },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), name: v.union(v.string(), v.null()) })),
  handler: async (ctx, args) => {
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    if (live === null || live.grant.clientId !== TEXTS_CLIENT_ID || live.grant.texGroup !== undefined) return null;
    const user = await ctx.db.get(live.grant.userId);
    if (user === null) return null;
    return { userId: user._id, name: user.name?.trim() ? user.name.trim() : null };
  },
});

export const writeName = internalMutation({
  args: { userId: v.id("users"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const name = cleanName(args.name);
    if (name === null) return null;
    await ctx.db.patch(args.userId, { name });
    return null;
  },
});
