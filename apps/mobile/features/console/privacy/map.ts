/**
 * The manifest as one folder at a time, for the Privacy section.
 *
 * ## This is a window, not a second engine
 *
 * `privacy.md` is folder defaults plus exact-note exceptions, and the thing
 * that reads it is proven and load-bearing: the gateway's own privacy engine
 * and the port of it in `apps/convex/functions/lib/privacy.ts`, held to each
 * other by a differential test. **Nothing here parses, evaluates or infers
 * anything.** Every value below arrived on a `FolderListing` that the server
 * computed at the caller's own scope — `folderDefault` from `visibilityOf`,
 * and each entry's `visibility` / `inherited` / `exception` from
 * `effectiveVisibility`. This module reshapes those into rows and decides
 * whether a row carries a control.
 *
 * That distinction is the whole safety argument, so it is worth stating what
 * it rules out: a folder the caller may not see is **absent from the listing**
 * rather than marked, so it is absent here; there is no place in this file
 * where a visibility could be computed, defaulted, or guessed for a path the
 * server did not answer for.
 *
 * ## Why the reshaping is not free
 *
 * Two things have to be true of a viewer over a filtered listing, and neither
 * is true by accident:
 *
 *  - **"not loaded" is not "empty".** A folder nobody has asked about must
 *    read as pending, or a settings panel tells somebody their notes are
 *    unshared when it simply has not looked.
 *  - **A count is never taken over what was withheld.** There is no total in
 *    this module. The console's note census is owner-only precisely so a
 *    member cannot derive how much is being kept from them by subtraction, and
 *    a "12 folders" printed over a filtered listing is that subtraction handed
 *    over for free.
 */

import type { FolderListing, Visibility } from "../files/types";

/** One folder, and the default every note in it follows unless named. */
export interface PrivacyFolderRow {
  /** Bucket-relative, `""` for the context root. */
  path: string;
  name: string;
  visibility: Visibility;
}

/** One note the manifest names by hand, and what it would otherwise be. */
export interface PrivacyNoteRow {
  path: string;
  name: string;
  visibility: Visibility;
  inherited: Visibility;
}

/**
 * What the section can draw for one folder.
 *
 * `loading` and `broken` are states rather than empty readies, because both
 * would otherwise render as "nothing is shared here" — the first before
 * anybody has looked, the second over a manifest that cannot be read at all.
 */
export type PrivacyFolderView =
  | { state: "loading" }
  /** `privacy.md` is missing or will not parse: every note reads private. */
  | { state: "broken" }
  | {
      state: "ready";
      path: string;
      /** The folder's own default, as the server resolved it. */
      folderDefault: Visibility;
      folders: PrivacyFolderRow[];
      /** Notes whose visibility differs from what they would inherit. */
      exceptions: PrivacyNoteRow[];
      /** The store stopped listing before the end — see `FolderListing`. */
      truncated: boolean;
    };

/**
 * Reshape one loaded listing.
 *
 * `manifestUsable` is read from **this** listing rather than from the root's,
 * because it is a fact about the bucket that every listing carries: a folder
 * page fetched while the manifest is broken says so too, and a panel that
 * consulted only the root would draw ordinary-looking rows underneath a
 * banner. The console's other reader of this field (`BrowsePane`) takes the
 * root's copy because it draws one banner per context; this draws per folder.
 */
export function privacyViewOf(
  listings: Readonly<Record<string, FolderListing | undefined>>,
  path: string,
): PrivacyFolderView {
  const listing = listings[path];
  if (listing === undefined) return { state: "loading" };
  if (!listing.manifestUsable) return { state: "broken" };
  return {
    state: "ready",
    path: listing.path,
    folderDefault: listing.folderDefault,
    folders: listing.entries
      .filter((entry) => entry.kind === "folder")
      .map((entry) => ({
        path: entry.path,
        name: entry.name,
        visibility: entry.visibility,
      })),
    exceptions: listing.entries
      .filter((entry) => entry.kind === "file" && entry.exception && !entry.readOnly)
      .map((entry) => ({
        path: entry.path,
        name: entry.name,
        visibility: entry.visibility,
        inherited: entry.inherited,
      })),
    truncated: listing.truncated,
  };
}

/** The press a folder row offers, and how many presses it takes. */
export interface FolderControl {
  /** The other of the two words. There is no third. */
  to: Visibility;
  /**
   * Whether it takes two presses.
   *
   * True for the widening direction only. Publishing a folder makes every note
   * in it that is not held back by name readable by everybody on People, and
   * nothing the console can reach says how many that is — so the press states
   * the consequence and waits for a second one. Closing a folder back is the
   * cheap direction and stays a single press, the same asymmetry `nextScope`
   * applies to a note's lock.
   */
  arm: boolean;
}

/**
 * Whether this row is a control or a fact, and which way it moves.
 *
 * Two things say no, and neither implies the other:
 *
 *  - **`canSetVisibility`.** Owner-and-can-edit, derived in
 *    `features/console/capabilities.ts` and enforced again by the server with
 *    `minimum: "owner"` on `setDirectoryVisibility`. It is also the difference
 *    between a control and a lie on a read-only console: `run` in
 *    `useFileBrowser` returns without doing anything when `canEdit` is false,
 *    so a drawn button there would look like it worked and change nothing.
 *  - **The root.** `default_visibility` is fixed `private` where the manifest
 *    is rendered (`renderPrivacyRulesBlock`) — a shared workspace's scaffold
 *    opens the folders it created and never the default — so a control on the
 *    root row would be a press with no rule behind it.
 */
export function folderControl(
  canSetVisibility: boolean,
  row: PrivacyFolderRow,
): FolderControl | null {
  if (!canSetVisibility) return null;
  if (row.path === "") return null;
  return row.visibility === "team"
    ? { to: "private", arm: false }
    : { to: "team", arm: true };
}
