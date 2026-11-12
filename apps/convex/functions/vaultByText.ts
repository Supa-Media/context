/**
 * Who a vault login is for, read and changed by text (Dev2, 2026-11-12: "I should be able to say share with x person as
 * well, or share with the workspace and it just works"; `docs/decisions/texting-assistant/settings-by-text.md`).
 *
 * The person acting comes off the turn's own grant, never from what the model names: a person's own texting grant is
 * theirs, and a group chat's grant counts only on the token minted for the tagger's own tag (`ownTagOf`), so nobody in a
 * chat can change a login by tagging Tex on somebody else's turn. The changes themselves are the vault's own
 * (`lib/vaultPeople.ts` `giveKey` / `takeKey` / `cutClients`), with `anyKey: false`: by text, only whoever saved a
 * login changes who has it (Dev2 chose "on the saver's own words", 2026-11-12). Values never come back.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { resolveLiveGrant, contextsForGrant, texChatIdOf } from "./lib/controlPlane/liveGrants";
import { gatewayEditorClearance, ownTagOf } from "./lib/controlPlane/session";
import { getMembership } from "./lib/workspaceAuth";
import { chatLabel, chatPeopleFor, requestChatOf, requestChatValidator } from "./lib/vaultChat";
import { TEXTS_CLIENT_ID } from "./textLinks";
import { TEXTS_GROUP_CLIENT_ID } from "./textGroups";

const actorValidator = v.union(
  v.null(),
  v.object({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    kind: v.union(v.literal("personal"), v.literal("shared")),
    /** The group chat the turn is in, with its people, or null in a person's own chat. */
    chat: v.union(v.null(), requestChatValidator),
  }),
);

/**
 * The person a texted turn acts for, in the workspace the gateway named: a person's own chat, or the tagger's own tag
 * in a group chat. Null for any other client, a token kept beside a newer tag, or a workspace they can't edit.
 */
export const textActor = internalQuery({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: actorValidator,
  handler: async (ctx, args) => {
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    if (live === null) return null;
    const workspaceId = gatewayEditorClearance({ scopes: live.grant.scopes, workspaces: await contextsForGrant(ctx, live) }, args.expectedWorkspaceId);
    if (workspaceId === null) return null;
    const workspace = await ctx.db.get(workspaceId);
    if (workspace === null) return null;
    if (live.grant.clientId === TEXTS_CLIENT_ID && live.grant.texGroup === undefined) {
      return { workspaceId, userId: live.grant.userId, kind: workspace.kind, chat: null };
    }
    if (live.grant.clientId !== TEXTS_GROUP_CLIENT_ID) return null;
    const chatId = await texChatIdOf(ctx, live);
    const tagger = ownTagOf(live, chatId, args.hashedAccessToken).texTaggerId;
    if (tagger === undefined || (await getMembership(ctx, workspaceId, tagger)) === null) return null;
    return { workspaceId, userId: tagger, kind: workspace.kind, chat: await requestChatOf(ctx, live.grant, chatId ?? undefined) };
  },
});

/** A member of the workspace by their handle, never the person acting: null when there's none. */
export const memberByHandle = internalQuery({
  args: { workspaceId: v.id("workspaces"), handle: v.string(), except: v.id("users") },
  returns: v.union(v.null(), v.id("users")),
  handler: async (ctx, args): Promise<Id<"users"> | null> => {
    const handle = args.handle.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9-]{2,32}$/.test(handle)) return null;
    const name = await ctx.db
      .query("names")
      .withIndex("by_name", (q) => q.eq("name", handle))
      .unique();
    // A person's handle is their own name, or their personal workspace's slug (`vaultChat.ts` `personOf`).
    let userId: Id<"users"> | null = name?.kind === "user" && name.userId !== undefined ? name.userId : null;
    if (userId === null && name?.kind === "workspace" && name.workspaceId !== undefined) {
      const personal = await ctx.db.get(name.workspaceId);
      userId = personal?.kind === "personal" ? personal.createdBy : null;
    }
    if (userId === null || userId === args.except) return null;
    return (await getMembership(ctx, args.workspaceId, userId)) === null ? null : userId;
  },
});

/** A group chat's name for the vault's people list (its people by name, never a number). */
export const chatShareLabel = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users"), chat: requestChatValidator },
  returns: v.string(),
  handler: async (ctx, args) => chatLabel(await chatPeopleFor(ctx, args.workspaceId, args.chat, args.userId)),
});
