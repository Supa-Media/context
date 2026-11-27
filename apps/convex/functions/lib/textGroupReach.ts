/**
 * What a Tex group chat reaches (decided by the owner, 2026-10-31, from the Tex Devs meeting of 2026-10-30;
 * `docs/decisions/texting-assistant/groups.md`, `chat-homes.md`; the asker's reach decided by Dev2, 2026-11-25,
 * `docs/decisions/texting-assistant/asker-reach.md`).
 *
 * A turn somebody asked for (a text, their job's report, their ask from another chat) reads the ASKER's own shared
 * workspaces (`askerReach`): the asker's access is the ceiling, and the asker is the verified sender only, so "Seyi,
 * tell Tex to show it" from John runs on John's. What is said of it in front of the room is the model's judgment.
 *
 * A turn nobody asked for (a routine, a check-in, the hello) reads the CHAT's reach (`reachOf` over everyone): every
 * SHARED workspace that ALL of its people with accounts are
 * live members of, worked out on the fly, so the chat sees no more than its least-privileged person could. Someone
 * with no account at all counts in a workspace that invited their number (a pending phone invitation, as "Tex, add
 * everyone here to @slug" sends, `lib/textGroupInvited.ts`), at that invitation's role, and keeps the chat from every
 * other one (Dev2, 2026-11-16: "some guests are added to workspaces so the entire premise is wrong"; before this any
 * guest emptied the reach). Only someone who is neither a member nor invited by number keeps a workspace out. A chat
 * that reaches none has only its home (`lib/textGroupHomeOnly.ts`, `lib/textGroupHome.ts`).
 *
 * Three rules are enforced here and nowhere else, so a second implementation cannot be laxer:
 *
 *  - A personal workspace is never in a chat's reach, and neither is the pinned workspace. The one exception is the
 *    asker's own personal workspace on a turn they asked for, on their own grant (`askerOwnPersonal`, Dev2 2026-11-26:
 *    "doesn't make sense for tex being able to read shared workspaces and not personal notes"), read-only at their
 *    private tier; the
 *    pinned workspace: a chat's access to that is its home, by the home door, and never as a workspace of its own.
 *  - Reach is a hint taken at the turn (`texGroup.reach`, `textGroups.reach`); what a request is given is
 *    `liveReach`, which re-reads every person's membership, and every guest's invitation, of every workspace on every
 *    call. Someone removed from a workspace, or an invitation revoked, drops it from the chat's next call. The grant's sponsor (the account that acts, `grant.userId`) must be
 *    a member too, since writes are audited as them.
 *  - Each workspace in reach carries the LOWEST role among the chat's people there, so one member who can only read
 *    makes the whole chat read-only in that workspace. Tier is `team` with no granted names: the grant never holds
 *    `context:private`.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { phoneSignInPaused } from "./emailProof";
import { pinnedContextWorkspace } from "./pinnedContext";
import { pendingPhoneInvitation } from "./textGroupInvited";
import { getMembership, type WorkspaceRole } from "./workspaceAuth";

/** Most workspaces read per person when intersecting; nobody is in this many. */
const MEMBERSHIP_SCAN = 200;

const RANK: Record<WorkspaceRole, number> = { member: 0, editor: 1, owner: 2 };

