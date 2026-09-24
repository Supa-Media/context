import { ConvexError } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import type { MutationCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { isProductionTestAccount } from "../testAccount";
import { managedBucketName } from "../managedStorage";
import { normalizeName } from "../names";
import { requireWorkspaceRole } from "../workspaceAuth";

/**
 * Who may tear down a workspace, checked before `deleteWorkspaceCascade` runs.
 *
 * Each function is the refusal half of one mutation in `functions/account.ts`,
 * moved whole and in order: it resolves the caller, then throws for every
 * case that mutation's doc comment names. Returning means the cascade may run.
 */

/** The refusals of `deleteTestWorkspace`. */
export async function authorizeTestWorkspaceDeletion(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<void> {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  const user = await ctx.db.get(userId);
  const workspace = await ctx.db.get(args.workspaceId);
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  const ownsWorkspace = memberships.some(
    (membership) =>
      membership.userId === userId && membership.role === "owner",
  );

  if (
    !isProductionTestAccount(user) ||
    workspace === null ||
    workspace.createdBy !== userId ||
    !ownsWorkspace ||
    memberships.some((membership) => membership.userId !== userId)
  ) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Only an unshared workspace created by the production test account can use this cleanup.",
    });
  }
}

/** The refusals of `deleteWorkspace`. */
export async function authorizeWorkspaceDeletion(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; confirmSlug: string },
): Promise<void> {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  const { workspace } = await requireWorkspaceRole(
    ctx,
    args.workspaceId,
    userId,
    "owner",
  );

  if (workspace.kind !== "shared") {
    throw new ConvexError({
      code: "PERSONAL_CONTEXT",
      message:
        "A personal workspace is deleted with the account it belongs to, not from here.",
    });
  }

  /*
    The `@` is stripped here rather than in `normalizeName`, which is
    deliberately a trim and a lowercase and nothing else: a normalizer that
    silently dropped a character would be rewriting names on the claim path
    too. Here it is a courtesy to somebody copying what the screen shows
    them, and it widens nothing — `@` is not a legal character in a name, so
    no other workspace can be reached by adding one.
  */
  if (normalizeName(args.confirmSlug).replace(/^@/, "") !== workspace.slug) {
    throw new ConvexError({
      code: "CONFIRMATION_MISMATCH",
      message: "That is not this workspace's name, so nothing was deleted.",
    });
  }

  /*
    A move *into* managed storage that has started is the same refusal one
    step earlier: the managed bucket already exists, already holds a partial
    copy, and its scoped token is live. The cascade would delete the row that
    names both and leave us paying for a bucket nobody can reach — so a
    migration in flight, or one parked `failed` with its cursor kept for a
    retry, blocks deletion until it is finished or abandoned.
  */
  const migration = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (migration !== null) {
    throw new ConvexError({
      code: "MANAGED_MIGRATION",
      message:
        "A move into storage we run is under way for this workspace. Let it finish or cancel it first.",
    });
  }

  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (binding !== null && binding.bucket === managedBucketName(args.workspaceId)) {
    throw new ConvexError({
      code: "MANAGED_STORAGE",
      message:
        "This workspace's notes are in storage we run, and moving them out is not built yet. Connect a bucket you own first, or delete it once hand-off ships.",
    });
  }
}
