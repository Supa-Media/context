/** The Mail page's note reads and saves: the same read the editor opens a note with, and the app's own save. */

import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useMemo } from "react";
import { dataUrlFor } from "../files/imageBytes";
import { useWriteNote } from "../files/useWriteNote";
import type { MailNoteIO } from "./MailThread";

export function useMailIO(workspaceId: string): MailNoteIO {
  const readNote = useAction(api.functions.files.readNote);
  const readNoteImage = useAction(api.functions.files.readNoteImage);
  const writeNote = useWriteNote();
  return useMemo(() => {
    const id = workspaceId as Id<"workspaces">;
    return {
      read: (path) => readNote({ workspaceId: id, path }),
      write: (path, text, expectedEtag) => writeNote({ workspaceId: id, path, text, expectedEtag }),
      // A bot's logo, named on its card: read through the card, which is its gate, as the bots page reads it.
      picture: async (notePath, leaf) => {
        try {
          const read = await readNoteImage({ workspaceId: id, notePath, leaf });
          return dataUrlFor(read.bytes, read.contentType);
        } catch {
          return null;
        }
      },
      pictureKey: (leaf) => `${workspaceId}|${leaf}`,
    };
  }, [readNote, readNoteImage, writeNote, workspaceId]);
}
