import { createContext, useContext } from "react";

/**
 * "This note is about to be opened", for the rows deep inside a folder page
 * that would otherwise need the browser threaded through every layer above
 * them. `BrowsePane` provides `FileBrowser.prefetch`; a surface with nothing
 * to read ahead from (the landing page's demo, a test) provides nothing, and
 * the rows then simply do not ask. See `fileBrowser/notePrefetch.ts`.
 */
export const NoteIntentContext = createContext<((path: string) => void) | undefined>(undefined);

export function useNoteIntent(): ((path: string) => void) | undefined {
  return useContext(NoteIntentContext);
}
