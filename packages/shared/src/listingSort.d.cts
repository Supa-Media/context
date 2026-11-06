/** Types for `listingSort.cjs`; see that file for the rules and the reasons. */

export type ListingSort =
  | "custom"
  | "name-asc"
  | "name-desc"
  | "edited-desc"
  | "edited-asc"
  | "created-desc"
  | "created-asc";

export interface SortableEntry {
  kind: string;
  name: string;
  role?: string | null;
  order?: number | null;
  updatedAt?: number | null;
  createdAt?: number | null;
}

export declare const LISTING_SORTS: readonly ListingSort[];
export declare function isListingSort(value: unknown): value is ListingSort;
export declare function compareSorted(parent: string, a: SortableEntry, b: SortableEntry, sort: ListingSort | null | undefined): number;
export declare function sortEntries<T extends SortableEntry>(parent: string, entries: readonly T[], sort: ListingSort | null | undefined): T[];
export declare function effectiveSort(
  folder: string,
  sortAt: (path: string) => string | null | undefined,
  workspaceSort: string | null | undefined,
): ListingSort | null;
export declare function listingSortOf(
  listing: { path?: string; sort?: string | null } | null | undefined,
  workspaceSort: string | null | undefined,
): ListingSort | null;
