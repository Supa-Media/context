/**
 * Whether a workspace `member` may write one note because they hold an edit
 * grant on the row that governs it.
 *
 * Only a body write comes here (`writeNote`). Everything else still needs the
 * `editor` role, and a member is refused on every other path, so this is the
 * one door a member gets. The decision is `canEditPath` over the workspace's
 * own rows (`lib/nodes/governingRow.ts`), read through the same grant names
 * the barrier gets.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { grantedNamesFor } from "../grantedNames";
import { accessRowsOf } from "../nodes/accessRows";
import { governingRowOf } from "../nodes/governingRow";
import { editNameFor } from "../nodes/rowAccess";

/** What the caller is writing, as far as a member's grant is concerned. */
export interface MemberWrite {
  path: string;
  /**
   * Whether the new text carries a form block. A form block creates response
   * files in its folder on save (`ensureFormResponseFiles`), which is a
   * creation, so a member is refused it.
   */
  formBlocks: boolean;
}

/**
 * A path the governing walk can rely on: no empty, `.` or `..` segments and
 * no backslash. `1-projects/../2-areas/x.md` would otherwise be governed by
 * the folder it names by text and written under another.
 */
export function isCanonicalPath(path: string): boolean {
  if (path === "" || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export async function memberMayWrite(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  write: MemberWrite,
): Promise<boolean> {
  if (write.formBlocks || !isCanonicalPath(write.path)) return false;
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
    .unique();
  if (membership === null || membership.role !== "member") return false;
  const governing = governingRowOf(await accessRowsOf(ctx, workspaceId), write.path);
  if (governing === null) return false;
  // Grant names are stored without their leading `@` (`grantedNamesFor`).
  return (await grantedNamesFor(ctx, workspaceId, userId)).includes(editNameFor(governing.noteId).slice(1));
}
