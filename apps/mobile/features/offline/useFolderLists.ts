import { useMemo } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { announceBucketWrite } from "../console/files/bucketWrites";
import { capabilitiesForRole } from "../console/capabilities";
import { folderListSource } from "./folderListSource";
import { neededEtags } from "./mirrorHolds";
import { openMirrorStore } from "./mirrorStore";
import { openStore } from "./store";
import type { FolderListSource } from "../console/files/listBlock/model";
import { visibilityTierForRole } from "../console/visibility";

/**
 * Where the console's folder lists read their notes: this device's copy of
 * one workspace, at the clearance its role gives — `useDeviceSearch`'s rule.
 * `undefined` for a role with no clearance, and the lists stay as source.
 *
 * A list redraws whenever the mirror commits a new listing of the workspace or
 * new bodies for it, which is how "it updates as notes change" is kept without
 * a second channel.
 *
 * An owner or editor can also change a listed note's status or owner from the
 * list: `setProperty` reads the note from the bucket, changes that one line and
 * writes it back against the version read, then puts the note it wrote back
 * into this device's copy so the list — and the next reload — reads what was
 * saved. `folderListSource` carries the whole road; this hook only hands it
 * the Convex actions. A folder page may ask for the note to be created
 * (`create`), for a folder whose first property has nowhere to go yet.
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
    const id = workspaceId as Id<"workspaces">;
    return folderListSource({
      workspaceId,
      scope: tier,
      canEdit,
      openMirror: openMirrorStore,
      needed: (workspace) => neededEtags(openStore(), workspace),
      io: {
        readNote: (path) => readNote({ workspaceId: id, path }),
        writeNote: async (path, text, expectedEtag) => {
          // No version is a create, which the server refuses over an existing note.
          const written = await writeNote({
            workspaceId: id,
            path,
            text,
            ...(expectedEtag === undefined ? {} : { expectedEtag }),
          });
          // The file browser's listing is told, as every write outside it does.
          announceBucketWrite({ workspaceId, path: written.path });
          return written;
        },
      },
    });
  }, [workspaceId, tier, canEdit, readNote, writeNote]);
}
