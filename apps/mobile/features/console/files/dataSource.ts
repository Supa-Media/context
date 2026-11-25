/**
 * "Data source…" in the tree's New menu (the data sources boards, 13): the way
 * into a workspace's data folder, which a workspace has none of until its
 * first source or metric.
 *
 * Offered in a shared workspace only. Data sources are planned for shared
 * workspaces whose notes live in their workspace object (`home: object`), and
 * the app is not told a workspace's home, so a shared workspace is the
 * nearest thing it knows (`dataSourceOffered`).
 *
 * Choosing it makes the data folder the first time, with its own `metrics/`
 * (`DATA_PARTS`), and opens it; once there is one, it opens that folder
 * wherever it is nested. `startDataSource` is the whole action, kept apart
 * from the menu so the stage that adds the connect dialog replaces this one
 * function and nothing else.
 */

import { DATA_FOLDER } from "@context/shared/src/folderRoles.cjs";
import { DATA_PARTS } from "@context/shared/src/folderJobInfo.cjs";
import { dataFolderFound, type JobListings } from "./jobIcons/folderJobs";

/** The menu's second line while there is no data folder yet, as the board draws it. */
export const DATA_SOURCE_DETAIL = "Makes a data folder the first time";

/**
 * Whether the Data page has shipped. The menu item was hidden until it had,
 * so nobody made a data folder that opened as a bare folder (owner,
 * 2026-11-24: "make sure the UI matches what you are showing me"). It has:
 * the data folder now opens as the Data page (`data/DataFolderPage.tsx`).
 */
export const DATA_PAGE_SHIPPED = true;

/** Whether the New menu offers "Data source…": a shared workspace, by its kind, once the Data page has shipped. */
export function dataSourceOffered(kind: string | null | undefined, shipped: boolean = DATA_PAGE_SHIPPED): boolean {
  return shipped && kind === "shared";
}

/** The item's second line: the board's while no data folder is loaded, none once one is. */
export function dataSourceDetail(listings: JobListings): string | undefined {
  return dataFolderFound(listings) === null ? DATA_SOURCE_DETAIL : undefined;
}

/** What `startDataSource` uses of the file browser. */
export interface DataSourceFiles {
  listings: JobListings;
  createFolder: (folder: string, name: string, options?: { open?: boolean }) => void;
  select: (path: string) => boolean;
}

/**
 * Make the data folder, with `metrics/` in it, and open it; or open the one
 * there is, adding `metrics/` when its listing shows none. The server gives a
 * root folder named `data` the Data job on its row when no folder does it yet
 * (`roleForNewFolder`), so the folder made here is the data folder however it
 * is renamed or moved later.
 */
export function startDataSource(files: DataSourceFiles): void {
  const [metrics] = DATA_PARTS;
  const found = dataFolderFound(files.listings);
  if (found === null) {
    files.createFolder("", DATA_FOLDER, { open: true });
    files.createFolder(DATA_FOLDER, metrics);
    return;
  }
  const listing = files.listings[found];
  if (listing !== undefined && !listing.entries.some((entry) => entry.kind === "folder" && entry.name === metrics)) {
    files.createFolder(found, metrics);
  }
  files.select(found);
}
