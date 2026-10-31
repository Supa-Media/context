/**
 * What a Tex group chat reaches (decided by the owner, 2026-10-31, from the Tex Devs meeting of 2026-10-30;
 * `docs/decisions/texting-assistant/groups.md`, `chat-homes.md`).
 *
 * A chat is not bound to one workspace. Its reach is every SHARED workspace that ALL of its people with accounts are
 * live members of, worked out on the fly, so the chat sees no more than its least-privileged person could. If anyone
 * in the chat has no account (a guest, or a number not linked by code) the reach is empty and the chat has only its
 * home (`lib/textGroupHomeOnly.ts`, `lib/textGroupHome.ts`).
 *
 * Three rules are enforced here and nowhere else, so a second implementation cannot be laxer:
 *
 *  - A personal workspace is never in reach (it carries its owner's mail, calendar and vault), and neither is the
 *    pinned workspace: a chat's access to that is its home, by the home door, and never as a workspace of its own.
 *  - Reach is a hint taken at the turn (`texGroup.reach`, `textGroups.reach`); what a request is given is
 *    `liveReach`, which re-reads every person's membership of every workspace on every call. Someone removed from a
 *    workspace drops it from the chat's next call. The grant's sponsor (the account that acts, `grant.userId`) must be
 *    a member too, since writes are audited as them.
 *  - Each workspace in reach carries the LOWEST role among the chat's people there, so one member who can only read
 *    makes the whole chat read-only in that workspace. Tier is `team` with no granted names: the grant never holds
 *    `context:private`.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { phoneSignInPaused } from "./emailProof";
import { pinnedContextWorkspace } from "./pinnedContext";
import { getMembership, type WorkspaceRole } from "./workspaceAuth";

/** Most workspaces read per person when intersecting; nobody is in this many. */
const MEMBERSHIP_SCAN = 200;

const RANK: Record<WorkspaceRole, number> = { member: 0, editor: 1, owner: 2 };

/** One workspace a chat reaches, and the role the whole chat holds there. */
export interface ReachRow {
  workspace: Doc<"workspaces">;
  role: WorkspaceRole;
}

/** The lower of two roles. */
function lowest(a: WorkspaceRole, b: WorkspaceRole): WorkspaceRole {
  return RANK[a] <= RANK[b] ? a : b;
}

function bySlug(a: ReachRow, b: ReachRow): number {
  return a.workspace.slug < b.workspace.slug ? -1 : a.workspace.slug > b.workspace.slug ? 1 : 0;
}

/** Whether `workspace` may be in any chat's reach at all: shared, and not the pin. */
function mayBeInReach(workspace: Doc<"workspaces"> | null, pin: Doc<"workspaces"> | null): workspace is Doc<"workspaces"> {
  return workspace !== null && workspace.kind === "shared" && (pin === null || workspace._id !== pin._id);
}

/**
 * The shared workspaces every one of `people` is a live member of, each at the lowest role they hold there, by slug.
 * Empty when `people` is empty or any of them paused texting. `people` is the chat's accounts (the sponsor too, when
 * the caller wants them to count).
 */
async function sharedByAll(ctx: QueryCtx, people: Id<"users">[]): Promise<ReachRow[]> {
  if (people.length === 0) return [];
  const pin = await pinnedContextWorkspace(ctx);
  const roles = new Map<Id<"workspaces">, WorkspaceRole>();
  let first = true;
  for (const userId of people) {
    if (await phoneSignInPaused(ctx, userId)) return [];
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MEMBERSHIP_SCAN);
    const mine = new Map(memberships.map((membership) => [membership.workspaceId, membership.role as WorkspaceRole]));
    if (first) {
      for (const [id, role] of mine) roles.set(id, role);
      first = false;
    } else {
      for (const [id, role] of roles) {
        const held = mine.get(id);
        if (held === undefined) roles.delete(id);
        else roles.set(id, lowest(role, held));
      }
    }
    if (roles.size === 0) return [];
  }
  const rows: ReachRow[] = [];
  for (const [id, role] of roles) {
    const workspace = await ctx.db.get(id);
    if (mayBeInReach(workspace, pin)) rows.push({ workspace, role });
  }
  return rows.sort(bySlug);
}

/**
 * A chat's reach at a turn: `people` are the chat's accounts, and `hasGuests` is true when anyone in it has no
 * account. The chat's own pinned workspace is never in it (`chat` is accepted so a caller states whose reach it asks
 * for, and for the audit trail a later change may add).
 */
export async function reachOf(
  ctx: QueryCtx,
  _chat: Doc<"textGroups">,
  people: Id<"users">[],
  hasGuests = false,
): Promise<ReachRow[]> {
  if (hasGuests) return [];
  return await sharedByAll(ctx, [...new Set(people)]);
}

/**
 * What a request is given of a stored reach: each workspace of `reach` that every one of `people` and `sponsor` is
 * still a live member of, at the lowest role among them. Re-read on every call, never frozen.
 */
export async function liveReach(
  ctx: QueryCtx,
  reach: Id<"workspaces">[] | undefined,
  people: Id<"users">[] | undefined,
  sponsor: Id<"users"> | null,
): Promise<ReachRow[]> {
  if (reach === undefined || reach.length === 0 || people === undefined || people.length === 0) return [];
  const who = [...new Set(sponsor === null ? people : [...people, sponsor])];
  for (const userId of who) if (await phoneSignInPaused(ctx, userId)) return [];
  const pin = await pinnedContextWorkspace(ctx);
  const rows: ReachRow[] = [];
  for (const id of new Set(reach)) {
    const workspace = await ctx.db.get(id);
    if (!mayBeInReach(workspace, pin)) continue;
    let role: WorkspaceRole | null = null;
    for (const userId of who) {
      const membership = await getMembership(ctx, id, userId);
      if (membership === null) {
        role = null;
        break;
      }
      role = role === null ? (membership.role as WorkspaceRole) : lowest(role, membership.role as WorkspaceRole);
    }
    if (role !== null) rows.push({ workspace, role });
  }
  return rows.sort(bySlug);
}

/**
 * The one workspace a consumer that needs just one uses for a chat (its mail shares, check-ins, routines, metered
 * decisions): the workspace it was bound to when that is still in reach, else the first in reach by name. Null when
 * the chat reaches none. A row that never took a turn under reach (`reach` unset: a chat bound before, or by an
 * invitation, `lib/textGroupInvited.ts`) keeps the workspace it was bound to.
 */
export async function chatWorkspace(ctx: QueryCtx, chat: Doc<"textGroups">): Promise<Doc<"workspaces"> | null> {
  if (chat.reach !== undefined) {
    const live = await liveReach(ctx, chat.reach, chat.reachPeople, chat.sponsorId ?? null);
    const bound = live.find((row) => row.workspace._id === chat.workspaceId);
    return (bound ?? live[0])?.workspace ?? null;
  }
  if (chat.workspaceId === undefined) return null;
  const bound = await ctx.db.get(chat.workspaceId);
  return bound !== null && bound.kind === "shared" ? bound : null;
}

/** Whether `workspaceId` is one a chat reaches now (`chatWorkspace`'s rule, for a named workspace). */
export async function chatReaches(ctx: QueryCtx, chat: Doc<"textGroups">, workspaceId: Id<"workspaces">): Promise<boolean> {
  if (chat.reach !== undefined) {
    return (await liveReach(ctx, chat.reach, chat.reachPeople, chat.sponsorId ?? null)).some((row) => row.workspace._id === workspaceId);
  }
  return chat.workspaceId === workspaceId;
}
