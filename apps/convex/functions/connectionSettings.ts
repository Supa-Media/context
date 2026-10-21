/**
 * Apps in Settings: every app Tex can reach through its own connection, where
 * the signed-in person stands in each, and a Connect button that needs no
 * text to Tex (`docs/decisions/connectors.md`).
 *
 * Connect mints the same one-use, 30-minute link Tex sends, for the person
 * pressing it, and the app opens it at once: from there it is the one flow
 * every connection goes through (`/connect/<app>/<token>`). Disconnect is
 * `connections.disconnectConnection`.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalMutation, query } from "../_generated/server";
import { hashToken } from "./lib/crypto";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { requireActor } from "./lib/googleConnect/config";
import { appCatalog } from "./lib/connections/catalog";
import { issueLink } from "./lib/connections/links";
import { providerValidator } from "./lib/providers/ids";
import { providerAvailable, providerOf } from "./lib/providers/registry";

/** Who asked for a link, in the link's own row and its audit: the Settings page, not an agent. */
export const SETTINGS_CLIENT_ID = "context_settings";

const appState = v.union(v.literal("connected"), v.literal("reconnect"), v.literal("not_connected"), v.literal("not_available"));

/**
 * The person's apps in one workspace. Only an owner's personal workspace
 * connects anything, so anywhere else the list is empty and Settings shows
 * no section.
 */
export const myApps = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(
    v.object({
      app: providerValidator,
      name: v.string(),
      about: v.string(),
      state: appState,
      account: v.optional(v.string()),
      connectionId: v.optional(v.id("providerConnections")),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await requireActor(ctx);
    const apps = await appCatalog(ctx, args.workspaceId, userId, SETTINGS_CLIENT_ID);
    if (apps.every((entry) => entry.state === "not_available")) return [];
    return apps.map(({ via: _via, ...entry }) => entry);
  },
});

export const issueSettingsLink = internalMutation({
  args: { provider: providerValidator, workspaceId: v.id("workspaces"), userId: v.id("users"), hashedToken: v.string() },
  returns: v.union(v.literal("issued"), v.literal("refused")),
  handler: async (ctx, args) => await issueLink(ctx, { ...args, clientId: SETTINGS_CLIENT_ID }),
});

/** A connect link for the signed-in person, opened in the app at once. */
export const startAppConnect = action({
  args: { workspaceId: v.id("workspaces"), provider: providerValidator },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, args): Promise<{ token: string }> => {
    const userId = await requireActor(ctx);
    const spec = providerOf(args.provider);
    if (spec === null || !providerAvailable(spec)) {
      throw new ConvexError({ code: "CONNECTOR_UNAVAILABLE", message: "Connecting this app is not set up on this deployment." });
    }
    const token = randomOpaqueToken(24);
    const status = await ctx.runMutation(internal.functions.connectionSettings.issueSettingsLink, {
      provider: args.provider,
      workspaceId: args.workspaceId,
      userId,
      hashedToken: await hashToken(token),
    });
    if (status !== "issued") {
      throw new ConvexError({ code: "FORBIDDEN", message: "Apps connect from your own workspace, as its owner." });
    }
    return { token };
  },
});
