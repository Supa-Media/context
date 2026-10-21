/**
 * The link half of a connector: an agent asks, the person finishes it on a
 * signed-in page (`/connect/<provider>/<token>`), the way a vault link works
 * (`docs/decisions/connectors.md`).
 *
 * Split out of `functions/connections.ts`, which registers every function;
 * this module registers none and opens no credential.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { consumeRateLimit } from "../rateLimit";
import { getMembership } from "../workspaceAuth";
import { scopeForWorkspaceKind, type ConnectionScope, type ProviderId } from "../providers/registry";

/** The app page a connect link opens: `apps/mobile/app/connect/[provider]/[token].tsx`. */
export const CONNECT_LINK_ROUTE = "/connect";

/** As long as a vault link: long enough to find the phone, short enough to be no standing door. */
export const CONNECT_LINK_TTL_MS = 30 * 60 * 1000;

/** How long a started consent stays answerable. Ten minutes, as every connect flow. */
export const CONNECT_ATTEMPT_TTL_MS = 10 * 60 * 1000;

/** A steered agent cannot fill someone's phone with connect links. */
export const CONNECT_LINK_LIMIT = 10;
export const CONNECT_LINK_WINDOW_MS = 60 * 60 * 1000;

/** A Tex group chat's client: it never makes a connection, and never reaches one. */
export const TEXTS_GROUP_CLIENT_ID = "context_texts_group";

/**
 * An app connects for one person, in their own personal workspace (decided by
 * the owner, 2026-10-21: "it should just be 1 person for now"). A shared
 * workspace's connection, acting as the app's bot, stays modelled
 * (`scopeForWorkspaceKind`) but nothing can make one.
 */
export async function mayConnect(ctx: QueryCtx, workspaceId: Id<"workspaces">, userId: Id<"users">): Promise<Doc<"workspaces"> | null> {
  const membership = await getMembership(ctx, workspaceId, userId);
  if (membership === null || membership.role !== "owner") return null;
  const workspace = await ctx.db.get(workspaceId);
  if (workspace === null || workspace.kind !== "personal") return null;
  return workspace;
}

export async function issueLink(
  ctx: MutationCtx,
  args: { provider: ProviderId; workspaceId: Id<"workspaces">; userId: Id<"users">; clientId: string; hashedToken: string },
): Promise<"issued" | "refused"> {
  await consumeRateLimit(ctx, {
    key: `connect.link:${args.userId}`,
    limit: CONNECT_LINK_LIMIT,
    windowMs: CONNECT_LINK_WINDOW_MS,
  });
  const workspace = await mayConnect(ctx, args.workspaceId, args.userId);
  if (workspace === null) return "refused";
  // A group chat is steered by everyone in it, so it never makes anyone's own connection.
  if (args.clientId === TEXTS_GROUP_CLIENT_ID) return "refused";
  const now = Date.now();
  const stale = await ctx.db
    .query("providerConnectLinks")
    .withIndex("by_expires", (q) => q.lt("expiresAt", now))
    .take(20);
  for (const row of stale) await ctx.db.delete(row._id);
  await ctx.db.insert("providerConnectLinks", {
    hashedToken: args.hashedToken,
    provider: args.provider,
    workspaceId: args.workspaceId,
    userId: args.userId,
    clientId: args.clientId,
    expiresAt: now + CONNECT_LINK_TTL_MS,
  });
  return "issued";
}

export type LinkState =
  | { state: "ready"; link: Doc<"providerConnectLinks">; workspace: Doc<"workspaces">; scope: ConnectionScope }
  | { state: "expired" }
  | { state: "not_yours" };

/**
 * What a link (by its token's hash) is for the signed-in `userId`. Unknown,
 * spent and expired read the same, so a guessed token learns nothing; a live
 * link for somebody else says so, as a vault link does, so the person can
 * sign in as the right one.
 */
export async function linkForHashed(ctx: QueryCtx, hashedToken: string, userId: Id<"users">): Promise<LinkState> {
  const link = await ctx.db
    .query("providerConnectLinks")
    .withIndex("by_hashed_token", (q) => q.eq("hashedToken", hashedToken))
    .unique();
  return await stateOf(ctx, link, userId);
}

async function stateOf(ctx: QueryCtx, link: Doc<"providerConnectLinks"> | null, userId: Id<"users">): Promise<LinkState> {
  if (link === null || link.usedAt !== undefined || link.expiresAt < Date.now()) return { state: "expired" };
  if (link.userId !== userId) return { state: "not_yours" };
  // Their role may have changed since the agent asked.
  const workspace = await mayConnect(ctx, link.workspaceId, userId);
  if (workspace === null) return { state: "expired" };
  return { state: "ready", link, workspace, scope: scopeForWorkspaceKind(workspace.kind) };
}