/** One workspace a chat reaches, and the role the whole chat holds there. */
export interface ReachRow {
  workspace: Doc<"workspaces">;
  role: WorkspaceRole;
  /** The asker's own personal workspace, on their own ask (`askerOwnPersonal`): read at their private tier, never written. */
  askerOwn?: true;
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
 * `rows` kept only where every one of `guests` (numbers with no account) holds a pending phone invitation, each at the
 * lower of its role and the invitation's: a guest invited as a member makes the chat a member's there.
 */
async function invitedByNumber(ctx: QueryCtx, rows: ReachRow[], guests: readonly string[], now: number): Promise<ReachRow[]> {
  if (guests.length === 0) return rows;
  const kept: ReachRow[] = [];
  for (const row of rows) {
    let role: WorkspaceRole | null = row.role;
    for (const phone of new Set(guests)) {
      const invitation = await pendingPhoneInvitation(ctx, row.workspace._id, phone, now);
      if (invitation === null) {
        role = null;
        break;
      }
      role = lowest(role, invitation.role);
    }
    if (role !== null) kept.push({ workspace: row.workspace, role });
  }
  return kept;
}

/**
 * A chat's reach at a turn: `people` are the chat's accounts (the sponsor too), and `guests` the numbers in it with no
 * account, each of which must be invited by number to a workspace for the chat to reach it. The chat's own pinned
 * workspace is never in it (`chat` is accepted so a caller states whose reach it asks for).
 */
export async function reachOf(
  ctx: QueryCtx,
  _chat: Doc<"textGroups">,
  people: Id<"users">[],
  guests: readonly string[] = [],
  now: number = Date.now(),
): Promise<ReachRow[]> {
  return await invitedByNumber(ctx, await sharedByAll(ctx, [...new Set(people)]), guests, now);
}

/**
 * A turn somebody asked for: the asker's own shared workspaces, each at the asker's own role, and, for an account
 * holder, their own personal workspace (`askerOwnPersonal`); never the pin. Someone with no account (`asker` null) asks
 * on the sponsor's standing, and reaches only a workspace they hold a pending phone invitation to that the sponsor is a
 * member of, at the lower role, and never anyone's personal workspace. `people` and `guests` are what the grant
 * re-checks on every request (`liveReach`).
 */
export async function askerReach(
  ctx: QueryCtx,
  chat: Doc<"textGroups">,
  asker: Id<"users"> | null,
  sponsor: Id<"users">,
  guestPhone: string | null,
  now: number = Date.now(),
): Promise<{ rows: ReachRow[]; people: Id<"users">[]; guests: string[] }> {
  const people = [asker ?? sponsor];
  const guests = asker === null && guestPhone !== null ? [guestPhone] : [];
  // A guest with no number to check has nothing of their own to read.
  if (asker === null && guestPhone === null) return { rows: [], people, guests };
  const rows = await reachOf(ctx, chat, people, guests, now);
  if (asker === null || (await phoneSignInPaused(ctx, asker))) return { rows, people, guests };
  const own = await askerOwnPersonal(ctx, asker);
  return { rows: own === null ? rows : [...rows, own].sort(bySlug), people, guests };
}

/**
 * The asker's own personal workspace, as a row a turn they asked for reads (Dev2, 2026-11-26: "lets open the floodgates
 * there right now. We will scale back if its an extreme concern"): only the one they OWN, held as `member` so the group
 * grant never writes there and never passes for its owner (`role: "owner"` is what the gateway reads as "this is the
 * person themselves": texts backup, computers, vault), and marked `askerOwn` so the gateway reads it at the private tier
 * (`apps/mcp/src/session.js` `sessionForContext`). Null when they have none.
 */
async function askerOwnPersonal(ctx: QueryCtx, asker: Id<"users">): Promise<ReachRow | null> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", asker))
    .take(MEMBERSHIP_SCAN);
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace !== null && workspace.kind === "personal") return { workspace, role: "member", askerOwn: true };
  }
  return null;
}

/**
 * What a request is given of a stored reach: each workspace of `reach` that every one of `people` and `sponsor` is
 * still a live member of, and every one of `guests` still holds a pending phone invitation to, at the lowest role
 * among them. Re-read on every call, never frozen. `askerOwn` is true only for an asker's own grant
 * (`texGroup.reachFor: "asker"`): then a personal workspace in `reach` is kept when the one person reading is still its
 * owner, as `askerOwnPersonal` reads it, and dropped otherwise.
 */
export async function liveReach(
  ctx: QueryCtx,
  reach: Id<"workspaces">[] | undefined,
  people: Id<"users">[] | undefined,
  sponsor: Id<"users"> | null,
  guests: readonly string[] = [],
  now: number = Date.now(),
  askerOwn = false,
): Promise<ReachRow[]> {
  if (reach === undefined || reach.length === 0 || people === undefined || people.length === 0) return [];
  const who = [...new Set(sponsor === null ? people : [...people, sponsor])];
  for (const userId of who) if (await phoneSignInPaused(ctx, userId)) return [];
  const pin = await pinnedContextWorkspace(ctx);
  const rows: ReachRow[] = [];
  for (const id of new Set(reach)) {
    const workspace = await ctx.db.get(id);
    if (workspace !== null && workspace.kind === "personal") {
      // Only an asker's own grant, one person reading, no guest, and they still own it.
      if (!askerOwn || who.length !== 1 || guests.length > 0) continue;
      const membership = await getMembership(ctx, id, who[0]);
      if (membership?.role === "owner") rows.push({ workspace, role: "member", askerOwn: true });
      continue;
    }
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
  return (await invitedByNumber(ctx, rows, guests, now)).sort(bySlug);
}

/**
 * The one workspace a consumer that needs just one uses for a chat (its mail shares, check-ins, routines, metered
 * decisions): the workspace it was bound to when that is still in reach, else the first in reach by name. Null when
 * the chat reaches none. A row that never took a turn under reach (`reach` unset: a chat bound before, or by an
 * invitation, `lib/textGroupInvited.ts`) keeps the workspace it was bound to.
 */
export async function chatWorkspace(ctx: QueryCtx, chat: Doc<"textGroups">): Promise<Doc<"workspaces"> | null> {
  if (chat.reach !== undefined) {
    const live = await liveReach(ctx, chat.reach, chat.reachPeople, chat.sponsorId ?? null, chat.reachGuests ?? []);
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
    return (await liveReach(ctx, chat.reach, chat.reachPeople, chat.sponsorId ?? null, chat.reachGuests ?? [])).some((row) => row.workspace._id === workspaceId);
  }
  return chat.workspaceId === workspaceId;
}
