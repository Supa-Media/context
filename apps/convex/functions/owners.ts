/**
 * Who can own a project: the search behind a folder page's owner picker.
 *
 * An owner line (`owner:` in a note's frontmatter) names a person in the
 * workspace, an agent connected to it, or "any agent". The picker offers only
 * those, and asks here for them as the person types, so a workspace with a
 * hundred members sends back the eight that match rather than the roster.
 * Ranking is `lib/owners/rank.ts`.
 *
 * ## What it discloses, and to whom
 *
 * People: names and addresses of this workspace's members, to a member — the
 * same fact `workspaces.listMembers` already gives them, and nothing about
 * anybody outside it. A non-member gets `workspaceNotFound`, identical to a
 * workspace that does not exist.
 *
 * Agents: the names of connected AI clients, drawn **only from the grants the
 * caller could already list** with `grants.listGrants` — every grant for the
 * workspace's owner, their own for anybody else. A colleague's tooling is
 * theirs to disclose (see `listGrants`), and an owner picker is not a way
 * round that. Only the client's name leaves: never who connected it, when,
 * or with what scopes. The console's own grant is not an agent anybody means.
 */

import { v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireWorkspaceAccess } from "./lib/workspaceAuth";
import { CONSOLE_CLIENT_ID } from "./agentGrant";
import { matchAgents, rankMembers, type OwnerMember } from "./lib/owners/rank";

/**
 * The most memberships one search reads. Far past any workspace this product
 * has, and a bound on a read whose size is otherwise set by whoever can invite.
 */
export const MAX_OWNER_SCAN = 1000;
/** The most grants one search reads for agent names. */
const MAX_GRANT_SCAN = 200;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_AGENTS = 6;
const MAX_TEXT = 80;
const MAX_PREFER = 12;

/**
 * A name as one line an owner field can hold. Names are what their holders
 * typed, and an agent's is whatever its client registered as, so control
 * characters and line breaks go before either is offered to be written.
 */
function oneLine(text: string | undefined): string | undefined {
  const line = text?.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return line === "" ? undefined : line;
}

export const searchOwners = query({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.string(),
    /** Owner words the caller's folder already uses, most used first. */
    prefer: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    people: v.array(v.object({ value: v.string(), email: v.optional(v.string()), isMe: v.boolean() })),
    agents: v.array(v.string()),
    /** The workspace has more members than one search reads. */
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const { membership } = await requireWorkspaceAccess(ctx, args.workspaceId, userId);

    const text = args.query.slice(0, MAX_TEXT);
    const prefer = (args.prefer ?? []).slice(0, MAX_PREFER).map((word) => word.slice(0, MAX_TEXT));
    const asked = Number.isFinite(args.limit) ? Math.floor(args.limit as number) : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, asked));

    const rows = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(MAX_OWNER_SCAN + 1);
    const truncated = rows.length > MAX_OWNER_SCAN;
    const members: OwnerMember[] = [];
    for (const row of rows.slice(0, MAX_OWNER_SCAN)) {
      const user = await ctx.db.get(row.userId);
      const name = oneLine(user?.name);
      const email = oneLine(user?.email);
      const value = name ?? email;
      if (value === undefined) continue;
      members.push({ value, name, email, isMe: row.userId === userId });
    }
    const people = rankMembers(members, text, prefer, limit).map((member) => ({
      value: member.value,
      ...(member.email === undefined || member.email === member.value ? {} : { email: member.email }),
      isMe: member.isMe,
    }));

    const grants: Doc<"oauthGrants">[] =
      membership.role === "owner"
        ? await ctx.db
            .query("oauthGrants")
            .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
            .order("desc")
            .take(MAX_GRANT_SCAN)
        : await ctx.db
            .query("oauthGrants")
            .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", userId))
            .order("desc")
            .take(MAX_GRANT_SCAN);
    const live = grants
      .filter((grant) => grant.status === "active" && grant.clientId !== CONSOLE_CLIENT_ID)
      .sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
    const names: string[] = [];
    const looked = new Set<string>();
    for (const grant of live) {
      if (looked.has(grant.clientId)) continue;
      looked.add(grant.clientId);
      const client = await ctx.db
        .query("oauthClients")
        .withIndex("by_clientId", (q) => q.eq("clientId", grant.clientId))
        .unique();
      const name = oneLine(client?.clientName);
      if (name) names.push(name);
    }

    return { people, agents: matchAgents(names, text, MAX_AGENTS), truncated };
  },
});
