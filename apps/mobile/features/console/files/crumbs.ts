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
 * ## No segment's text is ever truncated, and neither is the row
 *
 * `ContextStrip`'s rule — nothing truncates, the row gets longer, the scroll
 * absorbs it — used to be true of *names* only: `3-resour…` and `3-resour…`
 * are two folders that look identical on the control whose whole job is
 * telling them apart, and this file never shortened one. It was not true of
 * **depth** — `NavBand`'s row is a `ScrollView`, so the segment that scrolled
 * off the trailing edge could be the leaf, and past a folder count this module
 * used to elide the middle to a `…` to keep the leaf from ever being the thing
 * that went missing.
 *
 * **That elision, and the character budget it grew into, is gone.** `crumbsFor`
 * now returns the whole path, every time, and `NavBand`'s scroller is the only
 * thing that decides what is on screen at a given moment: it answers "what
 * fits" for free, correctly, at every width and every font size, which a
 * pixel-width estimate could only ever approximate. The product owner's own
 * words, once the scroller existed to make the question worth asking again:
 *
 * > I feel like we shouldn't even show `...` ellipses, we should just show the
 * > full path but allow a horizontal scroll.
 *
 * `docs/decisions/app-and-console.md`'s "Two, not three" and "A count cannot
 * guarantee a fit, so a width budget does" record the two decisions this
 * reverses, why they seemed necessary at the time, and why removing the cap
 * makes the path **more** reachable rather than less — every segment is
 * pressable now, not only the root and the immediate parent a cap kept live.
 * Both sections there are marked superseded rather than deleted, because the
 * reasoning that produced them was not wrong about the constraint it was
 * solving — a `ScrollView` is what changed, not the argument.
 *
 * Where the row starts when it overflows is `NavBand`'s decision, not this
 * one: a `ScrollView` defaults to its leading edge, which is the context pill
 * and the ancestors nearest it, so the leaf — already stated one line below,
 * as the note's own inline title — is what may sit off-screen until somebody
 * scrolls.
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
  | { kind: "leaf"; label: string; path: string };

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
  } = {},
): readonly Crumb[] {
  const { title } = options;

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

  return [...folders, leaf];
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
