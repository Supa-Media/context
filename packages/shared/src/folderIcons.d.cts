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
  /** The control plane's rows, where the store was opened with them: then the file is never read. */
  folderIconsHeld?: FolderIconsHeld;
}

/** The control plane's icon rows, as a store carries them. */
export interface FolderIconsHeld {
  remap(moves: ReadonlyArray<{ from: string; to: string }>): Promise<unknown>;
  drop(path: string): Promise<unknown>;
}

export declare const FOLDER_ICONS_KEY: string;
export declare const FOLDER_ICONS_VERSION: number;
export declare const DEFAULT_FOLDER_ICONS: Readonly<Record<string, string>>;
export declare const DEFAULT_INBOX_FOLDER_ICONS: Readonly<Record<string, string>>;
/** The default icon of `tex/`: drawn as Tex, calm, never as text. */
export declare const TEX_FIGURE_ICON: "context:tex";
export declare function defaultFolderIcon(path: string): string | null;
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
export declare function remapIcons(
  store: IconStore,
  moves: ReadonlyArray<{ from: string; to: string }>,
): Promise<FolderIcons | null>;
export declare function dropFolderIcons(store: IconStore, path: string): Promise<FolderIcons | null>;
