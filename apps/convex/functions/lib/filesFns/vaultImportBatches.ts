/**
 * The actions that move a local vault's bytes into the bucket, one bounded
 * batch at a time. The job rows they report against are in
 * `vaultImportJobs.ts`; the limits are in `vaultImportPlan.ts`.
 *
 * Handler bodies of functions `functions/files.ts` registers, moved verbatim;
 * the registrations (names, args, returns) stay there.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { callerId } from "./access";
import type { OperationResult } from "./operationTypes";
import {
  MAX_VAULT_IMPORT_BATCH_BYTES,
  MAX_VAULT_IMPORT_BATCH_FILES,
  vaultImportJobStatus,
  type VaultImportJobStatus,
} from "./vaultImportPlan";

export async function clearVaultImportBatchHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    jobId: Id<"vaultImportJobs">;
    sourceFingerprint: string;
  },
): Promise<VaultImportJobStatus> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  const job = await ctx.runQuery(internal.functions.files.vaultImportJobForBatch, {
    jobId: args.jobId,
  }) as Doc<"vaultImportJobs"> | null;
  if (
    job === null ||
    job.workspaceId !== args.workspaceId ||
    job.actorUserId !== actorUserId ||
    job.sourceFingerprint !== args.sourceFingerprint ||
    job.strategy !== "replace" ||
    job.replacement === undefined
  ) {
    throw new ConvexError({ code: "IMPORT_JOB_NOT_FOUND", message: "That replacement is no longer available." });
  }
  if (job.replacement.phase === "uploading") return vaultImportJobStatus(job);

  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "clearVault", countOnly: job.replacement.phase === "counting" },
  }) as Extract<OperationResult, { kind: "vaultCleared" }>;
  const recorded = await ctx.runMutation(internal.functions.files.recordVaultClearBatch, {
    jobId: args.jobId,
    actorUserId,
    workspaceId: args.workspaceId,
    sourceFingerprint: args.sourceFingerprint,
    mode: result.mode,
    objects: result.objects,
    complete: result.complete,
  });
  if (recorded === null) {
    throw new ConvexError({ code: "IMPORT_JOB_MISMATCH", message: "Choose the same vault again to resume." });
  }
  if (result.mode === "deleted" && result.objects > 0) {
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "vault.replace.clear",
      paths: [],
      details: { objectsDeleted: result.objects },
    });
  }
  return recorded;
}

/**
 * Upload one numbered batch and atomically mark its progress after the bucket
 * accepts it. Repeating the same number returns the stored result and never
 * sends those bytes to storage twice.
 */
