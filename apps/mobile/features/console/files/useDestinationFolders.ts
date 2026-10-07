import { useCallback, useMemo, useRef, useState } from "react";

/** One folder's own folders, as another workspace answers for them. */
export type FolderLoad = { folders: readonly string[]; truncated: boolean } | "loading" | "failed";

/** What the move dialog draws for one other workspace. */
export interface DestinationView {
  /** How its top level is doing: `undefined` before anything was asked. */
  top: FolderLoad | undefined;
  /** Every folder read so far, at whatever depth. */
  folders: readonly string[];
  /** Folders whose own folders have not been read, so they may have some. */
  unexplored: ReadonlySet<string>;
  /** Folders being read right now. */
  loading: ReadonlySet<string>;
  /** Some folder's list came back cut short. */
  truncated: boolean;
}

const EMPTY: DestinationView = {
  top: undefined,
  folders: [],
  unexplored: new Set(),
  loading: new Set(),
  truncated: false,
};

/**
 * Another workspace's folders, read a level at a time.
 *
 * **One level per ask, and that is the fix for a dialog that sat on "Reading
 * its folders…".** The first version asked for the whole tree in one call
 * (`folderPaths`), which walks the far bucket breadth-first with one listing
 * per folder — up to two hundred of them, one after another, before anything
 * was drawn. A workspace with a few hundred folders kept somebody waiting on
 * a list whose first level is all they look at. Now opening the dialog reads
 * the top level, and opening a folder reads that folder: the same shape as
 * the tree in the sidebar, and the same `listFiles` it uses.
 *
 * Kept until the dialog closes, so flipping between two workspaces, or closing
 * and reopening a folder, does not read anything twice. A folder that failed
 * is forgotten, so opening it again tries again.
 */
export function useDestinationFolders(
  load: ((contextId: string, folder: string) => Promise<{ folders: readonly string[]; truncated: boolean }>) | undefined,
) {
  const [loads, setLoads] = useState<Record<string, Record<string, FolderLoad>>>({});
  // What has been asked, outside state: two presses inside one render must not
  // both start a read, and state set in the first is not visible to the second.
  const asked = useRef(new Set<string>());

  const open = useCallback(
    (contextId: string, folder: string) => {
      const key = `${contextId}\n${folder}`;
      if (load === undefined || asked.current.has(key)) return;
      asked.current.add(key);
      const set = (value: FolderLoad) =>
        setLoads((current) => ({
          ...current,
          [contextId]: { ...current[contextId], [folder]: value },
        }));
      set("loading");
      load(contextId, folder)
        .then(set)
        .catch(() => {
          asked.current.delete(key);
          set("failed");
        });
    },
    [load],
  );

  const view = useCallback(
    (contextId: string | null): DestinationView => {
      if (contextId === null) return EMPTY;
      const byFolder = loads[contextId] ?? {};
      const folders: string[] = [];
      const loading = new Set<string>();
      let truncated = false;
      for (const [folder, state] of Object.entries(byFolder)) {
        if (state === "loading") loading.add(folder);
        else if (state !== "failed") {
          folders.push(...state.folders);
          truncated ||= state.truncated;
        }
      }
      const unexplored = new Set(
        folders.filter((folder) => {
          const state = byFolder[folder];
          return state === undefined || state === "loading" || state === "failed";
        }),
      );
      return { top: byFolder[""], folders, unexplored, loading, truncated };
    },
    [loads],
  );

  return useMemo(() => ({ open, view }), [open, view]);
}
