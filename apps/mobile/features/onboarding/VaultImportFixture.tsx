import type { Id } from "@context/convex/_generated/dataModel";
import { VaultImportBody } from "../console/storage/VaultImport";

/** Browser-only fixture for the real directory picker and import states. */
export function VaultImportFixture() {
  let totalFiles = 0;
  let strategy: "merge" | "folder" | "replace" = "merge";
  return (
    <VaultImportBody
      workspaceId={"fixture-workspace" as Id<"workspaces">}
      existingData
      startJob={async (args) => {
        totalFiles = args.totalFiles;
        strategy = args.strategy;
        return {
          jobId: "fixture-vault-job" as Id<"vaultImportJobs">,
          strategy: args.strategy,
          status: "active",
          totalFiles,
          completedFiles: 0,
          createdFiles: 0,
          skippedFiles: 0,
          completedBatches: [],
          ...(strategy === "replace" ? {
            replacement: {
              phase: "counting" as const,
              totalObjects: 0,
              deletedObjects: 0,
            },
          } : {}),
        };
      }}
      clearReplacementBatch={async (args) => ({
        jobId: args.jobId,
        strategy: "replace",
        status: "active",
        totalFiles,
        completedFiles: 0,
        createdFiles: 0,
        skippedFiles: 0,
        completedBatches: [],
        replacement: {
          phase: "uploading",
          totalObjects: 12,
          deletedObjects: 12,
        },
      })}
      importBatch={async (args) => ({
        jobId: args.jobId,
        strategy,
        status: "complete",
        totalFiles,
        completedFiles: totalFiles,
        createdFiles: totalFiles,
        skippedFiles: 0,
        completedBatches: [args.batchIndex],
        ...(strategy === "replace" ? {
          replacement: {
            phase: "uploading" as const,
            totalObjects: 12,
            deletedObjects: 12,
          },
        } : {}),
      })}
      pauseJob={async () => {}}
      testIDPrefix="fixture-vault"
    />
  );
}
