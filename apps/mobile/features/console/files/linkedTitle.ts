import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { baseName, describeNameProblem, displayName, withoutSortPrefix } from "./paths";
import type { Listings } from "./fileBrowser/types";
import { namesIn } from "./tree";
import { isUntitled, titleFor } from "./untitled";

/**
 * THE TITLE IS THE NAME — while the two are the same.
 *
 * The owner asked for renaming a note from the page itself ("there is not a
 * smooth way of renaming a file within the page"), and the design that answered
 * it (`/rename-flow-artboards`, approved 2026-09-26) is one rule: **if a note's
 * first heading and its file name are the same, they stay the same.** Edit the
 * title, leave it, and the file follows. No dialog.
 *
 * ## Why only while they already match
 *
 * A bucket connected from years of Obsidian is full of deliberate differences —
 * `2026-09-12.md` whose heading is "Friday", a `README.md` titled after its
 * project. Renaming those because somebody fixed a typo in a heading would
 * refile a person's notes without asking. So a note is *linked* when its title
 * is its name (sort number aside — `01-intro.md` titled "intro" is linked, and
 * keeps its `01-`), or when it is an `untitled-<date>` note waiting for one.
 * Nothing is stored: whether two things match is read from the file, which is
 * the only place a plain-files product may keep it.
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
 * Whether this note's title and its name are one thing.
 *
 * Decided against the text as it was **opened**, not as it is being typed —
 * while somebody types a new title the two differ, and that is the edit this
 * rule exists to carry, not evidence that they were never linked.
 */
export function isLinkedTitle(path: string, openedText: string): boolean {
  if (isUntitled(path)) return true;
  const title = titleFor(openedText);
  if (title === null) return false;
  const { stem } = stemOf(path);
  return title === stem || title === withoutSortPrefix(stem);
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
 * `null` when nothing should change.
 *
 * The other direction of the same rule, for a rename that did not start in the
 * title — the tree, the dialog, an undo. If the heading was the old name, it
 * becomes the new one, so the pair stays linked; a heading that was anything
 * else is the person's and is left alone. An `untitled-<date>` placeholder is
 * the old name too, which is what makes naming a new note from its row also
 * name its page.
 */
export function retitled(from: string, to: string, text: string): string | null {
  const title = titleFor(text);
  if (title === null) return null;
  const old = stemOf(from).stem;
  const next = stemOf(to).stem;
  let replacement: string;
  if (title === old) replacement = next;
  else if (title === withoutSortPrefix(old) && old !== withoutSortPrefix(old)) replacement = withoutSortPrefix(next);
  else return null;
  if (replacement === title) return null;
  const lines = text.split("\n");
  // The line `titleFor` read: frontmatter skipped, then blank lines.
  let index = 0;
  if (lines[0]?.trim() === "---") {
    index = 1;
    while (index < lines.length && lines[index]?.trim() !== "---") index += 1;
    index += 1;
  }
  while (index < lines.length && lines[index]!.trim() === "") index += 1;
  const line = lines[index]!;
  const marker = /^(\s*#\s+)/.exec(line)![1]!;
  // A CRLF note keeps its line ending: `split("\n")` leaves the `\r` on it.
  lines[index] = `${marker}${replacement}${line.endsWith("\r") ? "\r" : ""}`;
  return lines.join("\n");
}

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
