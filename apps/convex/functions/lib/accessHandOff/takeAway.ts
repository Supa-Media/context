/**
 * Deletions that take access away, once that access is decided in the objects
 * (decided by the owner, 2026-11-01:
 * `docs/decisions/identity-and-access/access-in-objects.md`). A mutation
 * cannot call an object, and the object is the authority, so deleting an
 * account or a workspace whose access is switched is queued here instead of
 * run: `functions/accessTakeAway.ts` removes the members and invites and
 * revokes the connections in the objects first, then deletes Convex's rows
 * behind them. Nobody is let in by an object while Convex already says they
 * are gone, and Convex never says gone before an object does.
 *
 * Every scope the deletion touches whose home is `dual` or `object` gets its
 * object step, so a `dual` object is never left holding someone the deletion
 * removed; only an `object` scope makes the deletion wait for the queue.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import { internal } from "../../../_generated/api";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { accessHomeOf, type AccessHome } from "../accessObjects/home";
import { personalWorkspaceOf } from "../faces/people";
import { soleOwnerOf } from "../account/soleOwner";
import { CONVEX_ONLY_CLIENTS } from "./record";

export type TakeAwayTarget =
  | { kind: "account"; userId: Id<"users"> }
  | { kind: "workspace"; workspaceId: Id<"workspaces"> }
  | { kind: "leave"; userId: Id<"users">; workspaceIds: Id<"workspaces">[] };

/** One object's part of a deletion. Ids only. */
export type TakeAwayStep =
  | {
      scope: "workspace";
      workspaceId: Id<"workspaces">;
      home: AccessHome;
      userIds: string[];
      inviteIds: string[];
      /** A member row to put first (a fold's account moved into), with the workspace's name. */
      put?: { row: Record<string, unknown>; workspace: { slug: string; kind: string } };
    }
  | { scope: "person"; workspaceId: Id<"workspaces">; home: AccessHome; grantIds: string[] };

/** Everyone in a workspace that is going away, and its invitations still open. */
async function wholeWorkspace(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<{ userIds: Id<"users">[]; inviteIds: string[] }> {
  const members = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  const invites = await ctx.db
    .query("workspaceInvitations")
    .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspaceId).eq("status", "pending"))
    .collect();
  return { userIds: members.map((member) => member.userId), inviteIds: invites.map((invite) => String(invite._id)) };
}

const heldByObject = (grant: Doc<"oauthGrants">) => grant.status === "active" && grant.texGroup === undefined && !CONVEX_ONLY_CLIENTS.has(grant.clientId);

/**
 * The object steps a deletion needs, with each scope's home. Grants made at a
 * workspace that is going away are revoked in their people's objects too: a
 * connection whose default workspace no longer exists must not resolve.
 */
export async function takeAwaySteps(ctx: QueryCtx, target: TakeAwayTarget): Promise<TakeAwayStep[]> {
  const removed = new Map<Id<"workspaces">, { userIds: Set<string>; inviteIds: Set<string> }>();
  const revoked = new Map<Id<"users">, Set<string>>();
  const revoke = (grant: Doc<"oauthGrants">) => {
    if (!heldByObject(grant)) return;
    const held = revoked.get(grant.userId) ?? new Set<string>();
    held.add(String(grant._id));
    revoked.set(grant.userId, held);
  };
  const deleting: Id<"workspaces">[] = [];

  if (target.kind === "workspace") {
    deleting.push(target.workspaceId);
  } else if (target.kind === "leave") {
    for (const workspaceId of target.workspaceIds) removed.set(workspaceId, { userIds: new Set([String(target.userId)]), inviteIds: new Set() });
  } else {
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", target.userId))
      .collect();
    for (const membership of memberships) {
      if (await soleOwnerOf(ctx, membership, target.userId)) deleting.push(membership.workspaceId);
      else removed.set(membership.workspaceId, { userIds: new Set([String(target.userId)]), inviteIds: new Set() });
    }
    for (const grant of await ctx.db
      .query("oauthGrants")
      .withIndex("by_user", (q) => q.eq("userId", target.userId))
      .collect()) {
      revoke(grant);
    }
  }
  for (const workspaceId of deleting) {
    const whole = await wholeWorkspace(ctx, workspaceId);
    removed.set(workspaceId, { userIds: new Set(whole.userIds.map(String)), inviteIds: new Set(whole.inviteIds) });
    for (const grant of await ctx.db
      .query("oauthGrants")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect()) {
      revoke(grant);
    }
  }

  const steps: TakeAwayStep[] = [];
  for (const [workspaceId, { userIds, inviteIds }] of removed) {
    const home = await accessHomeOf(ctx.db, workspaceId, "workspace");
    if (home !== "convex") steps.push({ scope: "workspace", workspaceId, home, userIds: [...userIds].sort(), inviteIds: [...inviteIds].sort() });
  }
  for (const [userId, grantIds] of revoked) {
    const personal = await personalWorkspaceOf(ctx, userId);
    if (personal === null) continue;
    const home = await accessHomeOf(ctx.db, personal._id, "person");
    if (home !== "convex") steps.push({ scope: "person", workspaceId: personal._id, home, grantIds: [...grantIds].sort() });
  }
  return steps;
}

/**
 * Queue the deletion when any scope it touches is decided by its object, and
 * answer `true`: the caller reports it done and returns without deleting. A
 * deletion already queued is not queued twice. `false` means nothing it
 * touches is switched, and the caller deletes as it always has.
 */
export async function takeAwayFirst(ctx: MutationCtx, target: TakeAwayTarget): Promise<boolean> {
  const steps = await takeAwaySteps(ctx, target);
  if (!steps.some((step) => step.home === "object")) return false;
  if (target.kind !== "leave") {
    const queued =
      target.kind === "account"
        ? (await ctx.db.query("accessTakeAways").withIndex("by_user", (q) => q.eq("userId", target.userId)).collect()).find((job) => job.kind === "account")
        : await ctx.db.query("accessTakeAways").withIndex("by_workspace", (q) => q.eq("workspaceId", target.workspaceId)).first();
    if (queued !== undefined && queued !== null) return true;
  }
  const id = await ctx.db.insert("accessTakeAways", { ...target, at: Date.now(), attempt: 0 });
  await ctx.scheduler.runAfter(0, internal.functions.accessTakeAway.run, { id });
  return true;
}
