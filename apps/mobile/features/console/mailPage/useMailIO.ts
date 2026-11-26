/** The Mail page's note reads and saves: the same read the editor opens a note with, and the app's own save. */

import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useMemo, useRef } from "react";
import { dataUrlFor } from "../files/imageBytes";
import { useWriteNote } from "../files/useWriteNote";
import type { MailNoteIO } from "./MailThread";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../placeholderData";
import { askMailGateway, mailNotesUrl, mailReadsAnswer } from "./useMailNotes";

export function useMailIO(workspaceId: string): MailNoteIO {
  const readNote = useAction(api.functions.files.readNote);
  const readNoteImage = useAction(api.functions.files.readNoteImage);
  const writeNote = useWriteNote();
  // Held in a ref, as the notes list holds it: a new grant function must not make a new IO and read every face again.
  const latest = useConsoleGrant();
  const grant = useRef(latest);
  grant.current = latest;
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
      // Opening a conversation is reading it: the read is kept, and who has read it comes back (`/files/mail` `{read}`).
      reads: async (path) => {
        const url = mailNotesUrl(MCP_ENDPOINT);
        if (url === null) return null;
        const token = async (refresh: false | { rejected: string }) => (await grant.current({ workspaceId: id }, refresh)).accessToken;
        const body = await askMailGateway({ url, token, body: { read: path } }).catch(() => null);
        return body === null ? null : mailReadsAnswer(body);
      },
    };
  }, [readNote, readNoteImage, writeNote, workspaceId]);
}
