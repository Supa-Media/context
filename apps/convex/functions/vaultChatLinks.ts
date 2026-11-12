/**
 * A vault link Tex texted in a group chat (Dev2, 2026-11-12): what its page shows of the chat, and "Add" beside
 * somebody in it who isn't in the workspace. Who may use a save is chosen in `vault.ts` `saveVaultLogin`.
 */

import { ConvexError, v } from "convex/values";
import { internalQuery, mutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { getAuthUserId } from "./lib/signedIn";
import { hashToken } from "./lib/crypto";
import { getMembership } from "./lib/workspaceAuth";
import { inviteMemberWithId } from "./lib/invitations/invite";
import { chatLabel, chatPeopleFor, requestChatOf, requestChatValidator, type RequestChat } from "./lib/vaultChat";
import { resolveLiveGrant, texChatIdOf } from "./lib/controlPlane/liveGrants";
import type { Described } from "./lib/vaultShapes";

function fail(code: string, message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}
const dead = () => fail("VAULT_LINK_DEAD", "This link has expired or was already used. Ask Tex for a new one.");
const notYours = () => fail("VAULT_LINK_NOT_YOURS", "This link is for a different account. Sign in as the person who asked for it.");

/** A workspace's kind, for what a save may be given to. */
export const workspaceKindOf = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<"personal" | "shared"> => (await ctx.db.get(args.workspaceId))?.kind ?? "personal",
});

/** The group chat a turn's token is for, and its people, from the grant alone: null for any other token. */
export const chatOfGrant = internalQuery({
  args: { hashedAccessToken: v.string() },
  handler: async (ctx, args): Promise<RequestChat | null> => {
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    if (live === null) return null;
    return await requestChatOf(ctx, live.grant, (await texChatIdOf(ctx, live)) ?? undefined);
  },
});

/** The chat's name as the vault's people list shows it, for a save given to the chat (`vault.ts` `saveVaultLogin`). */
export const chatLabelFor = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users"), chat: requestChatValidator },
  handler: async (ctx, args): Promise<string> => chatLabel(await chatPeopleFor(ctx, args.workspaceId, args.chat, args.userId)),
});

/** What the page shows of the chat a link was texted in: its name, each person and whether they are in the workspace. */
export const chatForPage = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users"), hashedToken: v.string() },
  handler: async (ctx, args): Promise<Described["chat"]> => {
    const row = await ctx.db
      .query("vaultRequests")
      .withIndex("by_hashed_token", (q) => q.eq("hashedToken", args.hashedToken))
      .unique();
    if (row === null || row.chat === undefined || row.userId !== args.userId || row.workspaceId !== args.workspaceId) return null;
    const membership = await getMembership(ctx, args.workspaceId, args.userId);
    const people = await chatPeopleFor(ctx, args.workspaceId, row.chat, args.userId);
    return { label: chatLabel(people), people, canInvite: membership?.role === "owner" };
  },
});

/**
 * "Add" beside somebody in the chat who isn't in the workspace: an invitation to it by their handle, from the person
 * the link is for, who must own the workspace (`inviteMemberWithId`). Only a handle the link's chat names.
 */
export const inviteFromVaultLink = mutation({
  args: { token: v.string(), handle: v.string() },
  returns: v.union(v.literal("invited"), v.literal("already")),
  handler: async (ctx, args): Promise<"invited" | "already"> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw fail("NOT_AUTHENTICATED", "Sign in to continue.");
    if (typeof args.token !== "string" || args.token.length === 0 || args.token.length > 128) throw dead();
    const hashedToken = await hashToken(args.token);
    const row = await ctx.db
      .query("vaultRequests")
      .withIndex("by_hashed_token", (q) => q.eq("hashedToken", hashedToken))
      .unique();
    if (row === null || row.kind !== "add" || row.expiresAt <= Date.now() || row.chat === undefined) throw dead();
    if (row.userId !== userId) throw notYours();
    const named = (await chatPeopleFor(ctx, row.workspaceId, row.chat, userId as Id<"users">)).find((person) => person.handle === args.handle);
    if (named === undefined) throw fail("INVALID_ARGUMENT", "That person isn't in this chat.");
    if (named.status !== "not_member") return "already";
    const membership = await getMembership(ctx, row.workspaceId, userId as Id<"users">);
    if (membership?.role !== "owner") throw fail("NOT_ALLOWED", "Only an owner of this workspace can add people to it.");
    const id = await inviteMemberWithId(ctx, userId as Id<"users">, { workspaceId: row.workspaceId, invitee: `@${args.handle}`, role: "member" });
    return id === null ? "already" : "invited";
  },
});
