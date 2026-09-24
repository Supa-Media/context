/**
 * The control-plane half of a local vault import: starting, pausing and
 * recording the job row. The bytes never come here; see `vaultImportPlan.ts`
 * for the limits, and `functions/files.ts` for the actions that upload.
 *
 * Handler bodies of functions `functions/files.ts` registers, moved verbatim;
 * the registrations (names, args, returns) stay there.
 */

import { ConvexError } from "convex/values";
import { matchesDestructiveActionAcknowledgement } from "@context/shared";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { requireWorkspaceRole } from "../workspaceAuth";
import { callerId } from "./access";
import {
  type VaultImportJobStatus,
  validateVaultImportPlan,
  vaultImportJobStatus,
} from "./vaultImportPlan";

export async function startVaultImportHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    strategy: "merge" | "folder" | "replace";
    confirmation?: string;
    sourceFingerprint: string;
    totalFiles: number;
    totalBytes: number;
    totalBatches: number;
  },
): Promise<VaultImportJobStatus> {
  validateVaultImportPlan(args);
  if (
    args.strategy === "replace" &&
    !matchesDestructiveActionAcknowledgement(args.confirmation)
  ) {
    throw new ConvexError({
      code: "IMPORT_REPLACE_CONFIRMATION_REQUIRED",
      message: "Type “I understand” before replacing this bucket.",
    });
  }
  const actorUserId = await callerId(ctx);
  await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
  const recent = await ctx.db
    .query("vaultImportJobs")
    .withIndex("by_workspace_createdAt", (q) => q.eq("workspaceId", args.workspaceId))
    .order("desc")
    .take(20);
  const matching = recent.find(
    (job) =>
      job.actorUserId === actorUserId &&
      job.status !== "complete" &&
      job.strategy === args.strategy &&
      job.sourceFingerprint === args.sourceFingerprint &&
      job.totalFiles === args.totalFiles &&
      job.totalBytes === args.totalBytes &&
      job.totalBatches === args.totalBatches,
  );
  const now = Date.now();
  if (matching !== undefined) {
    if (matching.status !== "active") {
      await ctx.db.patch(matching._id, { status: "active", updatedAt: now });
    }
    return vaultImportJobStatus({ ...matching, status: "active", updatedAt: now });
  }
  for (const job of recent) {
    if (job.actorUserId === actorUserId && job.status === "active") {
      await ctx.db.patch(job._id, { status: "paused", updatedAt: now });
    }
  }
  const jobId = await ctx.db.insert("vaultImportJobs", {
    workspaceId: args.workspaceId,
    actorUserId,
    strategy: args.strategy,
    sourceFingerprint: args.sourceFingerprint,
    totalFiles: args.totalFiles,
    totalBytes: args.totalBytes,
    totalBatches: args.totalBatches,
    completedBatches: [],
    completedFiles: 0,
    createdFiles: 0,
    skippedFiles: 0,
    ...(args.strategy === "replace" ? {
      replacement: {
        phase: "counting" as const,
        totalObjects: 0,
        deletedObjects: 0,
      },
    } : {}),
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const created = await ctx.db.get(jobId);
  if (created === null) throw new ConvexError({ code: "IMPORT_JOB_NOT_FOUND", message: "The import could not start." });
  return vaultImportJobStatus(created);
}

export async function recordVaultClearBatchHandler(
  ctx: MutationCtx,
  args: {
    jobId: Id<"vaultImportJobs">;
    actorUserId: Id<"users">;
    workspaceId: Id<"workspaces">;
    sourceFingerprint: string;
    mode: "counted" | "deleted";
    objects: number;
    complete: boolean;
  },
): Promise<VaultImportJobStatus | null> {
  const job = await ctx.db.get(args.jobId);
  if (
    job === null ||
    job.workspaceId !== args.workspaceId ||
    job.actorUserId !== args.actorUserId ||
    job.sourceFingerprint !== args.sourceFingerprint ||
    job.strategy !== "replace" ||
    job.replacement === undefined ||
    !Number.isSafeInteger(args.objects) ||
    args.objects < 0
  ) return null;

  const now = Date.now();
  if (job.replacement.phase === "counting" && args.mode === "counted") {
    const replacement = {
      phase: args.objects === 0 ? "uploading" as const : "deleting" as const,
      totalObjects: args.objects,
      deletedObjects: 0,
    };
    await ctx.db.patch(job._id, { replacement, status: "active", updatedAt: now });
    return vaultImportJobStatus({ ...job, replacement, status: "active", updatedAt: now });
  }
  if (job.replacement.phase === "deleting" && args.mode === "deleted") {
    const rawDeleted = job.replacement.deletedObjects + args.objects;
    const totalObjects = Math.max(job.replacement.totalObjects, rawDeleted);
    const replacement = {
      phase: args.complete ? "uploading" as const : "deleting" as const,
      totalObjects,
      deletedObjects: args.complete ? totalObjects : rawDeleted,
    };
    await ctx.db.patch(job._id, { replacement, status: "active", updatedAt: now });
    return vaultImportJobStatus({ ...job, replacement, status: "active", updatedAt: now });
  }
  return vaultImportJobStatus(job);
}

export async function latestVaultImportJobHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<VaultImportJobStatus | null> {
  const actorUserId = await callerId(ctx);
  await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
  const recent = await ctx.db
    .query("vaultImportJobs")
    .withIndex("by_workspace_createdAt", (q) => q.eq("workspaceId", args.workspaceId))
    .order("desc")
    .take(20);
  const job = recent.find((candidate) => candidate.actorUserId === actorUserId && candidate.status !== "complete");
  return job === undefined ? null : vaultImportJobStatus(job);
}

export async function pauseVaultImportHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; jobId: Id<"vaultImportJobs"> },
): Promise<VaultImportJobStatus | null> {
  const actorUserId = await callerId(ctx);
  await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
  const job = await ctx.db.get(args.jobId);
  if (job === null || job.workspaceId !== args.workspaceId || job.actorUserId !== actorUserId) return null;
  if (job.status === "active") await ctx.db.patch(job._id, { status: "paused", updatedAt: Date.now() });
  return vaultImportJobStatus(job.status === "active" ? { ...job, status: "paused" } : job);
}

