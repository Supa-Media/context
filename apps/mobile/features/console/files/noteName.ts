import { baseName, withoutSortPrefix } from "./paths";

/**
 * THE NOTE'S NAME, TYPED WHERE THE NOTE IS.
 *
 * "We should be able to rename a note from the note header itself. Very
 * frustrating to have to go through multiple steps" (owner, 2026-10-14). The
 * title-is-the-name rule (`linkedTitle.ts`) covers a note whose first heading
 * is its name, and nothing else: a note with no `# heading` — an empty
 * `untitled-<date>`, a capture, a note written as prose from its first line —
 * had its name only in the tab and the tree, and renaming it meant the row's
 * menu and a dialog. So the note's header line (`Breadcrumb`) ends in its name,
 * and a note with no title draws its name above the body the way Obsidian's
 * inline title does (`noteEditor/InlineName.tsx`). Both are text fields; both
 * rename through the same `rename` the dialog uses.
 *
 * This file is the arithmetic between what the field shows and what the file
 * is called. What a person types is the *name*: no `.md`, no `.excalidraw.md`
 * (a person names a diagram, not a file format) and no sort number, which is
 * filing rather than a name — every row and crumb already hides it, and a
 * rename keeps it, the way `proposeTitle` keeps it for a retitled heading.
 */

export interface NoteName {
  /** What the field shows and the person edits. */
  text: string;
  /** The sort number the file keeps, `01-` or `""`. */
  prefix: string;
  /** `.md`, `.excalidraw.md`, or `""` for a file that is not a note. */
  extension: string;
}

/** `1-projects/01-intro.md` → `{ text: "intro", prefix: "01-", extension: ".md" }`. */
export function noteNameOf(path: string): NoteName {
  const name = baseName(path);
  const stem = name.replace(/(\.excalidraw)?\.md$/i, "");
  const extension = name.slice(stem.length);
  const text = withoutSortPrefix(stem);
  // An all-prefix stem (`01-.md`) has nothing left to show; keep it whole.
  if (text === "") return { text: stem, prefix: "", extension };
  return { text, prefix: stem.slice(0, stem.length - text.length), extension };
}

/**
 * The whole file name a typed name renames `path` to, or `null` when there is
 * nothing to do: the field was emptied (a blank name is a slip, not a request
 * — the note keeps its name) or the name did not change.
 *
 * Validation is not here. `rename` asks `describeNameProblem` and the
 * listing's collision check, and says why in the notice the dialog's refusals
 * use — one set of rules for every way into a rename.
 */
export function renamedFileName(path: string, typed: string): string | null {
  const text = typed.trim();
  if (text === "") return null;
  const current = noteNameOf(path);
  if (text === current.text) return null;
  // Typing the extension back is typing the name: `plan.md` is `plan`.
  const bare = current.extension !== "" && text.toLowerCase().endsWith(current.extension.toLowerCase())
    ? text.slice(0, text.length - current.extension.length).trim()
    : text;
  if (bare === "" || bare === current.text) return null;
  // A name that brings its own sort number is choosing one; keep theirs.
  const prefix = withoutSortPrefix(bare) !== bare ? "" : current.prefix;
  return `${prefix}${bare}${current.extension}`;
}

/**
 * The name to draw for `path` while a rename of it may be on its way.
 *
 * The rename asked for here moves the listing at once and the open note's
 * path only when the bucket says yes, so for that moment the field would read
 * the old name back at the person who just typed the new one. `renamed` is the
 * same signal the tab strip follows, and a refused rename says it again the
 * other way round, which puts the old name back.
 */
export function shownNoteName(path: string, renamed: { from: string; to: string } | null | undefined): string {
  return noteNameOf(renamed?.from === path ? renamed.to : path).text;
}
