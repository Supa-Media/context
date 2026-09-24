/**
 * The limits on a local vault import, and the status a job row reports.
 *
 * Split out of `functions/files.ts`, which registers the import's functions.
 */

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";

export const MAX_VAULT_IMPORT_BATCH_FILES = 20;
export const MAX_VAULT_IMPORT_BATCH_BYTES = 4_500_000;
const MAX_VAULT_IMPORT_FILES = 100_000;
const MAX_VAULT_IMPORT_BATCHES = 5_000;
const VAULT_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type VaultImportJobStatus = {
  jobId: Id<"vaultImportJobs">;
  strategy: "merge" | "folder" | "replace";
  status: "active" | "paused" | "complete";
  totalFiles: number;
  completedFiles: number;
  createdFiles: number;
  skippedFiles: number;
  completedBatches: number[];
  replacement?: {
    phase: "counting" | "deleting" | "uploading";
    totalObjects: number;
    deletedObjects: number;
  };
};

export function vaultImportJobStatus(job: Doc<"vaultImportJobs">): VaultImportJobStatus {
  return {
    jobId: job._id,
    strategy: job.strategy,
    status: job.status,
    totalFiles: job.totalFiles,
    completedFiles: job.completedFiles,
    createdFiles: job.createdFiles,
    skippedFiles: job.skippedFiles,
    completedBatches: [...job.completedBatches].sort((left, right) => left - right),
    ...(job.replacement === undefined ? {} : { replacement: job.replacement }),
  };
}

export function validateVaultImportPlan(args: {
  sourceFingerprint: string;
  totalFiles: number;
  totalBytes: number;
  totalBatches: number;
}): void {
  if (!VAULT_FINGERPRINT_PATTERN.test(args.sourceFingerprint)) {
    throw new ConvexError({ code: "IMPORT_PLAN_INVALID", message: "Choose the vault again to start this import." });
  }
  if (
    !Number.isSafeInteger(args.totalFiles) ||
    args.totalFiles < 1 ||
    args.totalFiles > MAX_VAULT_IMPORT_FILES ||
    !Number.isSafeInteger(args.totalBytes) ||
    args.totalBytes < 0 ||
    !Number.isSafeInteger(args.totalBatches) ||
    args.totalBatches < 1 ||
    args.totalBatches > MAX_VAULT_IMPORT_BATCHES ||
    args.totalBatches > args.totalFiles
  ) {
    throw new ConvexError({ code: "IMPORT_PLAN_INVALID", message: "That vault is too large to import safely." });
  }
}
