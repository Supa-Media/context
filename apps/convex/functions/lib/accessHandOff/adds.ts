/**
 * Writes Convex may still make first to a workspace whose members and invites
 * are decided in its object (decided by the owner, 2026-11-02: Convex keeps a
 * read-only copy of membership, updated before each object change counts;
 * `docs/decisions/identity-and-access/access-in-objects.md`).
 *
 * Joining and invitations are born deep inside Convex mutations (an accepted
 * link, a domain join, a phone sign-in, a Tex group chat's invite), and a
 * mutation cannot call an object. Each only ever lets someone in, so Convex
 * writing first is safe: nobody is let in until the object holds the row,
 * which the outbox puts there row by row, as Convex holds it when the push
 * runs (`functions/accessObjectPush.ts`). What stays refused is anything that
 * takes access away or changes it for someone already in (a removal, a role
 * change, leaving or deleting a group, `ungroup.ts`): those go to the object
 * first. Joining a group, and a new group nobody is in yet, count as joins.
 *
 * Invitations are always allowed. An invitation's link is only ever checked
 * against Convex's copy (`lib/invitations/join.ts`; nothing reads the
 * object's `ws.invites.find`), so an offer revoked, declined or accepted in
 * Convex is already spent there, and the object's list, which only shows the
 * invitations, follows.
 */

import type { Id } from "../../../_generated/dataModel";
import { targetsOf, type AccessWrite } from "./record";

/** What a mutation's authority writes to one workspace amount to: members joining and invitations to re-send. */
export type Adds = { userIds: string[]; inviteIds: string[] };

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * The additions `writes` make to `workspaceId`'s members and invites, or `null` when any of them takes access away
 * or changes it for someone already in, which the object must take first.
 */
export function addsOf(writes: readonly AccessWrite[], workspaceId: Id<"workspaces">): Adds | null {
  const mine = writes.filter((write) =>
    targetsOf(write).some((target) => target.kind === "workspace" && target.workspaceId === workspaceId && (target.table === "members" || target.table === "invites")),
  );
  const joined = new Set<string>();
  /** Joined the workspace itself (not just a group): only these may have their old group rows cleared. */
  const newMembers = new Set<string>();
  const invites = new Set<string>();
  for (const write of mine) {
    if ((write.table === "workspaceMembers" || write.table === "workspaceGroupMembers") && write.op === "insert") {
      // Joining the workspace, or one of its groups: the push puts the member's row as Convex holds it then.
      const userId = str(write.doc.userId);
      if (userId === null) return null;
      joined.add(userId);
      if (write.table === "workspaceMembers") newMembers.add(userId);
    } else if (write.table === "workspaceInvitations") {
      invites.add(write.id);
    }
  }
  // Ids patched (a `before` with an `after`), so a `before` alone is a delete.
  const patched = new Set(mine.filter((write) => write.op === "after").map((write) => write.id));
  for (const write of mine) {
    if (write.table === "workspaceInvitations") continue;
    if ((write.table === "workspaceMembers" || write.table === "workspaceGroupMembers") && write.op === "insert") continue;
    // A new group names nobody yet: nothing in the object changes until someone joins it.
    if (write.table === "workspaceGroups" && write.op === "insert") continue;
    // A join starts from no group names (`clearGroupNames`): deleting the joiner's own old group rows is part of it.
    const joinerGroupRowGone = write.table === "workspaceGroupMembers" && write.op === "before" && !patched.has(write.id) && newMembers.has(String(write.doc.userId));
    if (!joinerGroupRowGone) return null;
  }
  return { userIds: [...joined].sort(), inviteIds: [...invites].sort() };
}
