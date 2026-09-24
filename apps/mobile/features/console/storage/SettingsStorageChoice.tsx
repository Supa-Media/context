import { View } from "react-native";
import { useConvex } from "convex/react";
import type { Id } from "@context/convex/_generated/dataModel";
import type { StorageActions } from "../types";
import { StorageChoice } from "./StorageChoice";
import { VaultImport } from "./VaultImport";
import { useManagedOffer } from "../../onboarding/useManagedOffer";
import { ManagedConfirm } from "../../onboarding/steps/ManagedConfirm";

/*
  Settings' two storage entry points that need a Convex client: choosing
  storage (with the managed offer when billing is live) and importing a vault
  into storage that is already connected. Both render nothing that subscribes
  when there is no client — the landing page's demo and the render tests.
*/

/** Billing is optional in render fixtures and self-hosted builds. */
export function SettingsStorageChoice({
  workspaceId,
  contextName,
  connect,
  onCancel,
  onOpenPremium,
}: {
  workspaceId: string;
  contextName: string;
  connect: StorageActions["connect"];
  onCancel?: () => void;
  onOpenPremium?: () => void;
}) {
  const client = useConvex();
  if (client === undefined) {
    return <StorageChoice workspaceId={workspaceId} connect={connect} onCancel={onCancel} />;
  }
  return (
    <SettingsStorageChoiceLive
      workspaceId={workspaceId as Id<"workspaces">}
      contextName={contextName}
      connect={connect}
      onCancel={onCancel}
      onOpenPremium={onOpenPremium}
    />
  );
}

function SettingsStorageChoiceLive({
  workspaceId,
  contextName,
  connect,
  onCancel,
  onOpenPremium,
}: {
  workspaceId: Id<"workspaces">;
  contextName: string;
  connect: StorageActions["connect"];
  onCancel?: () => void;
  onOpenPremium?: () => void;
}) {
  const managed = useManagedOffer({ workspaceId, returned: null, origin: "settings" });

  if (managed.mode === "confirm" && managed.status !== null) {
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
      workspaceId={workspaceId}
      connect={connect}
      onCancel={onCancel}
      managed={!managed.available ? undefined : {
        price: managed.price,
        onChoose: () => {
          if (managed.paid) {
            if (managed.status?.selected.managedStorage) onOpenPremium?.();
            else {
              managed.toggle("managedStorage", true);
              onOpenPremium?.();
            }
            return;
          }
          managed.choose();
        },
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
