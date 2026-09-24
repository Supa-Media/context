import { useMemo } from "react";
import { onMirrorListed } from "./mirrorEvents";
import { mirroredListNotes } from "./mirrorLists";
import { openMirrorStore } from "./mirrorStore";
import type { FolderListSource } from "../console/files/listBlock/model";
import { visibilityTierForRole } from "../console/visibility";

/**
 * Where the console's folder lists read their notes: this device's copy of
 * one workspace, at the clearance its role gives — `useDeviceSearch`'s rule.
 * `undefined` for a role with no clearance, and the lists stay as source.
 *
 * A list redraws whenever the mirror commits a new listing of the workspace,
 * which is how "it updates as notes change" is kept without a second channel.
 */
export function useFolderLists(
  workspaceId: string | null | undefined,
  role: string | undefined,
): FolderListSource | undefined {
  const tier = visibilityTierForRole(role);
  return useMemo(() => {
    if (workspaceId == null || tier === "unknown") return undefined;
    return {
      load: async (folder: string, subfolders: boolean) => {
        const store = await openMirrorStore();
        if (store === null) return null;
        return mirroredListNotes(store, tier, workspaceId, folder, subfolders);
      },
      subscribe: (listener: () => void) =>
        onMirrorListed((listed) => {
          if (listed === workspaceId) listener();
        }),
    };
  }, [workspaceId, tier]);
}
