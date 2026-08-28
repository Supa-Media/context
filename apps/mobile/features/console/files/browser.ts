/**
 * The interface the file editor's UI talks to.
 *
 * One interface, two implementations: `useFileBrowser` (real, backed by the
 * Convex actions in `apps/convex/functions/files.ts`) and
 * `useDemoFileBrowser` (the read-only console on the landing page, backed by
 * a handful of literals). The components take this and nothing else, which is
 * what lets the marketing page run the actual console rather than a
 * screenshot.
 *
 * **A read-only browser still carries every mutating method, and they are
 * inert.** This comment used to say the opposite — that `canEdit: false` meant
 * the methods were absent — and it was never true: they are required members of
 * this interface, `useDemoFileBrowser` sets all of them to no-ops, and
 * `useFileBrowser`'s `run` returns without doing anything when `canEdit` is
 * false. So `files.destroy(path)` on a console that cannot edit does not throw;
 * it silently does nothing at all.
 *
 * Which means **the UI cannot use a crash to catch a control it should not have
 * offered**. A Delete that reached the landing page would look like it worked
 * and quietly do nothing, and nobody would find out. Whether a control exists
 * is decided from `canEdit` — see `itemsFor` in `menu.ts` — and that decision is
 * the only thing standing between a visitor and a button that lies.
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
  /**
   * Copy a path into a destination folder, without touching the clipboard.
   *
   * For the ⌥-drop on the tree, where the thing being copied is the thing the
   * person is dragging rather than the thing they last pressed ⌘C on. Spelling
   * that as `copy(from)` then `paste(folder)` looks equivalent and is not:
   * `copy` sets state, `paste` reads the clipboard captured in its own render,
   * and the two run in the same tick — so the paste acts on the *previous*
   * clipboard. Empty, it refuses; holding a cut of some other file, it moves
   * that file into the drop folder.
   *
   * Same collision rules and the same server action as a copy-and-paste — a
   * drop and a paste must never disagree about the name something lands under
   * — with the source passed in. `paste` keeps reading the clipboard, because
   * on the toolbar and menu path the clipboard genuinely is the source.
   */
  copyTo: (from: string, destinationFolder: string) => void;

  createNote: (folder: string, name: string) => void;
  createFolder: (folder: string, name: string) => void;
  rename: (path: string, name: string) => void;
  move: (path: string, destinationFolder: string) => void;
  duplicate: (path: string) => void;
  archive: (path: string) => void;
  /** Permanent. The UI must have confirmed it in words before calling this. */
  destroy: (path: string) => void;
  setVisibility: (path: string, kind: "file" | "folder", visibility: Visibility) => void;
  /**
   * Write a working `privacy.md` over one that is missing or unreadable.
   *
   * Present on every browser and inert on most of them, like every other
   * mutating method here — and the UI decides whether to offer it from
   * `canResetPrivacy` rather than from whether calling it would throw.
   */
  resetPrivacy: () => void;
  /**
   * Whether that control should exist at all.
   *
   * Three things have to be true and none of them is `canEdit`: the manifest
   * has to be broken (a reset is refused on one that parses), the caller has to
   * be the owner (rewriting the access map is not an editor's to do), and this
   * has to be a console that can act. An editor sees the banner explaining why
   * nothing can be shared and no button, which is honest — the fix is theirs to
   * ask for, not theirs to make.
   */
  canResetPrivacy: boolean;
  /**
   * Whether the tree's visibility markers are pressable. Owner-only:
   * visibility writes rewrite the access map that decides what a
   * non-owner may see, so for everyone else the marker is a fact, not
   * a control — same rule the server enforces with `minimum: "owner"`.
   */
  canSetVisibility: boolean;
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
