/** Types for `folderRoles.cjs`; see that file for the rules and the reasons. */

export type MainRole = "inbox" | "projects" | "areas" | "resources" | "archive";
export type ExtraRole = "clients" | "teams" | "products";
export type FolderRole = MainRole | ExtraRole;
/** A job a folder row can carry in `role`. */
export type RowRole = FolderRole | "website" | "meetings" | "tex";

/** Which folder does each job (`folderJobs`). */
export interface FolderJobs {
  jobs: Record<RowRole, string | null>;
  roots: string[];
}

export declare const ROW_ROLES: readonly RowRole[];
export declare const WEBSITE_FOLDER: "website";
export declare const TEX_FOLDER: "tex";
export declare const NO_JOB: "none";
export declare const JOB_LABEL: Readonly<Record<RowRole, string>>;
export declare function isRowRole(value: unknown): value is RowRole;
export declare function jobOfName(name: string): RowRole | null;
export declare function folderJobs(
  rows: Iterable<{ path: string; name: string; role?: string | null; top: boolean }>,
): FolderJobs;
export declare function jobAt(jobs: FolderJobs | null | undefined, path: string): RowRole | null;
export declare function jobPath(jobs: FolderJobs | null | undefined, path: string): string;

export declare const MAIN_ROLES: readonly MainRole[];
export declare const EXTRA_ROLES: readonly ExtraRole[];
export declare const DEFAULT_FOLDER: Readonly<Record<FolderRole, string>>;
export declare const MAIN_FOLDERS: readonly string[];
export declare const ROLE_LABEL: Readonly<Record<FolderRole, string>>;
export declare const ROLE_DESCRIPTION: Readonly<Record<FolderRole, string>>;

export declare function folderRole(name: string): FolderRole | null;
export declare function plainFolderName(name: string | undefined | null): string | null;
export declare function topLevelRole(path: string): FolderRole | null;
export declare function isMainFolder(path: string): boolean;
export declare function isExtraRole(role: FolderRole | null): role is ExtraRole;
export declare function folderRank(name: string): number;
export declare function compareTopLevelFolders(a: string, b: string): number;
export declare function compareListingEntries(
  parent: string,
  a: { kind: string; name: string; role?: string | null; order?: number | null },
  b: { kind: string; name: string; role?: string | null; order?: number | null },
): number;
export declare function rolesIn(names: Iterable<string>): Record<FolderRole, string | null>;
export declare function missingMainRoles(names: Iterable<string>): MainRole[];
export declare function isProtectedFolder(path: string, names: Iterable<string>): boolean;
export declare function foldName(name: string): string;
export declare function siblingTwin(
  name: string,
  siblings: Iterable<string>,
  options?: { topLevelFolder?: boolean },
): string | null;
export declare function twinMessage(name: string, twin: string, instead: string, topLevel: boolean): string;

export type IndexingPriority = 1 | 2 | 3;
export interface IndexingPriorityCount {
  priority: IndexingPriority;
  indexed: number;
  pending: number;
}
export declare const INDEXING_PRIORITIES: readonly IndexingPriority[];
export declare function indexingPriority(path: string): IndexingPriority;
export declare function compareIndexingOrder(a: string, b: string): number;
export declare function countByIndexingPriority(
  paths: Iterable<string>,
  isIndexed: (path: string) => boolean,
  extraPending?: Iterable<string>,
): IndexingPriorityCount[];
