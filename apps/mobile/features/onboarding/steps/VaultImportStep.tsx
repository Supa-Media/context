import { VaultImport } from "../../console/storage/VaultImport";
import type { OnboardingController } from "../useOnboarding";

/** The fork between importing an existing vault and starting a new workspace. */
export function VaultImportStep({ controller }: { controller: OnboardingController }) {
  const workspaceId = controller.claimed?.workspaceId;
  if (workspaceId === undefined) return null;
  return (
    <VaultImport
      workspaceId={workspaceId}
      onSkip={controller.skipVaultImport}
      onComplete={() => controller.finishVaultImport("imported")}
      initializePrivacy
      existingData={controller.structureStep?.kind === "existing"}
      testIDPrefix="welcome-vault"
    />
  );
}
