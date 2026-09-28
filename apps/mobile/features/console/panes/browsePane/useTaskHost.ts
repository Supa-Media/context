import { useMemo } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type { Dialog } from "../../files/actions";
import type { FileBrowser } from "../../files/browser";
import { announceBucketWrite } from "../../files/bucketWrites";
import type { FolderListSource } from "../../files/listBlock/model";
import type { ListWriteBack } from "../../../offline/folderListSource";
import type { TaskHost } from "../../files/folderPage/tasks/taskHost";
import { taskWriteIO } from "../../files/folderPage/tasks/taskWrites";

/**
 * What a project's List and its side panel add, nest and move tasks with —
 * the one road for both: the console's own
 * `writeNote` (with no version, so it never replaces a note), `moveEntry`
 * (which rewrites every link to what moved) and `trashEntry` (how an added
 * task is undone), through `taskWriteIO`; the file browser's toast for the
 * Undo; its listings, read again; its archive dialog; and the share sheet's
 * Copy link, for an owner.
 *
 * Undefined where the console cannot write or there is no notes source to
 * write properties through — a member, a visitor, the landing page's demo —
 * and the List then offers none of it.
 */
export function useTaskHost(
  files: FileBrowser,
  workspaceId: string | null | undefined,
  source: (FolderListSource & ListWriteBack) | undefined,
  setDialog: (dialog: Dialog) => void,
): TaskHost | undefined {
  const writeNote = useAction(api.functions.files.writeNote);
  const moveEntry = useAction(api.functions.files.moveEntry);
  const trashEntry = useAction(api.functions.files.trashEntry);
  const { canEdit, canShare, say, ensureListing, copyShareLink } = files;
  const setProperties = source?.setProperties;
  const remember = source?.remember;
  return useMemo(() => {
    if (!canEdit || workspaceId == null) return undefined;
    const id = workspaceId as Id<"workspaces">;
    // Each announced once it has landed, so the rest of the console reloads what it changed too.
    const told = (path: string) => announceBucketWrite({ workspaceId, path });
    const io = taskWriteIO({
      workspaceId: id,
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
    });
    if (io === null) return undefined;
    return {
      io,
      say,
      ...(remember === undefined ? {} : { remember }),
      refresh: (folders) => {
        for (const folder of new Set(folders)) ensureListing(folder, true);
      },
      archive: (paths) => setDialog(paths.length === 1 ? { kind: "archive", path: paths[0]! } : { kind: "archiveMany", paths: [...paths] }),
      ...(canShare
        ? {
            copyLink: (path: string) =>
              void copyShareLink({ kind: "team", path }).then(({ message }) => {
                if (message !== null) say(message);
              }),
          }
        : {}),
    };
  }, [canEdit, canShare, workspaceId, writeNote, moveEntry, trashEntry, setProperties, remember, say, ensureListing, copyShareLink, setDialog]);
}
