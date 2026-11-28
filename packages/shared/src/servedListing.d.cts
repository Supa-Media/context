/** Types for `servedListing.cjs`; see that file. */

export declare class TreeUnavailable extends Error {
  constructor(code?: string);
  reason: "unreachable";
  code: string;
}
export declare const TREE_UNREACHABLE: string;
export declare function compareKeys(a: string, b: string): number;
export declare function servedListingStore(store: any, options?: { timeoutMs?: number }): any;
export declare function objectOf(entry: { path: string; etag?: string; size?: number; updatedAt?: number; noteId?: string }): {
  key: string;
  etag?: string;
  size?: number;
  uploaded?: Date;
  noteId?: string;
};
