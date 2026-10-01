import { useEffect, useMemo, useRef } from "react";
import { setNoteProperty } from "../../../mcp/src/lists.js";
import type { FolderListSource, ListNote, PropertyValue } from "../console/files/listBlock/model";
import { noteFromText } from "../console/files/folderPage/tasks/pendingNotes";

/**
 * Where the homepage's folder pages and list blocks read their notes: the
 * visitor's own copy of the site (`useLocalFileBrowser`), not a device's
 * mirror of a workspace, which the homepage has none of.
 *
 * It is the console's `FolderListSource`, so a projects folder draws the
 * console's own List and Board, and it tells them whenever a note changes,
 * so a status an assistant sets in a scene moves its row as it happens (Dev2,
 * 2026-09-30: "project items status getting updated in list view … in real
 * time"). A visitor changing a status from the list writes the same one line
 * a real list writes (`setNoteProperty`), into this tab only.
 */
export function useLocalFolderLists(
  notes: Readonly<Record<string, string>>,
  write: (path: string, text: string, create: boolean) => boolean,
): FolderListSource {
  const notesRef = useRef(notes);
  const writeRef = useRef(write);
  writeRef.current = write;
  const listeners = useRef(new Set<() => void>());
  // When each note last changed, for a list's "updated" and its sort.
  const times = useRef(new Map<string, number>());

  useEffect(() => {
    const before = notesRef.current;
    notesRef.current = notes;
    if (before === notes) return;
    const now = Date.now();
    for (const [path, text] of Object.entries(notes)) if (before[path] !== text) times.current.set(path, now);
    for (const listener of [...listeners.current]) listener();
  }, [notes]);

  return useMemo<FolderListSource>(() => {
    const setProperties = async (
      path: string,
      changes: readonly (readonly [string, string | readonly string[] | null])[],
      options?: { create?: boolean },
    ) => {
      const had = notesRef.current[path];
      let text = had ?? (options?.create === true ? "" : null);
      if (text === null) return "That note isn’t here any more.";
      for (const [key, value] of changes) {
        const next = setNoteProperty(text, key, value as PropertyValue | null) as { text: string } | { error: string };
        if ("error" in next) return next.error;
        text = next.text;
      }
      return writeRef.current(path, text, had === undefined) ? null : "That note could not be changed here.";
    };
    return {
      load: async (folder, subfolders) => {
        const prefix = folder === "" ? "" : `${folder}/`;
        const listed: ListNote[] = [];
        for (const [path, text] of Object.entries(notesRef.current)) {
          if (!path.startsWith(prefix)) continue;
          if (!subfolders && path.slice(prefix.length).includes("/")) continue;
          listed.push(noteFromText(path, text, times.current.get(path) ?? 0));
        }
        return { notes: listed, complete: true };
      },
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
      },
      readBody: async (path) => {
        const text = notesRef.current[path];
        return text === undefined ? null : { text, encrypted: false };
      },
      setProperty: (path, key, value, options) => setProperties(path, [[key, value]], options),
      setProperties,
    };
  }, []);
}
