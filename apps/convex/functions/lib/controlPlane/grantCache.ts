/**
 * Reuse the workspace list a token resolved to, and skip the access snapshot,
 * while nothing that list was built from has changed.
 *
 * `resolveGrantByAccessToken` and `readClearance` each read that snapshot
 * (about 60 GB and 40 GB from Oct 18 to Nov 17). The snapshot is the rows a
 * name grant is read from. Everything else the list depends on — the grant,
 * memberships, groups, handles, emails, and the access version — is small.
 * A hit reads those and the saved list. A miss reads the snapshot, as before,
 * and the session route saves the list.
 *
 * Revocation is the same check as a full resolve. A revoked or expired grant
 * is refused before the saved list is considered. A membership, group, handle,
 * email, or access version that moved makes a different fingerprint, and the
 * list is built again. A group chat's grant and a run grant are never saved:
 * their reach is not this membership list.
 */

import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { putAccessVersion } from "../nodes/accessBackfill";
import { accessVersionOf } from "../nodes/accessRows";
import { pinnedContextWorkspace } from "../pinnedContext";
import { pinReadersAreGuests } from "../pinnedReaders";
import { identifiersForUser, resolveAddressedUser } from "../identities";
import { ownedConfirmedEmailsOf } from "../signInEmails";
import { MAX_SESSION_CONTEXTS, contextsForGrant, resolveLiveGrant, type LiveGrant } from "./liveGrants";
import { TEXTS_GROUP_CLIENT_ID } from "../../textGroups";
import type { RunGrantInfo } from "./liveGrants";

/** The same bound `grantedNamesFor` uses for group rows. */
const MAX_GROUPS = 100;

type WorkspaceRow = {
  workspaceId: Id<"workspaces">;
  slug: string;
  role: string;
  kind: "personal" | "shared";
  grantedNames?: string[];
  setupOnly?: true;
  chatHome?: string;
  homeOnly?: true;
};

export type GrantRemember = {
  hashedAccessToken: string;
  fingerprint: string;
  versions: { workspaceId: Id<"workspaces">; version: number }[];
  workspaces: WorkspaceRow[];
};

type Live = LiveGrant & { run?: RunGrantInfo };

const fnv = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
};

function cacheable(live: { run?: unknown; grant: { clientId: string } }): boolean {
  return live.run === undefined && live.grant.clientId !== TEXTS_GROUP_CLIENT_ID;
}

const workspaceValidator = v.object({
  workspaceId: v.id("workspaces"),
  slug: v.string(),
  role: v.string(),
  kind: v.union(v.literal("personal"), v.literal("shared")),
  grantedNames: v.optional(v.array(v.string())),
  setupOnly: v.optional(v.literal(true)),
  chatHome: v.optional(v.string()),
  homeOnly: v.optional(v.literal(true)),
});

export const rememberGrantResolveArgs = {
  hashedAccessToken: v.string(),
  fingerprint: v.string(),
  versions: v.array(v.object({ workspaceId: v.id("workspaces"), version: v.number() })),
  workspaces: v.array(workspaceValidator),
};

export const rememberGrantResolveReturns = v.null();

async function workspaceIds(ctx: QueryCtx, live: Live): Promise<Id<"workspaces">[]> {
  const ids = new Set<Id<"workspaces">>([live.grant.workspaceId]);
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", live.grant.userId))
    .take(MAX_SESSION_CONTEXTS);
  for (const membership of memberships) ids.add(membership.workspaceId);
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned !== null) ids.add(pinned._id);
  return [...ids].sort();
}