export async function recordVaultImportBatchHandler(
  ctx: MutationCtx,
  args: {
    jobId: Id<"vaultImportJobs">;
    actorUserId: Id<"users">;
    workspaceId: Id<"workspaces">;
    sourceFingerprint: string;
    batchIndex: number;
    filesProcessed: number;
    filesCreated: number;
    filesSkipped: number;
  },
): Promise<VaultImportJobStatus | null> {
  const job = await ctx.db.get(args.jobId);
  if (
    job === null ||
    job.workspaceId !== args.workspaceId ||
    job.actorUserId !== args.actorUserId ||
    job.sourceFingerprint !== args.sourceFingerprint
  ) return null;
  if (job.completedBatches.includes(args.batchIndex)) return vaultImportJobStatus(job);
  const completedBatches = [...job.completedBatches, args.batchIndex].sort((left, right) => left - right);
  const completedFiles = job.completedFiles + args.filesProcessed;
  if (
    !Number.isSafeInteger(args.batchIndex) ||
    args.batchIndex < 0 ||
    args.batchIndex >= job.totalBatches ||
    !Number.isSafeInteger(args.filesProcessed) ||
    args.filesProcessed < 1 ||
    args.filesCreated < 0 ||
    args.filesSkipped < 0 ||
    args.filesCreated + args.filesSkipped !== args.filesProcessed ||
    completedFiles > job.totalFiles
  ) return null;
  const complete = completedBatches.length === job.totalBatches && completedFiles === job.totalFiles;
  const now = Date.now();
  const patch = {
    completedBatches,
    completedFiles,
    createdFiles: job.createdFiles + args.filesCreated,
    skippedFiles: job.skippedFiles + args.filesSkipped,
    status: complete ? "complete" as const : "active" as const,
    updatedAt: now,
    ...(complete ? { completedAt: now } : {}),
  };
  await ctx.db.patch(job._id, patch);
  return vaultImportJobStatus({ ...job, ...patch });
}
