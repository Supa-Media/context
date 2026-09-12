import type { Id } from "@context/convex/_generated/dataModel";
import { VaultImportBody } from "../console/storage/VaultImport";

/** Browser-only fixture for the real directory picker and import states. */
export function VaultImportFixture() {
  let totalFiles = 0;
  return (
    <VaultImportBody
      workspaceId={"fixture-workspace" as Id<"workspaces">}
      existingData
      startJob={async (args) => {
        totalFiles = args.totalFiles;
        return {
          jobId: "fixture-vault-job" as Id<"vaultImportJobs">,
          strategy: args.strategy,
          status: "active",
          totalFiles,
          completedFiles: 0,
          createdFiles: 0,
          skippedFiles: 0,
          completedBatches: [],
        };
      }}
      importBatch={async (args) => ({
        jobId: args.jobId,
        strategy: "merge",
        status: "complete",
        totalFiles,
        completedFiles: totalFiles,
        createdFiles: totalFiles,
        skippedFiles: 0,
        completedBatches: [args.batchIndex],
      })}
      pauseJob={async () => {}}
      testIDPrefix="fixture-vault"
    />
  );
}
