/**
 * Workspace authorization — the tenant boundary.
 *
 * One workspace is one security boundary. Every public function that touches
 * workspace-scoped data goes through here, and the rules are deliberately
 * short enough to hold in your head:
 *
 *  1. **Not a member is indistinguishable from does not exist.** A caller who
 *     is not in a workspace gets `WORKSPACE_NOT_FOUND` — the exact same error,
 *     with the exact same shape, as for an id that was never real. Returning
 *     `FORBIDDEN` for a workspace that exists and `NOT_FOUND` for one that
 *     does not turns every endpoint into an existence oracle: an attacker who
 *     can guess or harvest ids learns which contexts are real, who is on the
 *     platform, and (via slugs) what people are working on. Isolation means a
 *     tenant cannot *infer* another tenant, not just cannot read one.
 *
 *  2. **Roles are ranked, and checked explicitly.** `member` is read-only.
 *     Write access to someone else's context is never implied by being able to
 *     see it.
 *
 *  3. **Errors are `ConvexError`, never plain `Error`.** A plain `Error` is
 *     scrubbed to "Server Error" on the client and dead-ends the user in the
 *     root error boundary with nothing actionable.
 */

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

export type WorkspaceRole = "owner" | "editor" | "member";

/**
 * Role ordering. Higher wins. Used only for `atLeast` comparisons — do not
 * persist these numbers; the string is the stored value.
 */
const ROLE_RANK: Record<WorkspaceRole, number> = {
  member: 0,
  editor: 1,
  owner: 2,
};

/** Whether `role` satisfies a minimum. */
export function roleAtLeast(role: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * The single error a caller sees for "that workspace is not yours".
 *
 * Constructed in one place so no future endpoint can accidentally leak the
 * difference between "exists but not yours" and "never existed" by wording its
 * own message slightly differently.
 */
export function workspaceNotFound(): ConvexError<{
  code: string;
  message: string;
}> {
  return new ConvexError({
    code: "WORKSPACE_NOT_FOUND",
    message: "Workspace not found",
  });
}

/**
 * Resolve the caller's membership, or `null`.
 *
 * Returns `null` both when the workspace does not exist and when the caller is
 * not a member — the caller of this function cannot tell the two apart either,
 * which is the point.
 */
export async function getMembership(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<Doc<"workspaceMembers"> | null> {
  return await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", workspaceId).eq("userId", userId),
    )
    .unique();
}

/**
 * Require that the caller is a member of the workspace, and return both the
 * workspace and their membership.
 *
 * Deliberately loads the membership FIRST. If the membership row is missing we
 * throw without ever reading the workspace, so no timing or code path differs
 * between "workspace exists" and "workspace does not exist".
 */
export async function requireWorkspaceAccess(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<{
  workspace: Doc<"workspaces">;
  membership: Doc<"workspaceMembers">;
}> {
  const membership = await getMembership(ctx, workspaceId, userId);
  if (membership === null) throw workspaceNotFound();

  const workspace = await ctx.db.get(workspaceId);
  // A membership pointing at a deleted workspace is a data-integrity problem,
  // not an authorization one, but the caller still learns nothing extra.
  if (workspace === null) throw workspaceNotFound();

  return { workspace, membership };
}

/**
 * Require a minimum role.
 *
 * Note the two different errors, and that the difference is safe here: by the
 * time we check the role we have already established the caller is a member,
 * so they already know the workspace exists. Telling them "you need to be an
 * owner" leaks nothing and is the only way they can act on the failure.
 */
export async function requireWorkspaceRole(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  minimum: WorkspaceRole,
): Promise<{
  workspace: Doc<"workspaces">;
  membership: Doc<"workspaceMembers">;
}> {
  const access = await requireWorkspaceAccess(ctx, workspaceId, userId);
  if (!roleAtLeast(access.membership.role, minimum)) {
    throw new ConvexError({
      code: "INSUFFICIENT_ROLE",
      message: `This action requires the "${minimum}" role or higher.`,
      requiredRole: minimum,
      actualRole: access.membership.role,
    });
  }
  return access;
}
