/**
 * Moving a bucket to the current on-bucket layout: the owner's request, and
 * the internal action that verifies the bucket before starting the resumable
 * copy.
 *
 * Handler bodies of functions `functions/files.ts` registers, moved verbatim;
 * the registrations (names, args, returns) stay there.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { callerId } from "./access";
import type { OperationResult } from "./operationTypes";

/**
 * Refresh the bucket's observed capabilities, then start the resumable copy.
 *
 * Kept internal and reached only through the scheduler: verification decrypts
 * the binding, so its result must never flow back through a public action.
 */
export async function runStorageLayoutMigrationHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    actorUserId: Id<"users">;
  },
): Promise<Extract<OperationResult, { kind: "storageMigrated" }>> {
  const verification = await ctx.runAction(
    internal.functions.provisioning.verifyStorageBinding,
    args,
  );
  if (
    !verification.verified ||
    verification.conditionalCreate !== true ||
    verification.conditionalWrite !== true
  ) {
    /*
      A refusal is an answer, and it is the one most worth remembering: a
      bucket that cannot do conflict-safe writes will never run this, so
      offering it again is offering something that cannot happen. Recorded
      here rather than in `runFileOperation` because this arm never reaches
      it — the operation is not attempted at all.
    */
    await ctx.runMutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId: args.workspaceId,
      state: "unsupported",
    });
    return {
      kind: "storageMigrated",
      state: "unsupported",
      objectsCopied: 0,
      objectsVerified: 0,
      objectsDeleted: 0,
      conflicts: 0,
      error: "migration requires conflict-safe storage writes",
    };
  }
  return (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope: "private",
    operation: { kind: "migrateStorage", cleanup: false },
  })) as Extract<OperationResult, { kind: "storageMigrated" }>;
}

/**
 * Start the versioned on-bucket plumbing migration.
 *
 * Owner-only because it reorganizes Context's reserved objects, even though it
 * never names or rewrites a note; the copy phase is resumable and
 * non-destructive, and `runFileOperation` schedules cleanup only after the
 * rollback window has elapsed.
 */
export async function updateStorageLayoutHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
  },
): Promise<Extract<OperationResult, { kind: "storageMigrated" }>> {
  const actorUserId = await callerId(ctx);
  await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  await ctx.scheduler.runAfter(0, internal.functions.files.runStorageLayoutMigration, {
    workspaceId: args.workspaceId,
    actorUserId,
  });
  const result: Extract<OperationResult, { kind: "storageMigrated" }> = {
    kind: "storageMigrated",
    state: "copying",
    objectsCopied: 0,
    objectsVerified: 0,
    objectsDeleted: 0,
    conflicts: 0,
  };

  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "storage.layout_migration_requested",
    paths: [],
    details: {
      state: result.state,
      objectsCopied: result.objectsCopied,
      objectsVerified: result.objectsVerified,
      conflicts: result.conflicts,
    },
  });
  return result;
}
