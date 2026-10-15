import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { baseName, describeNameProblem, displayName, withoutSortPrefix } from "./paths";
import type { Listings } from "./fileBrowser/types";
import { namesIn } from "./tree";
import { titleFor } from "./untitled";
import { nameIsAddress } from "./addressNames";

export { nameIsAddress };

/**
 * THE TITLE IS THE NAME.
 *
 * A note's first heading and its file name are one thing: edit the title,
 * leave it, and the file follows; rename the file anywhere — the tree, the
 * dialog, the header — and the heading follows. No dialog.
 *
 * ## Always, not only while they already match
 *
 * The first version of this rule (`/rename-flow-artboards`, approved
 * 2026-09-26) linked the two only while they were already equal, so a bucket
 * imported from Obsidian — `2026-09-12.md` headed "Friday" — kept them
 * apart. That left two ways to rename a note depending on something nobody
 * could see: "rather than having a weird thing where some things you can edit
 * the file name through the title and some things you have to edit it a
 * different way … they should just be linked together" (owner, 2026-10-14).
 *
 * What still holds from the first version: nothing moves because somebody
 * **opened** a note. And a file whose name is an address — a website page,
 * a folder's `about.md`, the front page — is never renamed by its heading
 * (`nameIsAddress`). A mismatched pair is linked from the first edit of
 * either side, made by a person, under their own caret or in a rename.
 *
 * ## Why this refuses rather than repairs
 *
 * Same argument `nameFromTitle` makes: a heading with a slash does not become a
 * folder, and a taken name does not become "Roadmap 2". The person is told, in
 * a line under the title, and the file keeps the name it has.
 */

/** The file's stem: its name without `.md` (or `.excalidraw.md`). */
function stemOf(path: string): { stem: string; extension: string } {
  const name = baseName(path);
  const stem = name.replace(/(\.excalidraw)?\.md$/i, "");
  return { stem, extension: name.slice(stem.length) };
}

/**
 * Whether editing this note's title renames its file: every note since
 * 2026-10-14 (see the header), except one whose name is an address.
 */
export function isLinkedTitle(path: string, _openedText: string): boolean {
  return !nameIsAddress(path);
}


export type TitleProposal =
  /** The title is the name already, or there is no title to follow. */
  | { kind: "same" }
  /** Leaving the title should rename the file to `name`. */
  | { kind: "rename"; name: string; label: string }
  /** The title cannot be a name here, and this is why. The file keeps its name. */
  | { kind: "problem"; message: string }
  /** It could be, but a live share holds this path. See `sharesBreakingWarning`. */
  | { kind: "held"; message: string };

/**
 * What the title a person has typed would do to a linked note's file name.
 *
 * The checks the Rename dialog makes (`describeNameProblem`, and a taken name,
 * here compared without case), asked here so the answer can be drawn under the
 * title while they type rather than discovered after they have left it.
 */
export function proposeTitle(input: {
  path: string;
  draft: string;
  listings: Listings;
  /** `sharesBreakingWarning(shares, path, "Renaming")` for this note. */
  sharesWarning: string | null;
}): TitleProposal {
  const { path, draft, listings, sharesWarning } = input;
  const title = titleFor(draft);
  if (title === null) return { kind: "same" };
  const { stem, extension } = stemOf(path);
  const prefix = stem.slice(0, stem.length - withoutSortPrefix(stem).length);
  if (title === stem || (prefix !== "" && title === withoutSortPrefix(stem))) return { kind: "same" };
  if (title.includes("/")) {
    return { kind: "problem", message: "A title with a slash cannot name a file, so the file keeps its name." };
  }
  const name = `${prefix}${title}${extension}`;
  const invalid = describeNameProblem(name);
  if (invalid !== null) return { kind: "problem", message: `${invalid} The file keeps its name.` };
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const taken = takenBy(listings, folder, name, baseName(path));
  if (taken !== null) {
    const where = folder === "" ? "The root" : displayName(baseName(folder));
    return {
      kind: "problem",
      message: `${where} already has ${displayName(taken)}. Pick another title, or the file keeps the name it has.`,
    };
  }
  if (sharesWarning !== null) {
    return {
      kind: "held",
      message: `${sharesWarning.split(". ")[0]}, so the file keeps its name. Use Rename to change it anyway.`,
    };
  }
  // Contained, like every other name the tree and the tab draw: a title is
  // typed text, and a bidi override in it must not reach the chrome raw.
  return { kind: "rename", name, label: isolateForDisplay(title) };
}

/**
 * The sibling that already has `name`, compared without case — `Roadmap.md`
 * beside `roadmap.md` is the same file on a Mac or Windows checkout of the
 * bucket, and two rows nobody can tell apart in the tree. The note's own name
 * does not count, so changing only the case of a title renames it.
 */
function takenBy(listings: Listings, folder: string, name: string, own: string): string | null {
  const wanted = name.toLowerCase();
  for (const sibling of namesIn(listings, folder)) {
    if (sibling !== own && sibling.toLowerCase() === wanted) return sibling;
  }
  return null;
}

/**
 * Rows (or tabs) with the open note's name as it is being typed.
 *
 * Only the label moves: the row keeps its path, so it keeps its place in the
 * list and every command still addresses the file the bucket has. It slides to
 * its sorted place when the rename lands, not on every keystroke.
 */
export function relabelled<T extends { path: string; label: string }>(
  rows: readonly T[],
  edit: { path: string; label: string | null } | null | undefined,
): readonly T[] {
  if (edit === null || edit === undefined || edit.label === null) return rows;
  const label = edit.label;
  return rows.map((row) => (row.path === edit.path ? { ...row, label } : row));
}

/**
 * The note's text with its title following a rename from `from` to `to`, or
 * `null` when nothing should change. Shared with the control plane, whose
 * rename rewrites the heading as part of the move (`linkedHeading.ts`).
 */
export { retitled } from "@context/shared/src/linkedHeading";

/**
 * Whether an edit made on this device changed the note's title.
 *
 * The native editor reports focus and nothing finer, so it cannot say the
 * caret is in the title the way the web editor does. What it can say is what
 * its own typing did: this is asked of each local change, and only a change
 * that moved the title counts as "in the title". Focus alone must not — a
 * collaborator's new title arriving while this person types in the body would
 * otherwise read as theirs, and this device would rename the file for it.
 */
export function editChangesTitle(before: string, after: string): boolean {
  return titleFor(before) !== titleFor(after);
}
