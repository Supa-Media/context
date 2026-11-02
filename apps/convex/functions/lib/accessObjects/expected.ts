/**
 * What each access table should hold, read from Convex: the rows the copy
 * writes into the objects and the parity check compares them with
 * (`functions/accessObjects.ts`; decided by the owner, 2026-11-01, plan
 * "Access lives in the objects"). The row shapes are the contract's
 * (`apps/mcp/src/workspaceStore/access.js`, `check*Row`), and both sides
 * digest them with its `accessDigest`, which drops `at` and `lastUsedAt`.
 *
 * Workspace object, `workspace:<workspaceId>`: `members` and `invites`.
 * Person object, `workspace:<personalWorkspaceId>`: `reach`, `sharedToMe`
 * and `connections`.
 *
 * `at` is the copy's clock (`now`), so a newer write the object already took
 * is never rolled back. Connections and invites carry hashes (SHA-256 hex),
 * never a token. A row Convex holds that the contract cannot is skipped and
 * counted (`skipped`), never cut short silently.
 */

import { PINNED_CONTEXT_ROLE } from "@context/shared";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { personalWorkspaceOf } from "../faces/people";
import { isPending } from "../invitations/forCaller";
import { isDesktopShellClient } from "../machineGrant";
import { pinnedContextRow } from "../pinnedContext";
import { pinReaderNames } from "../pinnedReaders";
import { sharedWithUser } from "../shares/recipients";
import { CONVEX_ONLY_CLIENTS } from "../accessHandOff/record";

export type AccessTable = "members" | "invites" | "reach" | "sharedToMe" | "connections";
export const WORKSPACE_TABLES: readonly AccessTable[] = ["members", "invites"];
export const PERSON_TABLES: readonly AccessTable[] = ["reach", "sharedToMe", "connections"];

/** Members read per page: each costs a few reads (names, personal workspace), well inside one query's limits. */
export const MEMBERS_PER_PAGE = 100;
/** The most memberships, grants or invitations one copy reads; past this the copy throws, never cuts short. */
export const ROWS_CAP = 1000;
/** The most grant rows one person's copy walks, texting ones included: well inside one query's read limit. */
export const GRANTS_SCANNED_CAP = 8000;
/** Clients the person object never holds: their checks stay with the control plane (`accessHandOff/record.ts`). */
export const TEXTING_CLIENTS: ReadonlySet<string> = CONVEX_ONLY_CLIENTS;

type Row = Record<string, unknown>;
export interface Rows {
  rows: Row[];
  /** Rows Convex holds that the contract cannot: counted, never written. */
  skipped: number;
}

const capped = <T>(rows: T[], what: string): T[] => {
  if (rows.length > ROWS_CAP) throw new Error(`access rows: too many ${what}`);
  return rows;
};

/**
 * The names of `userId`'s groups in `workspaceId`, sorted. Group names only:
 * the person's own handle is added when a session is built (contract).
 */
