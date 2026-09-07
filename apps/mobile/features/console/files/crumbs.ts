/**
 * The path of the place somebody is standing in, as a list of crumbs.
 *
 * One function, two renderers: the phone's band (`Breadcrumb.pathOnly`, drawn
 * inside `NavBand` behind the lit context pill) and the pointer layout's region
 * header (`Breadcrumb`, which adds the context segment and the visibility
 * chip). They used to each slice the path themselves, and that is how they came
 * to disagree about what a segment is — one of them dropped the leaf, then the
 * context, and shipped a line that named neither the note you had open nor the
 * context you were in.
 *
 * ## The leaf is part of the path
 *
 * `1-projects/october-trip.md` is `1-projects / october-trip`, not
 * `1-projects`. The argument for stopping at the ancestors was that the note
 * names itself inside the document — an inline title, or a folder page's
 * heading — so the trailing segment says the same words twice.
 *
 * That rule is real and it was applied to the wrong element. Both of those
 * names are **inside the scroller**: they are gone as soon as somebody reads
 * past the first screen, and the band is what stays. And it made `index.md` —
 * every context's front page, and the first note anybody opens — render as no
 * path at all, which is the screenshot this module exists because of.
 *
 * So the leaf is drawn, and it is drawn as a **position** rather than as a
 * control: pressing it would re-select what is already open.
 *
 * ## Only the count is capped, never a segment's text
 *
 * `ContextStrip`'s rule — nothing truncates, the row gets longer, the scroll
 * absorbs it — is right about *names*: `3-resour…` and `3-resour…` are two
 * folders that look identical on the control whose whole job is telling them
 * apart. It is wrong as an answer for **depth**, because the segment scrolling
 * off the end is the leaf, and the leaf is what the line is for. Somebody who
 * has to drag a row they have no reason to think is draggable in order to learn
 * which note is open has the same non-answer as before, one gesture further
 * away.
 *
 * So the middle folders are elided to `…` past `MAX_FOLDER_CRUMBS`, the first
 * and the last two are kept, and no label is ever shortened. Nothing becomes
 * unreachable: the first folder is drawn and pressing it lists what is under
 * it, which is how anybody got to the hidden ones in the first place.
 */

/** One element of the path line. */
export type Crumb =
  /** An ancestor folder. Pressable: it opens that folder's listing. */
  | { kind: "folder"; label: string; path: string }
  /**
   * Where you actually are — the open note, or the folder being listed.
   *
   * Not pressable. `path` travels with it anyway, because a renderer that has
   * to ask "which of these is the leaf" by position is a renderer that will get
   * it wrong the day the list is filtered.
   */
  | { kind: "leaf"; label: string; path: string }
  /**
   * The folders that did not fit, standing in for themselves.
   *
   * It carries their names so the row can say what it is hiding rather than
   * rendering a bare ellipsis at a screen reader.
   */
  | { kind: "gap"; hidden: readonly string[] };

/**
 * How many folder segments a narrow row draws before eliding.
 *
 * Three, on a 390pt screen, beside a context pill and in front of the leaf.
 * Exported so the test asserts the number rather than restating it.
 */
export const MAX_FOLDER_CRUMBS = 3;

export function crumbsFor(
  path: string,
  options: {
    /**
     * What the note calls itself, where its filename is not what it is called.
     *
     * A captured note's filename is a content hash, so the segment naming what
     * is on screen named nothing. Applies to the leaf and only to the leaf.
     */
    title?: string;
    /**
     * The cap, or `null` for a caller with the width for the whole path.
     *
     * `null` rather than `Infinity` because "no cap" is a decision the pointer
     * layout takes deliberately, and a number nobody can reach reads as an
     * oversight.
     */
    maxFolders?: number | null;
  } = {},
): readonly Crumb[] {
  const { title, maxFolders = MAX_FOLDER_CRUMBS } = options;

  /*
    Empty segments dropped rather than rendered. A doubled slash is not a
    folder with no name, and the root — `""` — is the context itself, which the
    pill in front of this line already is.
  */
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return [];

  const leafName = segments[segments.length - 1]!;
  const leaf: Crumb = {
    kind: "leaf",
    label: title ?? stripMarkdown(leafName),
    path,
  };

  const folders: Extract<Crumb, { kind: "folder" }>[] = segments.slice(0, -1).map((segment, index) => ({
    kind: "folder",
    label: segment,
    // Its own listing, not its parent's. Built from `segments` rather than by
    // slicing `path`, so a doubled slash cannot leak into a path we then ask
    // somebody's bucket for.
    path: segments.slice(0, index + 1).join("/"),
  }));

  if (maxFolders === null || folders.length <= maxFolders) return [...folders, leaf];

  /*
    First, gap, last two.

    The first is the PARA bucket — `1-projects`, `3-resources` — which is where
    somebody goes to start again, and the last two are the immediate parent and
    its parent, which is where they go to step back. What is dropped is the
    middle, which is the part a path is least often read for.
  */
  const kept = folders.slice(-(maxFolders - 1));
  const hidden = folders.slice(1, folders.length - kept.length).map((crumb) => crumb.label);
  return [folders[0]!, { kind: "gap", hidden }, ...kept, leaf];
}

/**
 * `.md` is filing, not a name — the same trim `noteHeading` makes when it falls
 * back to the filename, so the two cannot disagree about what a note is called.
 *
 * Only the extension, and only at the end: `notes.md` as a *folder* name keeps
 * its own spelling, because that is the folder's name.
 */
function stripMarkdown(name: string): string {
  return name.replace(/\.md$/i, "");
}
