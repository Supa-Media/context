import { useMemo } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { announceBucketWrite } from "../console/files/bucketWrites";
import { capabilitiesForRole } from "../console/capabilities";
import { writeNoteProperty } from "../console/files/listBlock/writeProperty";
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
 *
 * An owner or editor can also change a listed note's status or owner from the
 * list: `setProperty` reads the note from the bucket, changes that one line and
 * writes it back against the version read. The device copy is only ever read
 * here, never written, so a list edit takes the same road as any other save.
 */
export function useFolderLists(
  workspaceId: string | null | undefined,
  role: string | undefined,
): FolderListSource | undefined {
  const tier = visibilityTierForRole(role);
  const readNote = useAction(api.functions.files.readNote);
  const writeNote = useAction(api.functions.files.writeNote);
  const canEdit = capabilitiesForRole(role).canEdit;
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
      ...(canEdit
        ? {
            setProperty: (path: string, key: string, value: string | null) =>
              writeNoteProperty(
                {
                  read: (at) => readNote({ workspaceId: workspaceId as Id<"workspaces">, path: at }),
                  write: async (at, text, expectedEtag) => {
                    const written = await writeNote({ workspaceId: workspaceId as Id<"workspaces">, path: at, text, expectedEtag });
                    // The file browser's listing is told, as every write outside it does.
                    announceBucketWrite({ workspaceId, path: written.path });
                    return written;
                  },
                },
                path,
                key,
                value,
              ),
          }
        : {}),
    };
  }, [workspaceId, tier, canEdit, readNote, writeNote]);
}