export async function groupNames(ctx: QueryCtx, workspaceId: Id<"workspaces">, userId: Id<"users">, without?: Id<"workspaceGroups">): Promise<string[]> {
  const rows = capped(
    await ctx.db
      .query("workspaceGroupMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(ROWS_CAP + 1),
    "group rows",
  );
  const names = new Set<string>();
  for (const row of rows) {
    if (row.workspaceId !== workspaceId || row.groupId === without) continue;
    const group = await ctx.db.get(row.groupId);
    if (group !== null && group.workspaceId === workspaceId) names.add(group.name);
  }
  return [...names].sort();
}

/** One page of `workspaceId`'s members; a member with no personal workspace is skipped. */
export async function membersPage(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  cursor: string | null,
  now: number,
): Promise<Rows & { next: string | null }> {
  const page = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .paginate({ cursor, numItems: MEMBERS_PER_PAGE });
  const rows: Row[] = [];
  let skipped = 0;
  for (const member of page.page) {
    const row = await memberRow(ctx, member, now);
    if (row === null) skipped += 1;
    else rows.push(row);
  }
  return { rows, skipped, next: page.isDone ? null : page.continueCursor };
}

/** One member as the workspace object keeps them (leaving out group `without`), or `null` without a personal workspace. */
export async function memberRow(ctx: QueryCtx, member: Doc<"workspaceMembers">, now: number, without?: Id<"workspaceGroups">): Promise<Row | null> {
  const personal = await personalWorkspaceOf(ctx, member.userId);
  if (personal === null) return null;
  return {
    userId: String(member.userId),
    personalWorkspaceId: String(personal._id),
    role: member.role,
    groups: await groupNames(ctx, member.workspaceId, member.userId, without),
    at: now,
  };
}

/** One pending invitation as the workspace object keeps it, the link token as its hash. */
export async function inviteRow(invite: Doc<"workspaceInvitations">, now: number): Promise<Row> {
  return {
    id: String(invite._id),
    [invite.inviteeKind]: invite.invitee,
    role: invite.role,
    invitedBy: String(invite.invitedBy),
    expiresAt: invite.expiresAt,
    tokenHash: await hashToken(invite.token),
    at: now,
  };
}

/** Every pending, unexpired invitation to `workspaceId`, the link token as its hash. */
export async function invitesOf(ctx: QueryCtx, workspaceId: Id<"workspaces">, now: number): Promise<Rows> {
  const found = capped(
    await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspaceId).eq("status", "pending"))
      .take(ROWS_CAP + 1),
    "invites",
  );
  const rows: Row[] = [];
  for (const invite of found) if (isPending(invite, now)) rows.push(await inviteRow(invite, now));
  return { rows, skipped: 0 };
}

/**
 * Every workspace `userId` is a member of, with their role and their groups
 * there (`groupNames`), and the pinned workspace every account
 * reaches unless they are a real member there (`pinnedContextRow`,
 * `pinReaderNames`): the same set `liveGrants.ts` gives a session today.
 */
export async function reachOf(ctx: QueryCtx, userId: Id<"users">, now: number): Promise<Rows> {
  const memberships = capped(
    await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(ROWS_CAP + 1),
    "memberships",
  );
  const rows: Row[] = [];
  const covered = new Set<Id<"workspaces">>();
  for (const membership of memberships) {
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace === null) continue;
    covered.add(workspace._id);
    rows.push({
      workspaceId: String(workspace._id),
      slug: workspace.slug.toLowerCase(),
      kind: workspace.kind,
      role: membership.role,
      groups: await groupNames(ctx, workspace._id, userId),
      pinned: false,
      at: now,
    });
  }
  const pinned = await pinnedContextRow(ctx, covered);
  if (pinned !== null) {
    rows.push({
      workspaceId: String(pinned.workspaceId),
      slug: pinned.slug.toLowerCase(),
      kind: pinned.kind,
      role: PINNED_CONTEXT_ROLE,
      groups: (await pinReaderNames(ctx, pinned.workspaceId, userId)) ?? [],
      pinned: true,
      at: now,
    });
  }
  return { rows, skipped: 0 };
}

/**
 * What the "Shared with me" screen lists for `userId` (`sharedWithUser`), as
 * locators: a note by its id, a folder by its tree row's id. A by-name share
 * carries no role, so it is `view`; a grant's role is its row's.
 */
