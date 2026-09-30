import type { MenuContext } from "./menu";
import type { MenuItem } from "./menuItem";
import { makeItem } from "./menuMake";
import { baseName, folderLabel, parentPath } from "./paths";
import type { TreeRow } from "./tree";
import type { Visibility } from "./types";

/**
 * Private / Team, plus "Follow folder" for a file.
 *
 * A folder gets two items because the third has no referent: `privacy.md` is
 * folder defaults plus exact-note exceptions, and a folder's default *is* the
 * value being set — there is no outer default for it to follow. "Follow
 * folder" on a file removes that file's exact-note exception rather than
 * writing a value, which is why it belongs in this list at all: without it the
 * only way back from an exception would be to guess the folder's default and
 * set it by hand, leaving a redundant exception behind that then stops
 * tracking the folder.
 */
/**
 * "Currently team — from 1-projects."
 *
 * The one line in this menu that explains a row, and the row earns it: the
 * other two visibility items name the value they write, and this one names a
 * value that lives somewhere else. Knowing a note follows its folder without
 * knowing what the folder *says* is not knowing who can read it, which in a
 * product where `team` means named people is the only question that matters.
 *
 * The root folder is the context, and is called that rather than being given
 * `baseName("")`'s empty string. The folder is named the way its row and its
 * crumb name it — `withoutSortPrefix` — because a sentence that says "from
 * 1-projects" about a folder drawn `projects` is asking the reader to work out
 * that those are the same folder.
 */
function followDetail(path: string, inherited: Visibility): string {
  const folder = parentPath(path);
  return `Currently ${inherited} — from ${folder === "" ? "this context" : folderLabel(baseName(folder))}.`;
}

export function visibilityGroup(
  context: MenuContext,
  isFolder: boolean,
  count: number,
  /**
   * The one row this is about, or `null` for a selection or a crumb.
   *
   * Only a single note has a visibility "in force" to mark. A selection of
   * three can be in three different states, and marking any one of them would
   * be the menu claiming a fact about the other two.
   */
  single: TreeRow | null,
): MenuItem[] {
  /*
    These read as verbs because they are controls, and they used to read
    "Private" and "Team", which are the words the tree's marker and the
    breadcrumb's chip already use for the *current state*. The same two words
    in the same colours doing two different jobs is a menu you cannot act on
    without experimenting: nothing on screen said whether pressing "Team" set
    the visibility or filtered by it, and the experiment costs a privacy change
    on somebody else's context.

    A folder's pair is worded for reach rather than for the folder — "Share this
    folder with the team" is a sentence about a folder, and what actually
    happens is that its notes become readable by other people. The detail line
    carries the half people get wrong, which is what *keeps* its own setting.
  */
  // "here" is one folder. Several folders are "in 3 folders", which is the
  // same rule the archive and delete labels follow — a label that names how
  // much it touches, so a selection can never be mistaken for a row.
  const where = count === 1 ? "here" : `in ${count} folders`;
  /*
    Which of the three a *note* is in right now, read off `marker` and nothing
    else. `markerFor` sets it exactly when the note carries an exception and
    leaves it undefined when the note follows its folder, so "no marker" is
    "follows" — the same fact the tree draws by not marking the row.

    A group rule (`@design`) is none of the three, and checks nothing. Rounding
    it to "private" because it is not `team` would be the console claiming a
    note two colleagues can read is yours alone.
  */
  const current =
    single === null || isFolder
      ? null
      : single.marker === undefined
        ? "follow"
        : single.marker === "private" || single.marker === "team"
          ? single.marker
          : "group";

  const children = isFolder
    ? [
        makeItem(context, "visibilityPrivate", `Make everything ${where} private`, {
          detail: "Except notes with a setting of their own.",
        }),
        makeItem(context, "visibilityTeam", `Share everything ${where} with the team`, {
          detail: "Except notes with a setting of their own.",
        }),
      ]
    : [
        makeItem(context, "visibilityPrivate", "Make private", {
          ...(current === null ? {} : { checked: current === "private" }),
        }),
        makeItem(context, "visibilityTeam", "Share with the team", {
          ...(current === null ? {} : { checked: current === "team" }),
        }),
        // Not "Follow folder": that names the state this leaves behind, and the
        // act is removing this note's own exception.
        makeItem(context, "visibilityFollow", "Use the folder's setting", {
          ...(current === null ? {} : { checked: current === "follow" }),
          ...(current === "follow" && single !== null && context.inherited !== undefined
            ? { detail: followDetail(single.path, context.inherited) }
            : {}),
        }),
      ];
  return [makeItem(context, "visibility", "Visibility", { items: children })];
}
