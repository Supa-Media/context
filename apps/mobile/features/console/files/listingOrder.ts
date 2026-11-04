import { useSyncExternalStore } from "react";
import { listingSortOf, type ListingSort } from "@context/shared/src/listingSort.cjs";

/**
 * The workspace's own Sort setting, for every surface that draws a file list.
 *
 * Each folder's Sort setting arrives on its listing (`listing.sort`: its own,
 * or the nearest one above it that is passed down; owner, 2026-11-04,
 * `docs/decisions/app-and-console/folder-sort.md`). The one setting a listing
 * never carries is the workspace's, which the top level and every folder with
 * none above it draws by: it lives on the workspace, not on a row, and is read
 * from the control plane (`folderSort.workspaceSort`, `useWorkspaceSortSync`
 * in `fileBrowser/useFolderSort.ts`) into this module.
 *
 * ## Why a bus rather than a prop or a route parameter
 *
 * The tree (`Explorer`) and the folder page (`BrowsePane`) are siblings with
 * `ConsoleShell` between them, and neither is a parent of the other; the sort
 * had to reach both, and the folder page drawing A to Z beside a tree drawn
 * otherwise was the defect this module was first made for (`readMode.ts` met
 * the same problem and its header carries the argument in full). It used to
 * hold a Z to A flip that lived in the browser and reset on reload; since
 * 2026-11-04 it holds the shared setting, saved for everybody.
 */

let workspaceSort: ListingSort | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The workspace's setting as it is now (the control plane's answer, or a change drawn ahead of it). Silent when unchanged. */
export function setWorkspaceSort(next: ListingSort | null): void {
  if (workspaceSort === next) return;
  workspaceSort = next;
  for (const listener of [...listeners]) {
    // A throwing subscriber must not stop the rest being told — `readMode.ts`
    // and `bucketWrites.ts` both refuse that, and for the same reason.
    try {
      listener();
    } catch {
      // See above.
    }
  }
}

/** The workspace's own Sort setting, re-rendering when it changes. */
export function useWorkspaceSort(): ListingSort | null {
  return useSyncExternalStore(subscribe, () => workspaceSort, () => workspaceSort);
}

/** The same answer outside a render, for a command that runs on a press. */
export function workspaceSortNow(): ListingSort | null {
  return workspaceSort;
}

/**
 * The sort one listing draws by: its own or inherited setting, else the
 * workspace's (custom only at the top level). Null for the order a folder with
 * no setting has always drawn in.
 */
export function sortOfListing(
  listing: { path?: string; sort?: string | null } | null | undefined,
  sort: ListingSort | null = workspaceSort,
): ListingSort | null {
  return listingSortOf(listing, sort);
}

/** Back to no setting, for a test that must not leak an order into the next one. */
export function resetListingOrder(): void {
  setWorkspaceSort(null);
}
