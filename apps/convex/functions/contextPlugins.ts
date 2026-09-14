/**
 * The built-in Context plugins, from the console.
 *
 * Two functions over one bucket file. The catalogue and the resolver are the
 * gateway's — `apps/mcp/src/plugins/catalog.js` and `enablement.js`, reached
 * through `runFileOperation` — for the reason `forms.ts` gives about the form
 * format: one definition, two callers, or a console and a connected client end
 * up disagreeing about the same context.
 *
 * ## Reading is a member's, changing is an owner's
 *
 * `listPlugins` is deliberately not owner-gated, unlike the Obsidian inventory
 * beside it. That one hands back bundle internals and the hosts a plugin
 * names, which is why it is owner-only; this one says which product features a
 * context has, and a member who cannot see that is a member who reports "the
 * form isn't there" as a bug. What it never says is anything about the bucket
 * beyond the five ids this build ships.
 *
 * `setPluginEnabled` is an owner's, and audited. It changes what every
 * connected client of every member can do, which is the same class of decision
 * as a grant.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import {
  action,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { getMembership, workspaceNotFound } from "./lib/workspaceAuth";

const contextPluginValidator = v.object({
  id: v.string(),
  name: v.string(),
  description: v.string(),
  version: v.string(),
  author: v.string(),
  enabled: v.boolean(),
  defaultEnabled: v.boolean(),
  tools: v.array(v.string()),
  surfaces: v.array(v.string()),
  offMeans: v.string(),
});

const listResultValidator = v.object({
  plugins: v.array(contextPluginValidator),
  settingsError: v.union(v.string(), v.null()),
  /** Whether this caller may work the switches, so the console can say why not. */
  canManage: v.boolean(),
});

type ContextPluginRow = {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  enabled: boolean;
  defaultEnabled: boolean;
  tools: string[];
  surfaces: string[];
  offMeans: string;
};

type ListResult = {
  plugins: ContextPluginRow[];
  settingsError: string | null;
  canManage: boolean;
};

function pluginError(code: string, message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

async function callerId(ctx: ActionCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw pluginError("UNAUTHENTICATED", "Sign in first.");
  return userId;
}

/**
 * The role this caller holds, or nothing at all.
 *
 * Routed through an existing internal query rather than reading the table from
 * an action, and it throws the same `workspaceNotFound` every other path does:
 * a workspace somebody is not a member of must not be distinguishable from one
 * that does not exist.
 */
async function roleFor(ctx: ActionCtx, workspaceId: Id<"workspaces">, userId: Id<"users">) {
  const membership = await ctx.runQuery(internal.functions.contextPlugins.membershipFor, {
    workspaceId,
    userId,
  });
  if (membership === null) throw workspaceNotFound();
  return membership.role;
}

export const membershipFor = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users") },
  returns: v.union(
    v.object({ role: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")) }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const membership = await getMembership(ctx, args.workspaceId, args.userId);
    return membership === null ? null : { role: membership.role };
  },
});

/** Which built-in plugins this context has, and which of them are on. */
export const listPlugins = action({
  args: { workspaceId: v.id("workspaces") },
  returns: listResultValidator,
  handler: async (ctx, args): Promise<ListResult> => {
    const userId = await callerId(ctx);
    const role = await roleFor(ctx, args.workspaceId, userId);
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      // The switches are a property of the context, not of a visibility tier,
      // and this operation reads one small object outside the privacy
      // manifest's reach. `team` is the narrower of the two and is enough.
      scope: "team" as const,
      operation: { kind: "contextPlugins" as const },
    });
    if (result.kind !== "contextPlugins") {
      throw pluginError("UNEXPECTED_RESULT", "That context's plugins could not be read.");
    }
    return {
      plugins: result.plugins,
      settingsError: result.settingsError,
      canManage: role === "owner",
    };
  },
});

/**
 * Turn one built-in on or off.
 *
 * The bucket is the record; this is the door. Audited under the acting
 * identity, because "who turned forms off for everybody" is exactly the
 * question an audit trail exists to answer, and the plugin id and the
 * direction are the whole of what is worth keeping.
 */
export const setPluginEnabled = action({
  args: {
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    enabled: v.boolean(),
  },
  returns: listResultValidator,
  handler: async (ctx, args): Promise<ListResult> => {
    const userId = await callerId(ctx);
    const role = await roleFor(ctx, args.workspaceId, userId);
    if (role !== "owner") {
      throw pluginError("INSUFFICIENT_ROLE", "Only a context owner can turn plugins on or off.");
    }
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "team" as const,
      operation: {
        kind: "contextPluginSet" as const,
        pluginId: args.pluginId,
        enabled: args.enabled,
      },
    });
    if (result.kind !== "contextPlugins") {
      throw pluginError("UNEXPECTED_RESULT", "That change could not be saved.");
    }
    await ctx.runMutation(internal.functions.contextPlugins.recordSwitch, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      pluginId: args.pluginId,
      enabled: args.enabled,
    });
    return { plugins: result.plugins, settingsError: result.settingsError, canManage: true };
  },
});

export const recordSwitch = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    pluginId: v.string(),
    enabled: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: args.enabled ? "plugin.enabled" : "plugin.disabled",
      details: { pluginId: args.pluginId },
    });
    return null;
  },
});
