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
 *  - **`moveFolder` moves a row one place among its siblings** (a folder, or
 *    a note in custom order). The new order of that level is worked out from
 *    the listing as it is drawn (`levelOrder.ts`), drawn at once, and sent to
 *    `folderOrder.set`; the live listing then confirms it. A level that was
 *    not in custom order is put in it, with everything where it was drawn
 *    (owner, 2026-11-04). A refusal puts the server's order back and says why.
 *  - **`placeFolder` puts a dragged row at a place** (`treeDrop.ts`): in its
 *    own level the same reorder with the order the drop gave; from another
 *    level, `move` first and the order once the move has landed, so the order
 *    never names a row the server has not got there yet.
 *  - **`setFolderSort` sets a folder's Sort setting** (`functions/folderSort.ts`),
 *    or the workspace's for the top level, drawn at once; and the workspace's
 *    own setting is read here into `listingOrder.ts` for every surface.
 */
import { useCallback, useEffect, useMemo } from "react";
import { useAction, useQuery } from "convex/react";
import { isListingSort, type ListingSort } from "@context/shared/src/listingSort.cjs";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { toFileError } from "../browser";
import { setWorkspaceSort, workspaceSortNow } from "../listingOrder";
import { drawnLevel, movedLevel, withFolderSort, withRowOrder } from "../levelOrder";
import { baseName, folderLabel, parentPath } from "../paths";
import { sortWords } from "../sortChoices";
import { archiveFolder, inboxFolder, loadedJobs, loadedTwins, texPartIconUnder, projectsFolder, websiteFolder } from "../jobIcons/folderJobs";
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
  setFolderSort: (folder: string, sort: ListingSort | null | undefined, inside?: boolean) => void;
}

export function useFolderJobs(deps: FolderJobsDeps): FolderJobsValues {
  const { options, listings, iconOf: emojiOf, drawLocally, refresh, say, move } = deps;
  const workspaceId = options.workspaceId as Id<"workspaces"> | null;
  const setOrder = useAction(api.functions.folderOrder.set);
  const setSort = useAction(api.functions.folderSort.set);
  /*
    The workspace's own setting: the top level's, and every folder's with none
    above it. A listing never carries it (it is not on a row), so it is read
    here and told to every surface through `listingOrder.ts`.
  */
  const heldSort = useQuery(api.functions.folderSort.workspaceSort, workspaceId === null ? "skip" : { workspaceId });
  useEffect(() => {
    if (heldSort === undefined) return;
    setWorkspaceSort(isListingSort(heldSort) ? heldSort : null);
  }, [heldSort]);

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
      if (job !== undefined) return jobIconMarker(job, path.includes("/"));
      // Archive's copy of a built-in folder draws that folder's icon in grey, with Archive's box on it.
      const twin = twins.get(path);
      const shown = (twin === undefined ? null : twinIconMarker(twin)) ?? emojiOf(path);
      if (shown !== null) return shown;
      return texPartIconUnder(jobs, path);
    },
    [emojiOf, jobs, twins],
  );

  /** The name a sentence calls a folder by. */
  const named = (folder: string) => (folder === "" ? "The top level" : folderLabel(baseName(folder)));

  /**
   * Draw `parent`'s rows in this order now, and send it; a level not in custom order is put in it, and said.
   * A refusal says why and puts the server's back.
   */
  const order = useCallback(
    (parent: string, paths: readonly string[]) => {
      if (workspaceId === null) return;
      const before = drawnLevel(listings, parent, workspaceSortNow());
      const switching = before !== null && before.sort !== "custom";
      drawLocally((current) => {
        const listing = current[parent];
        if (listing === undefined) return current;
        const drawn = { ...current, [parent]: withRowOrder(parent, listing, paths) };
        return switching && parent !== "" ? withFolderSort(drawn, parent, "custom", false) : drawn;
      });
      const previous = workspaceSortNow();
      if (switching && parent === "") setWorkspaceSort("custom");
      const sent = [
        setOrder({ workspaceId, parent, folders: [...paths] }),
        ...(switching ? [setSort({ workspaceId, folder: parent, sort: "custom" })] : []),
      ];
      void Promise.all(sent)
        .then(() => {
          // The top level's Sort is in the tree's View menu; a folder's, in its own.
          const back = parent === "" ? "Pick another sort from View" : "Pick another sort from its menu";
          if (switching) say(`${named(parent)} is now in custom order. ${back} to go back.`);
        })
        .catch((error: unknown) => {
          say(toFileError(error).message);
          if (switching && parent === "") setWorkspaceSort(previous);
          // The order drawn above was never written: show the one that was.
          void refresh([...new Set([parentPath(parent), parent])]).catch(() => undefined);
        });
    },
    [drawLocally, listings, refresh, say, setOrder, setSort, workspaceId],
  );

  const moveFolder = useCallback(
    (path: string, direction: "up" | "down") => {
      if (!options.canEdit || workspaceId === null) return;
      const level = drawnLevel(listings, parentPath(path), workspaceSortNow());
      if (level === null) return;
      // Up as the list is drawn, whatever it is sorted by.
      const paths = movedLevel(level, path, direction);
      if (paths === null) return;
      order(level.parent, paths);
    },
    [listings, options.canEdit, order, workspaceId],
  );

  const placeFolder = useCallback(
    (path: string, parent: string, paths: readonly string[]) => {
      if (!options.canEdit || workspaceId === null) return;
      if (parentPath(path) === parent) return order(parent, paths);
      // The move says its own refusal (the server's, for a built-in folder it keeps in place).
      void move(path, parent).then((moved) => {
        if (moved) order(parent, paths);
      });
    },
    [move, options.canEdit, order, workspaceId],
  );

  const setFolderSort = useCallback(
    (folder: string, wanted: ListingSort | null | undefined, inside = false) => {
      if (!options.canEdit || workspaceId === null) return;
      const previous = workspaceSortNow();
      // `undefined`: the sort it draws by now, its own or passed down to it, made its own.
      const sort = wanted === undefined ? (drawnLevel(listings, folder, previous)?.sort ?? null) : wanted;
      if (folder === "") setWorkspaceSort(sort);
      drawLocally((current) => withFolderSort(current, folder, sort, inside));
      void setSort({ workspaceId, folder, sort, ...(inside ? { inside: true } : {}) })
        .then(() => {
          if (inside) say(`The folders inside ${folder === "" ? "the top level" : folderLabel(baseName(folder))} now sort by ${sortWords(sort)}.`);
        })
        .catch((error: unknown) => {
          say(toFileError(error).message);
          if (folder === "") setWorkspaceSort(previous);
          void refresh([...new Set([parentPath(folder), folder])]).catch(() => undefined);
        });
    },
    [drawLocally, listings, options.canEdit, refresh, say, setSort, workspaceId],
  );

  return { iconOf, moveFolder, placeFolder, setFolderSort };
}
