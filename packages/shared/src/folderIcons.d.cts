/** Types for `folderIcons.cjs`; see that file for where icons live and why. */

export type FolderIcons = Record<string, string>;

interface IconStore {
  get(key: string): Promise<{ etag: string; text(): Promise<string> } | null>;
  put(
    key: string,
    value: string,
    options?: { onlyIf?: { etagMatches?: string; absent?: true } },
  ): Promise<{ etag: string } | null>;
  capabilities?: { conditionalCreate?: boolean };
}

export declare const FOLDER_ICONS_KEY: string;
export declare const FOLDER_ICONS_VERSION: number;
export declare function parseFolderIcons(text: string | null | undefined): FolderIcons;
export declare function serializeFolderIcons(icons: FolderIcons): string;
export declare function iconsAfterMove(icons: FolderIcons, from: string, to: string): FolderIcons | null;
export declare function iconsAfterDelete(icons: FolderIcons, path: string): FolderIcons | null;
export declare function readFolderIcons(store: IconStore): Promise<{ icons: FolderIcons; etag: string | null }>;
export declare function updateFolderIcons(
  store: IconStore,
  change: (icons: FolderIcons) => FolderIcons | null,
): Promise<FolderIcons | null>;
export declare function remapFolderIcons(store: IconStore, from: string, to: string): Promise<FolderIcons | null>;
export declare function dropFolderIcons(store: IconStore, path: string): Promise<FolderIcons | null>;
