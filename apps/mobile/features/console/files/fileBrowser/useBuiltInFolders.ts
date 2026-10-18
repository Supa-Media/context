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
import type { FolderJobsAnswer } from "../folderJobsView";

type BuiltInFoldersDeps = { options: FileBrowserOptions } & Pick<ListingsValues, "refresh">;

export interface BuiltInFoldersValues {
  /** Add the folder for `role`. Resolves with its path; rejects with the server's refusal. */
  addBuiltInFolder: (role: string) => Promise<string>;
  /** Which folder does each job, wherever it is nested (`builtInFolders.jobs`). */
  folderJobs: () => Promise<FolderJobsAnswer>;
  /** Give `job` to the folder at `path`, or take it away (`null`). Owner. Rejects with the server's sentence. */
  setFolderJob: (job: string, path: string | null) => Promise<void>;
}

export function useBuiltInFolders(deps: BuiltInFoldersDeps): BuiltInFoldersValues {
  const { options, refresh } = deps;
  const workspaceId = options.workspaceId as Id<"workspaces"> | null;
  const addAction = useAction(api.functions.builtInFolders.add);
  const jobsAction = useAction(api.functions.builtInFolders.jobs);
  const setJobAction = useAction(api.functions.builtInFolders.setJob);

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

  const folderJobs = useCallback(async (): Promise<FolderJobsAnswer> => {
    if (workspaceId === null) throw new Error("No workspace is open.");
    return await jobsAction({ workspaceId });
  }, [jobsAction, workspaceId]);

  const setFolderJob = useCallback(
    async (job: string, path: string | null): Promise<void> => {
      if (workspaceId === null) throw new Error("No workspace is open.");
      await setJobAction({ workspaceId, job, path });
      // Every listing draws a folder's job icon, so the folders on screen are read again.
      try {
        await refresh(foldersToRefresh(path === null ? [""] : [path, ""]));
      } catch {
        // The next listing read shows it.
      }
    },
    [refresh, setJobAction, workspaceId],
  );

  return { addBuiltInFolder, folderJobs, setFolderJob };
}
