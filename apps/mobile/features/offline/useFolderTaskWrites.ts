import { useMemo } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { announceBucketWrite } from "../console/files/bucketWrites";
import { capabilitiesForRole } from "../console/capabilities";
import { taskWriteIO, type TaskWriteIO } from "../console/files/folderPage/tasks/taskWrites";
import type { FolderListSource } from "../console/files/listBlock/model";

/**
 * The file writes a project's folder page makes beyond a property line — a
 * new subtask or note, a one-note task turned into a folder — as the
 * console's own actions: `writeNote` with no version (a create, which the
 * server refuses over a note that appeared), `moveEntry` (which rewrites the
 * links to what moved) and `trashEntry` (how a create is undone).
 *
 * Each is announced once it has landed (`announceBucketWrite`), so the file
 * browser reloads the folders it changed, as it does for every write made
 * outside it. `undefined` for a role that may not write, and for a page whose
 * source cannot write properties either: nothing is then offered that would
 * need it.
 */
export function useFolderTaskWrites(
  workspaceId: string | null | undefined,
  role: string | undefined,
  source: FolderListSource | undefined,
): TaskWriteIO | undefined {
  const writeNote = useAction(api.functions.files.writeNote);
  const moveEntry = useAction(api.functions.files.moveEntry);
  const trashEntry = useAction(api.functions.files.trashEntry);
  const canEdit = capabilitiesForRole(role).canEdit;
  const setProperties = source?.setProperties;
  return useMemo(() => {
    if (workspaceId == null || !canEdit || setProperties === undefined) return undefined;
    const told = (path: string) => announceBucketWrite({ workspaceId, path });
    return (
      taskWriteIO({
        workspaceId: workspaceId as Id<"workspaces">,
        writeNote: async (args) => {
          const written = await writeNote(args);
          told(written.path);
          return written;
        },
        moveEntry: async (args) => {
          const moved = await moveEntry(args);
          told(args.from);
          told(args.to);
          return moved;
        },
        trashEntry: async (args) => {
          const trashed = await trashEntry(args);
          told(args.path);
          return trashed;
        },
        setProperties,
      }) ?? undefined
    );
  }, [workspaceId, canEdit, setProperties, writeNote, moveEntry, trashEntry]);
}
