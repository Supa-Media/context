/**
 * What the file editor works with.
 *
 * These mirror the return validators of `apps/convex/functions/files.ts`
 * exactly. They are declared rather than imported from the generated Convex
 * types for one reason: the landing page's read-only demo builds the same
 * shapes from local data with no backend at all, so the components have to
 * take a plain interface, not a Convex query result.
 */

export type Visibility = "private" | "team";

export interface FileEntry {
  kind: "file" | "folder";
  /** Bucket-relative. `1-projects/foo.md`, never namespaced. */
  path: string;
  name: string;
  /** What a `team` caller would be allowed to see. */
  visibility: Visibility;
  /** The folder default this path inherits, ignoring any exact-note exception. */
  inherited: Visibility;
  /**
   * `visibility !== inherited`. The tree marks **only these**.
   *
   * This is the whole UI rule, and it is a property of the data rather than a
   * styling choice: `privacy.md` is folder defaults plus exact-note
   * exceptions, so a marker on every file would be drawing the defaults twice
   * and burying the exceptions. The folder's default goes on the folder row.
   */
  exception: boolean;
  /** `privacy.md`: readable, explained, never typed into. */
  readOnly: boolean;
  size?: number;
  updatedAt?: number;
}

export interface FolderListing {
  path: string;
  /** The folder's own default. Shown on the folder row. */
  folderDefault: Visibility;
  entries: FileEntry[];
  truncated: boolean;
  /** False when `privacy.md` is missing or unparseable — nothing can be shared. */
  manifestUsable: boolean;
}

export interface OpenNote {
  path: string;
  text: string;
  etag: string;
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  readOnly: boolean;
}

/** How a save's conflict check was performed. See `WriteResult` in fileOps.ts. */
export type ConflictCheck = "conditional" | "read-compare";

export interface SaveResult {
  path: string;
  etag: string;
  conflictCheck: ConflictCheck;
}

/**
 * A failure the editor can talk about.
 *
 * `code` is the `ConvexError` code from `functions/files.ts`; `currentEtag` is
 * present on a `CONFLICT` so the console can offer to reload the version that
 * actually exists.
 */
export interface FileError {
  code: string;
  message: string;
  currentEtag?: string;
}
