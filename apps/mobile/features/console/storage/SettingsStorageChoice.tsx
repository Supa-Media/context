/**
 * Choosing storage from Settings, and importing a vault once it is live.
 *
 * Split out of `panes/SettingsPane.tsx`. Billing is optional in render
 * fixtures and self-hosted builds, so each wrapper renders the plain chooser
 * when there is no Convex client and the managed-storage offer when there is.
 */

import { View } from "react-native";
import { useConvex } from "convex/react";
import type { Id } from "@context/convex/_generated/dataModel";
import type { StorageActions } from "../types";
import { StorageChoice } from "./StorageChoice";
import { VaultImport } from "./VaultImport";
import { useManagedOffer } from "../../onboarding/useManagedOffer";
import { ManagedConfirm } from "../../onboarding/steps/ManagedConfirm";
import { ManagedSettling } from "../../onboarding/steps/ManagedSettling";

/** Billing is optional in render fixtures and self-hosted builds. */
export function SettingsStorageChoice({
  workspaceId,
  contextName,
  connect,
  onCancel,
}: {
  workspaceId: string;
  contextName: string;
  connect: StorageActions["connect"];
  onCancel?: () => void;
}) {
  const client = useConvex();
  if (client === undefined) {
    return <StorageChoice connect={connect} onCancel={onCancel} />;
  }
  return (
    <SettingsStorageChoiceLive
      workspaceId={workspaceId as Id<"workspaces">}
      contextName={contextName}
      connect={connect}
      onCancel={onCancel}
    />
  );
}

function SettingsStorageChoiceLive({
  workspaceId,
  contextName,
  connect,
  onCancel,
}: {
  workspaceId: Id<"workspaces">;
  contextName: string;
  connect: StorageActions["connect"];
  onCancel?: () => void;
}) {
  const managed = useManagedOffer({ workspaceId, returned: null, origin: "settings" });

  if (managed.mode === "settling") {
    return (
      <ManagedSettling
        state={{
          paid: managed.paid,
          stagingFreeStorage: managed.status?.stagingFreeStorage,
          free: managed.startedFree || !managed.selling,
          storageReady: managed.status?.managedProvisioning === "ready",
          slow: managed.slow,
          failure: managed.provisionFailure,
        }}
        contextName={contextName}
        onUseOwnStorage={managed.back}
        onRetry={managed.retry}
      />
    );
  }

  // The confirm screen is a payment step: dormant while nothing is sold.
  if (managed.mode === "confirm" && managed.status !== null && managed.selling) {
    return (
      <ManagedConfirm
        status={managed.status}
        contextName={contextName}
        state={managed.session}
        failure={managed.failure}
        onToggle={managed.toggle}
        onContinue={managed.proceed}
        onBack={managed.back}
      />
    );
  }

  return (
    <StorageChoice
      connect={connect}
      onCancel={onCancel}
      ours={managed.ours ?? undefined}
      managed={!managed.selling || managed.paid || !managed.available ? undefined : {
        price: managed.price,
        founding: managed.founding,
        onChoose: managed.choose,
      }}
    />
  );
}

/** Existing owners get the same create-only importer after storage is live. */
export function SettingsVaultImport({ workspaceId }: { workspaceId: string }) {
  const client = useConvex();
  if (client === undefined) return null;
  return (
    <View style={{ marginTop: 24 }}>
      <VaultImport
        workspaceId={workspaceId as Id<"workspaces">}
        existingData
        testIDPrefix="settings-vault"
      />
    </View>
  );
}
