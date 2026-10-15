/**
 * Whether a workspace belongs only to archived accounts (admin › People ›
 * Archive), so the background work that keeps its derivatives current can
 * leave it alone.
 *
 * Asked for by the owner, 2026-10-14 ("can we stop trying to
 * index/backfill/migrate testagent1's stuff, its archived already"): an
 * archived test account's workspace sat Stuck in admin › Search › Indexes
 * while the 15-minute tree round, the facts fill, and the fast search and
 * meaning sweeps kept starting work on it.
 *
 * Archived means its creator's account is archived AND no member's account is
 * live. A shared workspace a test account made and real people joined keeps
 * being indexed: those people still use it. Nothing is deleted: the
 * workspace, its bucket and its indexes stay as they were, an edit made
 * through it still reaches its indexes, and Unarchive puts it back on every
 * round.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";

/** Members read per workspace; a workspace with more is plainly in use. */
const MEMBER_LIMIT = 50;

async function accountArchived(db: DatabaseReader, userId: Id<"users">): Promise<boolean> {
  const row = await db
    .query("archivedAccounts")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return row !== null;
}

export async function workspaceArchived(
  db: DatabaseReader,
  workspace: Id<"workspaces"> | Doc<"workspaces"> | null,
): Promise<boolean> {
  const row = typeof workspace === "string" ? await db.get(workspace) : workspace;
  if (row === null) return false;
  if (!(await accountArchived(db, row.createdBy))) return false;
  const members = await db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", row._id))
    .take(MEMBER_LIMIT + 1);
  if (members.length > MEMBER_LIMIT) return false;
  for (const member of members) {
    if (!(await accountArchived(db, member.userId))) return false;
  }
  return true;
}
