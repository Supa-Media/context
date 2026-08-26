/**
 * The interface the file editor's UI talks to.
 *
 * One interface, two implementations: `useFileBrowser` (real, backed by the
 * Convex actions in `apps/convex/functions/files.ts`) and
 * `useDemoFileBrowser` (the read-only console on the landing page, backed by
 * a handful of literals). The components take this and nothing else, which is
 * what lets the marketing page run the actual console rather than a
 * screenshot — and, more importantly, what makes it impossible for the demo to
 * offer a button that would lie: `canEdit` is false there, and every mutating
 * method is absent.
 */

import type { Clipboard } from "./clipboard";
import type { EditorState } from "./editor";
import type { FolderListing, Visibility } from "./types";

export interface FileBrowser {
  /**
   * Whether this console may change anything.
   *
   * False on the landing page, and false for a workspace `member` — read
   * access and write access are different grants, and a Save button that
   * always fails is worse than no Save button.
   */
  canEdit: boolean;
  /** Why not. Shown once, plainly, rather than on every disabled control. */
  readOnlyReason?: string;

  loading: boolean;
  /** True while an operation is in flight, so the toolbar can settle. */
  busy: boolean;
  /** Listings by folder path; `""` is the root. `undefined` means "not loaded". */
  listings: Readonly<Record<string, FolderListing | undefined>>;
  expanded: ReadonlySet<string>;
  toggleFolder: (path: string) => void;

  selectedPath: string | null;
  /** Refused, with a prompt, when the open note has unsaved changes. */
  select: (path: string) => void;

  editor: EditorState;
  setDraft: (text: string) => void;
  save: () => void;
  /** Take the version that is on the server, discarding this draft. */
  useTheirs: () => void;
  /** Keep this draft and save it over theirs, on the etag that is now current. */
  keepMine: () => void;
  discard: () => void;

  /** The last thing that went wrong, or a confirmation of what just happened. */
  notice: string | null;
  dismissNotice: () => void;

  clipboard: Clipboard | null;
  copy: (path: string) => void;
  cut: (path: string) => void;
  paste: (destinationFolder: string) => void;

  createNote: (folder: string, name: string) => void;
  createFolder: (folder: string, name: string) => void;
  rename: (path: string, name: string) => void;
  move: (path: string, destinationFolder: string) => void;
  duplicate: (path: string) => void;
  archive: (path: string) => void;
  /** Permanent. The UI must have confirmed it in words before calling this. */
  destroy: (path: string) => void;
  setVisibility: (path: string, kind: "file" | "folder", visibility: Visibility) => void;
}

/** Every folder currently loaded, for the move dialog's destination list. */
export function loadedFolders(
  listings: Readonly<Record<string, FolderListing | undefined>>,
): string[] {
  const folders = new Set<string>([""]);
  for (const listing of Object.values(listings)) {
    for (const entry of listing?.entries ?? []) {
      if (entry.kind === "folder") folders.add(entry.path);
    }
  }
  return [...folders].sort();
}
