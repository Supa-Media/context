/**
 * Built-in folders by job, and folders put in order: the console's half of
 * "built-in folders found by job" (the control plane's half is
 * `apps/convex/functions/lib/nodes/folderJobs.ts` and `functions/folderOrder.ts`).
 *
 * Part of `useFileBrowser`, and the last before the value is assembled,
 * because it reads the listings every earlier part has settled. Two things:
 *
 *  - **`iconOf` draws the job.** A folder whose listing entry carries a job
 *    answers `jobIconMarker(job)` instead of its emoji, so every surface that
 *    draws a folder glyph through `EmojiGlyph` draws the job's icon, an Inbox
 *    renamed Capture included, and an emoji set on it earlier is not shown.
 *  - **The Inbox and the Archive are found by job** for what has no
 *    listings to hand (`jobFoldersNow.ts`).
 *  - **`moveFolder` moves a folder one place among its siblings.** The new
 *    order of that level is worked out from the listing as it is drawn, drawn
 *    at once, and sent to `folderOrder.set`; the live listing then confirms
 *    it. A refusal puts the server's order back and says why.
 */
import { useCallback, useMemo } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { toFileError } from "../browser";
import { listingIsDescending } from "../listingOrder";
import { parentPath } from "../paths";
import { archiveFolder, inboxFolder, loadedJobs, reorderedSiblings, siblingFolders, withFolderOrder } from "../jobIcons/folderJobs";
import { setJobFoldersNow } from "../jobIcons/jobFoldersNow";
import { jobIconMarker } from "../jobIcons/marker";
import type { FileBrowserOptions, Listings } from "./types";

interface FolderJobsDeps {
  options: FileBrowserOptions;
  listings: Listings;
  iconOf: (path: string) => string | null;
  drawLocally: (change: (current: Listings) => Listings) => void;
  refresh: (folders: readonly string[]) => Promise<unknown>;
  say: (message: string) => void;
}

export interface FolderJobsValues {
  iconOf: (path: string) => string | null;
  moveFolder: (path: string, direction: "up" | "down") => void;
}

export function useFolderJobs(deps: FolderJobsDeps): FolderJobsValues {
  const { options, listings, iconOf: emojiOf, drawLocally, refresh, say } = deps;
  const workspaceId = options.workspaceId as Id<"workspaces"> | null;
  const setOrder = useAction(api.functions.folderOrder.set);

  const jobs = useMemo(() => {
    /*
      The phone's pages (built from notes, not listings) and Restore find the
      Inbox and the Archive through `jobFoldersNow`: told here, as the listings
      change and before anything drawn from them, so nothing reads the old
      name a frame late. Idempotent, which is what lets it sit in a memo.
    */
    setJobFoldersNow({ inbox: inboxFolder(listings), archive: archiveFolder(listings) });
    return loadedJobs(listings);
  }, [listings]);
  const iconOf = useCallback(
    (path: string) => {
      const job = jobs.get(path);
      return job === undefined ? emojiOf(path) : jobIconMarker(job);
    },
    [emojiOf, jobs],
  );

  const moveFolder = useCallback(
    (path: string, direction: "up" | "down") => {
      if (!options.canEdit || workspaceId === null) return;
      const siblings = siblingFolders(listings, path);
      if (siblings === null) return;
      // Up as the list is drawn: Z to A draws the server's order backwards.
      const way = listingIsDescending() ? (direction === "up" ? "down" : "up") : direction;
      const folders = reorderedSiblings(siblings, path, way);
      if (folders === null) return;
      const parent = parentPath(path);
      drawLocally((current) => {
        const listing = current[parent];
        return listing === undefined ? current : { ...current, [parent]: withFolderOrder(parent, listing, folders) };
      });
      void setOrder({ workspaceId, parent, folders }).catch((error: unknown) => {
        say(toFileError(error).message);
        // The order drawn above was never written: show the one that was.
        void refresh([parent]).catch(() => undefined);
      });
    },
    [drawLocally, listings, options.canEdit, refresh, say, setOrder, workspaceId],
  );

  return { iconOf, moveFolder };
}
