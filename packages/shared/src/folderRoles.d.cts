/** Types for `folderRoles.cjs`; see that file for the rules and the reasons. */

export type MainRole = "inbox" | "projects" | "areas" | "resources" | "archive";
export type ExtraRole = "clients" | "teams" | "products";
export type FolderRole = MainRole | ExtraRole;

export declare const MAIN_ROLES: readonly MainRole[];
export declare const EXTRA_ROLES: readonly ExtraRole[];
export declare const DEFAULT_FOLDER: Readonly<Record<FolderRole, string>>;
export declare const MAIN_FOLDERS: readonly string[];
export declare const ROLE_LABEL: Readonly<Record<FolderRole, string>>;
export declare const ROLE_DESCRIPTION: Readonly<Record<FolderRole, string>>;

export declare function folderRole(name: string): FolderRole | null;
export declare function topLevelRole(path: string): FolderRole | null;
export declare function isMainFolder(path: string): boolean;
export declare function isExtraRole(role: FolderRole | null): role is ExtraRole;
export declare function folderRank(name: string): number;
export declare function compareTopLevelFolders(a: string, b: string): number;
export declare function compareListingEntries(
  parent: string,
  a: { kind: string; name: string },
  b: { kind: string; name: string },
): number;
export declare function rolesIn(names: Iterable<string>): Record<FolderRole, string | null>;
export declare function missingMainRoles(names: Iterable<string>): MainRole[];
