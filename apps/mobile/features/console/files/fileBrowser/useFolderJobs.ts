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
 *    Archive's copy of one (`archiveOf`) draws the same icon in grey with
 *    Archive's box on it (`twinIconMarker`). Tex's own folders and notes
 *    draw their parts (`texPartIconUnder`) under a Tex folder nested anywhere.
 *  - **The Inbox and the Archive are found by job** for what has no
 *    listings to hand (`jobFoldersNow.ts`).
 *  - **`moveFolder` moves a folder one place among its siblings.** The new
 *    order of that level is worked out from the listing as it is drawn, drawn
 *    at once, and sent to `folderOrder.set`; the live listing then confirms
 *    it. A refusal puts the server's order back and says why.
 *  - **`placeFolder` puts a dragged folder at a place** (`treeDrop.ts`): in
 *    its own level the same reorder with the order the drop gave; from
 *    another level, `move` first and the order once the move has landed, so
 *    the order never names a folder the server has not got there yet.
 */
import { useCallback, useMemo } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { toFileError } from "../browser";
import { listingIsDescending } from "../listingOrder";
import { parentPath } from "../paths";
import { archiveFolder, inboxFolder, loadedJobs, loadedTwins, texPartIconUnder, projectsFolder, reorderedSiblings, siblingFolders, websiteFolder, withFolderOrder } from "../jobIcons/folderJobs";
import { setJobFoldersNow } from "../jobIcons/jobFoldersNow";
import { jobIconMarker, twinIconMarker } from "../jobIcons/marker";
import type { FileBrowserOptions, Listings } from "./types";

interface FolderJobsDeps {
  options: FileBrowserOptions;
  listings: Listings;
  iconOf: (path: string) => string | null;
  drawLocally: (change: (current: Listings) => Listings) => void;
  refresh: (folders: readonly string[]) => Promise<unknown>;
  say: (message: string) => void;
  /** Resolves `true` once the move has reached the server (`useCreateAndMove`). */
  move: (path: string, destinationFolder: string) => Promise<boolean>;
}

export interface FolderJobsValues {
  iconOf: (path: string) => string | null;
  moveFolder: (path: string, direction: "up" | "down") => void;
  placeFolder: (path: string, parent: string, folders: readonly string[]) => void;
}

export function useFolderJobs(deps: FolderJobsDeps): FolderJobsValues {
  const { options, listings, iconOf: emojiOf, drawLocally, refresh, say, move } = deps;
  const workspaceId = options.workspaceId as Id<"workspaces"> | null;
  const setOrder = useAction(api.functions.folderOrder.set);

  const jobs = useMemo(() => {
    /*
      The phone's pages (built from notes, not listings), Restore, the folder
      page and a note's chips find the Inbox, the Projects folder and the
      Archive through `jobFoldersNow`: told here, as the listings
      change and before anything drawn from them, so nothing reads the old
      name a frame late. Idempotent, which is what lets it sit in a memo.
    */
    setJobFoldersNow({
      inbox: inboxFolder(listings),
      projects: projectsFolder(listings),
      archive: archiveFolder(listings),
      website: websiteFolder(listings),
    });
    return loadedJobs(listings);
  }, [listings]);
  const twins = useMemo(() => loadedTwins(listings), [listings]);
  const iconOf = useCallback(
    (path: string) => {
      const job = jobs.get(path);
      if (job !== undefined) return jobIconMarker(job);
      // Archive's copy of a built-in folder draws that folder's icon in grey, with Archive's box on it.
      const twin = twins.get(path);
      const shown = (twin === undefined ? null : twinIconMarker(twin)) ?? emojiOf(path);
      if (shown !== null) return shown;
      return texPartIconUnder(jobs, path);
    },
    [emojiOf, jobs, twins],
  );

  /** Draw `parent`'s folders in this order now, and send it; a refusal says why and puts the server's back. */
  const order = useCallback(
    (parent: string, folders: readonly string[]) => {
      if (workspaceId === null) return;
      drawLocally((current) => {
        const listing = current[parent];
        return listing === undefined ? current : { ...current, [parent]: withFolderOrder(parent, listing, folders) };
      });
      void setOrder({ workspaceId, parent, folders: [...folders] }).catch((error: unknown) => {
        say(toFileError(error).message);
        // The order drawn above was never written: show the one that was.
        void refresh([parent]).catch(() => undefined);
      });
    },
    [drawLocally, refresh, say, setOrder, workspaceId],
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
      order(parentPath(path), folders);
    },
    [listings, options.canEdit, order, workspaceId],
  );

  const placeFolder = useCallback(
    (path: string, parent: string, folders: readonly string[]) => {
      if (!options.canEdit || workspaceId === null) return;
      if (parentPath(path) === parent) return order(parent, folders);
      // The move says its own refusal (the server's, for a built-in folder it keeps in place).
      void move(path, parent).then((moved) => {
        if (moved) order(parent, folders);
      });
    },
    [move, options.canEdit, order, workspaceId],
  );

  return { iconOf, moveFolder, placeFolder };
}