/** `null` when a workspace has no small version row yet: the list cannot be reused until one is recorded. */
async function fingerprintOf(
  ctx: QueryCtx,
  live: Live,
  overrides?: Map<Id<"workspaces">, number>,
): Promise<string | null> {
  const versions: string[] = [];
  for (const workspaceId of await workspaceIds(ctx, live)) {
    const over = overrides?.get(workspaceId);
    if (over !== undefined) {
      versions.push(`${workspaceId}:${over}`);
      continue;
    }
    const small = await ctx.db
      .query("nodeAccessVersions")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (small === null) return null;
    versions.push(`${workspaceId}:${small.version}`);
  }

  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", live.grant.userId))
    .take(MAX_SESSION_CONTEXTS);
  const membershipKey = memberships.map((row) => `${row.workspaceId}:${row.role}`).sort();

  const groupKey: string[] = [];
  const groups = await ctx.db
    .query("workspaceGroupMembers")
    .withIndex("by_user", (q) => q.eq("userId", live.grant.userId))
    .take(MAX_GROUPS);
  for (const row of groups) {
    const group = await ctx.db.get(row.groupId);
    groupKey.push(`${row.workspaceId}:${row.groupId}:${group?.name ?? ""}`);
  }
  groupKey.sort();

  const names: string[] = [];
  for (const identifier of await identifiersForUser(ctx, live.grant.userId)) {
    if (identifier.kind !== "name") continue;
    if ((await resolveAddressedUser(ctx, identifier)) !== live.grant.userId) continue;
    names.push(identifier.value);
  }
  names.sort();

  const emails = (await ownedConfirmedEmailsOf(ctx, live.grant.userId)).slice().sort();
  const text = JSON.stringify({
    status: live.grant.status,
    scopes: [...live.grant.scopes].sort(),
    exp: live.grant.accessTokenExpiresAt,
    workspaceId: live.grant.workspaceId,
    clientId: live.grant.clientId,
    membershipKey,
    groupKey,
    names,
    emails,
    versions,
    guests: await pinReadersAreGuests(ctx.db),
  });
  return fnv(text);
}

/**
 * The workspaces this grant reaches. The saved list when the fingerprint still
 * matches, otherwise a fresh `contextsForGrant` and what the session route
 * should save.
 */
export async function loadGrantWorkspaces(
  ctx: QueryCtx,
  hashedAccessToken: string,
  live: Live,
): Promise<{ workspaces: WorkspaceRow[]; remember: GrantRemember | null }> {
  if (!cacheable(live)) return { workspaces: await contextsForGrant(ctx, live), remember: null };
  const saved = await fingerprintOf(ctx, live);
  if (saved !== null) {
    const row = await ctx.db
      .query("grantResolveCache")
      .withIndex("by_token", (q) => q.eq("hashedAccessToken", hashedAccessToken))
      .unique();
    if (row !== null && row.fingerprint === saved) return { workspaces: row.workspaces, remember: null };
  }
  const workspaces = await contextsForGrant(ctx, live);
  const versions: { workspaceId: Id<"workspaces">; version: number }[] = [];
  for (const workspaceId of await workspaceIds(ctx, live)) {
    versions.push({ workspaceId, version: await accessVersionOf(ctx, workspaceId) });
  }
  const overrides = new Map(versions.map((item) => [item.workspaceId, item.version] as const));
  const fingerprint = await fingerprintOf(ctx, live, overrides);
  if (fingerprint === null) return { workspaces, remember: null };
  return { workspaces, remember: { hashedAccessToken, fingerprint, versions, workspaces } };
}

export async function rememberGrantResolveHandler(
  ctx: MutationCtx,
  args: GrantRemember,
): Promise<null> {
  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  if (live === null || !cacheable(live)) return null;
  for (const item of args.versions) await putAccessVersion(ctx, item.workspaceId, item.version);
  const fingerprint = await fingerprintOf(ctx, live);
  if (fingerprint === null || fingerprint !== args.fingerprint) return null;
  const existing = await ctx.db
    .query("grantResolveCache")
    .withIndex("by_token", (q) => q.eq("hashedAccessToken", args.hashedAccessToken))
    .unique();
  const row = { hashedAccessToken: args.hashedAccessToken, fingerprint, workspaces: args.workspaces };
  if (existing === null) await ctx.db.insert("grantResolveCache", row);
  else await ctx.db.patch(existing._id, { fingerprint: row.fingerprint, workspaces: row.workspaces });
  return null;
}
