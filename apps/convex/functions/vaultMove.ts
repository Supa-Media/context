/**
 * Moving a key out of a personal workspace into a shared one (vault sharing
 * board 5): a personal key can't be given to anybody, so its People section
 * offers the shared workspaces the person may add keys to, and moving it
 * there is what makes it giveable.
 *
 * The move is three of the barrier's own operations and nothing new: the
 * values are opened in the personal workspace (`reveal`, which only somebody
 * who sees the key passes), saved as a new key in the shared one (`add`,
 * sealed under that workspace's data key), and the personal copy deleted
 * (`delete`). Values pass through this action's memory only, as they do when
 * a person reveals a key; they are never returned or logged.
 *
 * What does not move: the AIs' yeses, one-time grants, uses and refusals.
 * They were given for the personal workspace; in the shared one the person's
 * AIs ask again the first time, as for any new key there.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, query } from "../_generated/server";
import { newEntryId, isEntryId } from "../../mcp/src/vault/entries.js";
import type { Shown } from "./lib/vaultShapes";
import { workspaceNotFound } from "./lib/workspaceAuth";
import { runVault } from "./vault";

const fail = (code: string, message: string) => new ConvexError({ code, message });

/** The shared workspaces the signed-in person may move a key into: those they own or edit. */
export const vaultMoveTargets = query({
  args: {},
  returns: v.array(v.object({ workspaceId: v.id("workspaces"), handle: v.string(), name: v.string() })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(200);
    const out = [];
    for (const membership of memberships) {
      if (membership.role === "member") continue;
      const workspace = await ctx.db.get(membership.workspaceId);
      if (workspace === null || workspace.kind !== "shared") continue;
      out.push({ workspaceId: workspace._id, handle: workspace.slug, name: workspace.displayName ?? workspace.slug });
    }
    return out.sort((a, b) => a.handle.localeCompare(b.handle));
  },
});

/**
 * Move a key from the person's own workspace into a shared one they own or
 * edit. Only whoever saved it may move it. Answers the key's id in the shared
 * workspace.
 */
export const moveVaultKey = action({
  args: { workspaceId: v.id("workspaces"), entryId: v.string(), toWorkspaceId: v.id("workspaces") },
  returns: v.object({ entryId: v.string(), workspaceId: v.id("workspaces"), handle: v.string() }),
  handler: async (ctx, args): Promise<{ entryId: string; workspaceId: Id<"workspaces">; handle: string }> => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) throw fail("NOT_AUTHENTICATED", "Sign in to continue.");
    if (!isEntryId(args.entryId)) throw fail("INVALID_ARGUMENT", "There is no such key.");
    const from = await ctx.runQuery(internal.functions.contextPlugins.membershipFor, { workspaceId: args.workspaceId, userId });
    if (from === null) throw workspaceNotFound();
    const to = await ctx.runQuery(internal.functions.contextPlugins.membershipFor, { workspaceId: args.toWorkspaceId, userId });
    const kinds = {
      from: await ctx.runQuery(internal.functions.vaultPeople.workspaceKind, { workspaceId: args.workspaceId }),
      to: await ctx.runQuery(internal.functions.vaultPeople.workspaceKind, { workspaceId: args.toWorkspaceId }),
    };
    if (kinds.from !== "personal") throw fail("INVALID_ARGUMENT", "Only a key in your personal workspace can be moved.");
    if (to === null || to.role === "member" || kinds.to !== "shared") {
      throw fail("FORBIDDEN", "Pick a shared workspace you own or edit.");
    }
    const groups = await ctx.runQuery(internal.functions.vaultPeople.accessNames, { workspaceId: args.workspaceId, userId });
    const opened = (await runVault(
      ctx,
      args.workspaceId,
      { kind: "reveal", entryId: args.entryId, userId: String(userId), groups },
      "That wasn't moved: your workspace's storage didn't answer.",
    )) as Shown | null;
    if (opened === null || opened.revealed === undefined || opened.meta.createdBy !== String(userId)) {
      throw fail("FORBIDDEN", "Only whoever saved this key can move it.");
    }
    const pin = opened.meta.proxy;
    const entryId = newEntryId() as string;
    await runVault(
      ctx,
      args.toWorkspaceId,
      {
        kind: "add",
        entryId,
        userId: String(userId),
        type: opened.meta.type,
        name: opened.meta.name,
        sites: opened.meta.sites,
        username: opened.revealed.username,
        password: opened.revealed.password,
        fields: opened.revealed.fields,
        ...(pin
          ? {
              proxy: {
                host: pin.host,
                style: pin.style,
                ask: pin.ask,
                ...(pin.name ? { name: pin.name } : {}),
                ...(pin.prefix ? { prefix: pin.prefix } : {}),
              },
            }
          : {}),
      },
      "That wasn't moved: the shared workspace's storage didn't take it. Your key is still where it was.",
    );
    const deleted = await runVault(
      ctx,
      args.workspaceId,
      { kind: "delete", entryId: args.entryId, userId: String(userId), groups, anyKey: true },
      "The key is now in the shared workspace, but the copy in your personal workspace couldn't be deleted. Delete it there.",
    );
    const handle: string = (await ctx.runQuery(internal.functions.vaultPeople.workspaceHandle, { workspaceId: args.toWorkspaceId })) ?? "";
    const fromHandle: string = (await ctx.runQuery(internal.functions.vaultPeople.workspaceHandle, { workspaceId: args.workspaceId })) ?? "";
    await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
      workspaceId: args.toWorkspaceId,
      actorUserId: userId,
      action: "vault.moved",
      entryId,
      changed: `from @${fromHandle}`,
    });
    if (deleted !== null) {
      await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
        workspaceId: args.workspaceId,
        actorUserId: userId,
        action: "vault.moved",
        entryId: args.entryId,
        changed: `to @${handle}`,
      });
    }
    return { entryId, workspaceId: args.toWorkspaceId, handle };
  },
});