export async function importVaultJobBatchHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    jobId: Id<"vaultImportJobs">;
    sourceFingerprint: string;
    batchIndex: number;
    files: ({ path: string; bytes: ArrayBuffer; contentType: string })[];
  },
): Promise<VaultImportJobStatus> {
  if (args.files.length === 0 || args.files.length > MAX_VAULT_IMPORT_BATCH_FILES) {
    throw new ConvexError({
      code: "IMPORT_BATCH_INVALID",
      message: `Upload between 1 and ${MAX_VAULT_IMPORT_BATCH_FILES} files at a time.`,
    });
  }
  const batchBytes = args.files.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (batchBytes > MAX_VAULT_IMPORT_BATCH_BYTES) {
    throw new ConvexError({ code: "IMPORT_BATCH_INVALID", message: "That upload batch is too large." });
  }
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  const job = await ctx.runQuery(internal.functions.files.vaultImportJobForBatch, { jobId: args.jobId }) as Doc<"vaultImportJobs"> | null;
  if (job === null || job.workspaceId !== args.workspaceId || job.actorUserId !== actorUserId) {
    throw new ConvexError({ code: "IMPORT_JOB_NOT_FOUND", message: "That import is no longer available." });
  }
  if (
    job.sourceFingerprint !== args.sourceFingerprint ||
    !Number.isSafeInteger(args.batchIndex) ||
    args.batchIndex < 0 ||
    args.batchIndex >= job.totalBatches
  ) {
    throw new ConvexError({ code: "IMPORT_JOB_MISMATCH", message: "Choose the same vault again to resume." });
  }
  if (job.strategy === "replace" && job.replacement?.phase !== "uploading") {
    throw new ConvexError({
      code: "IMPORT_REPLACE_NOT_READY",
      message: "The existing bucket must finish clearing before files upload.",
    });
  }
  if (job.completedBatches.includes(args.batchIndex)) return vaultImportJobStatus(job);
  const completedFilesAfterBatch = job.completedFiles + args.files.length;
  const completedBatchCountAfterBatch = job.completedBatches.length + 1;
  if (
    completedFilesAfterBatch > job.totalFiles ||
    (completedBatchCountAfterBatch === job.totalBatches && completedFilesAfterBatch !== job.totalFiles) ||
    (completedBatchCountAfterBatch < job.totalBatches && completedFilesAfterBatch >= job.totalFiles)
  ) {
    throw new ConvexError({ code: "IMPORT_PLAN_INVALID", message: "Choose the vault again to restart this import." });
  }

  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "importVault", files: args.files },
  })) as Extract<OperationResult, { kind: "vaultImported" }>;
  if (
    job.strategy === "replace" &&
    job.completedBatches.length + 1 === job.totalBatches &&
    job.completedFiles + args.files.length === job.totalFiles
  ) {
    // Idempotent so a retry after storage succeeded but progress recording
    // failed still restores the private access map before completing.
    await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "ensurePrivacy" },
    });
  }
  const recorded = await ctx.runMutation(internal.functions.files.recordVaultImportBatch, {
    jobId: args.jobId,
    actorUserId,
    workspaceId: args.workspaceId,
    sourceFingerprint: args.sourceFingerprint,
    batchIndex: args.batchIndex,
    filesProcessed: args.files.length,
    filesCreated: result.created.length,
    filesSkipped: result.skipped.length,
  });
  if (recorded === null) {
    throw new ConvexError({ code: "IMPORT_JOB_MISMATCH", message: "Choose the same vault again to resume." });
  }
  if (result.created.length > 0) {
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "vault.import",
      paths: result.created,
      details: {
        filesCreated: result.created.length,
        filesSkipped: result.skipped.length,
        bytesCreated: result.bytesCreated,
        batchIndex: args.batchIndex,
      },
    });
  }
  return recorded;
}

/**
 * Upload one retryable batch from a locally selected Obsidian vault.
 *
 * Owner-only because a vault import can create non-Markdown attachments and a
 * large path tree. Bytes cross this action directly into the workspace bucket;
 * the control plane stores only the ordinary audit metadata below.
 */
export async function importVaultBatchHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    files: ({ path: string; bytes: ArrayBuffer; contentType: string })[];
  },
): Promise<Extract<OperationResult, { kind: "vaultImported" }>> {
  if (args.files.length === 0 || args.files.length > MAX_VAULT_IMPORT_BATCH_FILES) {
    throw new ConvexError({
      code: "IMPORT_BATCH_INVALID",
      message: `Upload between 1 and ${MAX_VAULT_IMPORT_BATCH_FILES} files at a time.`,
    });
  }
  const batchBytes = args.files.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (batchBytes > MAX_VAULT_IMPORT_BATCH_BYTES) {
    throw new ConvexError({
      code: "IMPORT_BATCH_INVALID",
      message: "That upload batch is too large. Choose the vault again to retry in smaller pieces.",
    });
  }

  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "owner",
  });
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "importVault", files: args.files },
  })) as Extract<OperationResult, { kind: "vaultImported" }>;

  if (result.created.length > 0) {
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "vault.import",
      paths: result.created,
      details: {
        filesCreated: result.created.length,
        filesSkipped: result.skipped.length,
        bytesCreated: result.bytesCreated,
      },
    });
  }
  return result;
}