export async function sharedToMeOf(ctx: QueryCtx, userId: Id<"users">, now: number): Promise<Rows> {
  const items = await sharedWithUser(ctx, userId, now);
  const rows: Row[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const push = (row: Row, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };
  for (const item of items) {
    const from = item.workspaceId;
    if (item.kind === "grant") {
      const node = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_noteId", (q) => q.eq("workspaceId", from).eq("noteId", item.noteId))
        .first();
      if (node === null) {
        skipped += 1;
        continue;
      }
      const role = await grantRole(ctx, node._id, userId);
      const locator = item.itemKind === "folder" ? { folder: String(node._id) } : { noteId: item.noteId };
      push({ fromWorkspaceId: String(from), ...locator, role, at: now }, `${from}:${JSON.stringify(locator)}`);
      continue;
    }
    const node = await liveNodeAt(ctx, from, item.entryPath);
    if (node === null || (node.kind === "file" && node.noteId === undefined)) {
      skipped += 1;
      continue;
    }
    const locator = node.kind === "folder" ? { folder: String(node._id) } : { noteId: node.noteId as string };
    push({ fromWorkspaceId: String(from), ...locator, role: "view", at: now }, `${from}:${JSON.stringify(locator)}`);
  }
  return { rows, skipped };
}

/** The strongest role a row grants `userId` directly: `edit` if any grant on it says so, else `view`. */
async function grantRole(ctx: QueryCtx, nodeId: Id<"nodes">, userId: Id<"users">): Promise<"view" | "edit"> {
  const grants = capped(
    await ctx.db
      .query("nodeAccess")
      .withIndex("by_node", (q) => q.eq("nodeId", nodeId))
      .take(ROWS_CAP + 1),
    "grants on one row",
  );
  return grants.some((grant) => grant.granteeUserId === userId && grant.role === "edit") ? "edit" : "view";
}

/** The live row at `path` in `workspaceId`, or `null`. */
async function liveNodeAt(ctx: QueryCtx, workspaceId: Id<"workspaces">, path: string): Promise<Doc<"nodes"> | null> {
  const rows = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
    .take(10);
  return rows.find((row) => row.goneAt === undefined) ?? null;
}

/**
 * `userId`'s AI client connections, active and revoked (a revoked one is kept
 * so a reused refresh token is still named). Tex group chats' grants and the
 * texting clients stay with the control plane. A grant whose access token was
 * never minted has `tokenHash: null`; one with no expiry has `expiresAt: 0`.
 */
export async function connectionsOf(ctx: QueryCtx, userId: Id<"users">, now: number): Promise<Rows> {
  const names = new Map<string, { name: string | null; machine: boolean }>();
  const rows: Row[] = [];
  let skipped = 0;
  let scanned = 0;
  // Texting grants are minted per turn and can far outnumber a person's clients, so they are walked past, not capped on.
  for await (const grant of ctx.db.query("oauthGrants").withIndex("by_user", (q) => q.eq("userId", userId)) as AsyncIterable<Doc<"oauthGrants">>) {
    scanned += 1;
    if (scanned > GRANTS_SCANNED_CAP) throw new Error("access rows: too many grants to walk");
    if (grant.texGroup !== undefined || TEXTING_CLIENTS.has(grant.clientId)) continue;
    if (rows.length >= ROWS_CAP) throw new Error("access rows: too many grants");
    if (grant.scopes.length === 0) {
      skipped += 1;
      continue;
    }
    if (!names.has(grant.clientId)) {
      const client = await ctx.db
        .query("oauthClients")
        .withIndex("by_clientId", (q) => q.eq("clientId", grant.clientId))
        .first();
      names.set(grant.clientId, { name: client?.clientName ?? null, machine: client !== null && isDesktopShellClient(client) });
    }
    rows.push(connectionRow(grant, names.get(grant.clientId) ?? { name: null, machine: false }, now));
  }
  return { rows, skipped };
}

/** One grant as its person object keeps it (`apps/mcp/src/workspaceStore/access.js` `checkConnectionRow`). */
export function connectionRow(grant: Doc<"oauthGrants">, client: { name: string | null; machine: boolean }, now: number): Row {
  return {
    grantId: String(grant._id),
    clientId: grant.clientId,
    clientName: client.name,
    workspaceId: String(grant.workspaceId),
    scopes: [...grant.scopes],
    tokenHash: grant.hashedAccessToken ?? null,
    refreshHash: grant.hashedRefreshToken,
    previousRefreshHash: grant.previousHashedRefreshToken ?? null,
    expiresAt: grant.accessTokenExpiresAt ?? 0,
    status: grant.status,
    lastUsedAt: grant.lastUsedAt ?? null,
    createdAt: grant.createdAt,
    machine: client.machine,
    at: now,
  };
}
