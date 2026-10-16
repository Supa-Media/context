/**
 * Take one account's own grants out of one workspace, when it leaves or is removed.
 *
 * Once the account is no longer a member it is an outsider (`outsider.ts`), and
 * an account grant left on a row would be a read the owner did not mean to keep:
 * the outsider path honours any grant its live rows name. So the account's
 * `granteeKind: "user"` rows in this workspace are deleted, the snapshot readers
 * judge by is rebuilt from the rows so it cannot keep them, and one `access.list`
 * audit row records the change, as every other change to an access list does.
 *
 * Only `user` grants. An `email` grant names an address, not a membership, and
 * the owner who wrote it is the one who takes it back. That is the chosen default,
 * and it is stated in `docs/decisions/privacy-and-sharing/name-rules-and-grants.md`.
 *
 * Every row is deleted, with no cap. A cap would leave a grant that reaches an
 * outsider the owner thinks was removed, which is the one outcome this exists to
 * prevent.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { refreshSnapshot } from "../nodes/accessBackfill";

export async function removeUserGrantsIn(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; userId: Id<"users">; actorUserId: Id<"users"> },
): Promise<number> {
  const grants = (
    await ctx.db
      .query("nodeAccess")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("granteeUserId", args.userId))
      .collect()
  ).filter((grant) => grant.granteeKind === "user");
  if (grants.length === 0) return 0;

  for (const grant of grants) await ctx.db.delete(grant._id);
  // The snapshot is what readers judge by, and it carries grantees. Rebuilt from the rows, it cannot keep the removed one.
  await refreshSnapshot(ctx, args.workspaceId);

  // The same token `setAccess.ts` audits a list change by: its kind, its id and its role.
  const removed = [...new Set(grants.map((grant) => `user:${args.userId}:${grant.role}`))];
  const nodeIds = [...new Set(grants.map((grant) => String(grant.nodeId)))];
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    action: "access.list",
    details: {
      removedCount: grants.length,
      removed: removed.join(","),
      nodeIds: nodeIds.join(","),
    },
  });
  return grants.length;
}
