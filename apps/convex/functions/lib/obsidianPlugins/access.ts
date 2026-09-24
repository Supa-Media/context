/**
 * Who is asking and whether they may: the caller, the owner check, the
 * runtime token and session teardown, and the egress configuration.
 *
 * Split out of `functions/obsidianPlugins.ts`, which keeps every registered
 * plugin function; this module registers none.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { getMembership, workspaceNotFound } from "../workspaceAuth";
import { PLUGIN_EGRESS_SECRET_ENV, PLUGIN_EGRESS_URL_ENV } from "./limits";

export function pluginError(code: string, message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

export async function callerId(ctx: Parameters<typeof getAuthUserId>[0]): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw pluginError("NOT_AUTHENTICATED", "Sign in to continue");
  return userId as Id<"users">;
}

export type PluginEgressConfiguration = { endpoint: string; secret: string };

export function pluginEgressConfiguration(
  env: Record<string, string | undefined> = process.env,
): PluginEgressConfiguration | null {
  const rawUrl = env[PLUGIN_EGRESS_URL_ENV]?.trim() ?? "";
  const secret = env[PLUGIN_EGRESS_SECRET_ENV]?.trim() ?? "";
  if (!rawUrl || !secret) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return {
      endpoint: new URL("request", url.href.endsWith("/") ? url.href : `${url.href}/`).href,
      secret,
    };
  } catch {
    return null;
  }
}

export async function requireOwner(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<void> {
  const membership = await getMembership(ctx, workspaceId, userId);
  if (membership === null) throw workspaceNotFound();
  if (membership.role !== "owner") {
    throw pluginError("INSUFFICIENT_ROLE", "Only a context owner can manage plugins");
  }
}

export async function deleteRuntimeSessions(
  ctx: MutationCtx,
  sessions: Array<{ _id: Id<"obsidianPluginRuntimeSessions">; tokenHash: string }>,
): Promise<void> {
  for (const session of sessions) {
    const requests = await ctx.db
      .query("obsidianPluginRuntimeRequests")
      .withIndex("by_session_request", (q) => q.eq("tokenHash", session.tokenHash))
      .collect();
    for (const request of requests) await ctx.db.delete(request._id);
    await ctx.db.delete(session._id);
  }
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newRuntimeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
