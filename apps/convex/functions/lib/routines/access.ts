/**
 * Who a routine may run as, and who it may text. Every answer is read from
 * live membership at the moment it is asked; nothing here is cached on a row.
 */

import type { Id } from "../../../_generated/dataModel";
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
 * The phones a run texts. `to:` handles that resolve to a person who is a live
 * member of this workspace (any role: reading a routine's text is no more
 * than reading the workspace) with a linked phone; with no `to:`, the writer.
 * `send: note` texts nobody. A handle that resolves to nobody, to someone
 * outside the workspace, or to someone with no phone is dropped silently.
 */
export async function routineRecipients(
  ctx: QueryCtx,
  args: {
    workspaceId: Id<"workspaces">;
    writerUserId: Id<"users">;
    send: "text" | "note" | "both";
    to: string[];
  },
): Promise<string[]> {
  if (args.send === "note") return [];
  const people: Id<"users">[] = [];
  if (args.to.length === 0) {
    people.push(args.writerUserId);
  } else {
    for (const handle of args.to.slice(0, 20)) {
      const userId = await resolveAddressedUser(ctx, { kind: "name", value: handle });
      if (userId === null) continue;
      if ((await getMembership(ctx, args.workspaceId, userId)) === null) continue;
      people.push(userId);
    }
  }
  const phones = new Set<string>();
  for (const userId of people) {
    // The writer too: only a live member is texted.
    if ((await getMembership(ctx, args.workspaceId, userId)) === null) continue;
    const link = await ctx.db
      .query("phoneLinks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (link !== null) phones.add(link.phone);
  }
  return [...phones];
}
