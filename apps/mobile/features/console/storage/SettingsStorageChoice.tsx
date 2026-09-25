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

/** Billing is optional in render fixtures and self-hosted builds. */
export function SettingsStorageChoice({
  workspaceId,
  contextName,
  connect,
  onCancel,
  onOpenPremium,
  allowDropbox = false,
}: {
  workspaceId: string;
  contextName: string;
  connect: StorageActions["connect"];
  onCancel?: () => void;
  onOpenPremium?: () => void;
  /** Only when this context's current binding is already Dropbox. */
  allowDropbox?: boolean;
}) {
  const client = useConvex();
  if (client === undefined) {
    return (
      <StorageChoice
        workspaceId={workspaceId}
        connect={connect}
        onCancel={onCancel}
        allowDropbox={allowDropbox}
      />
    );
  }
  return (
    <SettingsStorageChoiceLive
      workspaceId={workspaceId as Id<"workspaces">}
      contextName={contextName}
      connect={connect}
      onCancel={onCancel}
      onOpenPremium={onOpenPremium}
      allowDropbox={allowDropbox}
    />
  );
}

function SettingsStorageChoiceLive({
  workspaceId,
  contextName,
  connect,
  onCancel,
  onOpenPremium,
  allowDropbox,
}: {
  workspaceId: Id<"workspaces">;
  contextName: string;
  connect: StorageActions["connect"];
  onCancel?: () => void;
  onOpenPremium?: () => void;
  allowDropbox: boolean;
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
      allowDropbox={allowDropbox}
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
