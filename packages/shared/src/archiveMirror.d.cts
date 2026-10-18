/** Types for `archiveMirror.cjs`; see that file for the rules and the reasons. */

import type { FolderJobs, RowRole } from "./folderRoles.cjs";

export declare const ARCHIVE_STAMP: RegExp;
export declare function isArchiveStamp(segment: unknown): boolean;
export declare function archiveDestination(archive: string, path: string): string;
export declare function restoreTarget(archive: string | null | undefined, archivedPath: string): string | null;
export declare function numberedName(name: string, n: number): string;
export declare function firstFreePath(
  path: string,
  taken: (candidate: string) => boolean | Promise<boolean>,
  limit?: number,
): Promise<string | null>;
export declare function twinsAlong(
  jobs: FolderJobs | null | undefined,
  archive: string | null | undefined,
  archivedPath: string,
): { path: string; role: RowRole }[];
export declare function mergeInto(
  from: string,
  to: string,
  ops: {
    kindAt(path: string): Promise<"file" | "folder" | null>;
    children(folder: string): Promise<string[]>;
    move(from: string, to: string): Promise<unknown>;
  },
  depth?: number,
): Promise<{ from: string; to: string }[]>;
