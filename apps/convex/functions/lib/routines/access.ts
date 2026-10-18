/**
 * Who a routine may run as, and who it may text. Every answer is read from
 * live membership at the moment it is asked; nothing here is cached on a row.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { resolveAddressedUser } from "../identities";
import { getMembership, type WorkspaceRole } from "../workspaceAuth";

/** The roles that may write a note, and so may be a routine's writer. */
export function isWritingRole(role: WorkspaceRole): boolean {
  return role === "owner" || role === "editor";
}

/** The writer's live role here when it may write, else null. */
export async function writingRole(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<WorkspaceRole | null> {
  const membership = await getMembership(ctx, workspaceId, userId);
  if (membership === null || !isWritingRole(membership.role)) return null;
  return membership.role;
}

/**
 * The workspace's owner, for a routine file found with no known writer: its
 * creator while they still own it, else the earliest-joined owner.
 */
export async function workspaceOwner(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Id<"users"> | null> {
  const workspace = await ctx.db.get(workspaceId);
  if (workspace === null) return null;
  const members = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(200);
  const owners = members.filter((member) => member.role === "owner");
  const creator = owners.find((member) => member.userId === workspace.createdBy);
  if (creator !== undefined) return creator.userId;
  owners.sort((a, b) => a.joinedAt - b.joinedAt);
  return owners[0]?.userId ?? null;
}

/** The time zone a person chose, or null. */
export async function accountTimeZone(ctx: QueryCtx, userId: Id<"users">): Promise<string | null> {
  const row = await ctx.db
    .query("accountTimeZones")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return row?.timeZone ?? null;
}

/**
 * The account a console write was made by, from the name the barrier stamps
 * into `activity.md` (`authorizeFileAccess`'s `actorName`: `@<personal slug>`).
 * A link stamp (`via …`) or anything else that is not a handle is nobody.
 * Only a hint: the caller still requires a live writing membership.
 */
export async function userForActorName(
  ctx: QueryCtx,
  actorName: string,
): Promise<Id<"users"> | null> {
  const match = /^@([a-z0-9][a-z0-9_-]{0,62})$/.exec(actorName);
  if (match === null) return null;
  return await resolveAddressedUser(ctx, { kind: "name", value: match[1] });
}

/**
 * Whether routines run in this workspace at all: only a personal one (decided
 * by the owner, 2026-10-18). Tex is a personal assistant; a routine in a shared
 * workspace texted one person what another had asked for. A personal routine
 * can still read the shared workspaces its writer belongs to.
 */
export function runsRoutines(workspace: Pick<Doc<"workspaces">, "kind">): boolean {
  return workspace.kind === "personal";
}

/**
 * The phones a run texts: the writer's own, and nobody else's. `send: note`
 * texts nobody, and neither does a writer who is no longer a member or has
 * no linked phone. A `to:` line is not read (owner, 2026-10-18): a routine
 * is one person's, and texting anyone else is what the old rule got wrong.
 */
export async function routineRecipients(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<"workspaces">;
    writerUserId: Id<"users">;
    send: "text" | "note" | "both";
  },
): Promise<string[]> {
  if (args.send === "note") return [];
  if ((await getMembership(ctx, args.workspaceId, args.writerUserId)) === null) return [];
  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", args.writerUserId))
    .first();
  return link === null ? [] : [link.phone];
}
