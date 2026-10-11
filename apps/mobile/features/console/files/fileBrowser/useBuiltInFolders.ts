/**
 * "Add a folder": make one of the workspace's built-in folders (Clients, Teams,
 * Products, or a main folder an older workspace lacks) under its fixed name.
 *
 * Part of `useFileBrowser`. Unlike the other folder writes this one does not go
 * through `run`: the sheet that asked needs the server's own sentence back, to
 * show in the sheet, and `run` would put it on the notice line behind the
 * sheet. So this rejects on failure and the caller decides what to say.
 */
import { useCallback } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { foldersToRefresh } from "../tree";
import type { FileBrowserOptions } from "./types";
import type { ListingsValues } from "./useListings";

type BuiltInFoldersDeps = { options: FileBrowserOptions } & Pick<ListingsValues, "refresh">;

export interface BuiltInFoldersValues {
  /** Add the folder for `role`. Resolves with its path; rejects with the server's refusal. */
  addBuiltInFolder: (role: string) => Promise<string>;
}

export function useBuiltInFolders(deps: BuiltInFoldersDeps): BuiltInFoldersValues {
  const { options, refresh } = deps;
  const workspaceId = options.workspaceId as Id<"workspaces"> | null;
  const addAction = useAction(api.functions.builtInFolders.add);

  const addBuiltInFolder = useCallback(
    async (role: string): Promise<string> => {
      if (!options.canEdit || workspaceId === null) throw new Error("This console cannot add folders.");
      const { path } = await addAction({ workspaceId, role });
      // The folder is real now, so the tree must show it. A failed reload is
      // not a failed add, and the sheet has already been told it worked.
      try {
        await refresh(foldersToRefresh([path]));
      } catch {
        // The next listing read shows the folder; nothing to say about this one.
      }
      return path;
    },
    [addAction, options.canEdit, refresh, workspaceId],
  );

  return { addBuiltInFolder };
}
