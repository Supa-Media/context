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
 * apart. It is not an answer for **depth**, because the segment that scrolls
 * off the trailing edge is the leaf, and the leaf is what the line is for.
 *
 * So past `MAX_FOLDER_CRUMBS` the middle folders are elided to `…`, keeping the
 * root folder and the immediate parent — the classic breadcrumb shape, and the
 * tightest one that still says where you are. No label is ever shortened, and
 * nothing becomes unreachable: the first folder is drawn and pressing it lists
 * what is under it, which is how anybody reached the hidden ones in the first
 * place.
 *
 * **What the cap does not do is guarantee a fit, and it cannot.** Segment names
 * are the customer's, so no count is a width; measured in a browser at 390pt,
 * an ordinary PARA path (one or two folders) puts the leaf comfortably on
 * screen and `3-resources/…/2026/the-lean-startup` is still about 30pt over.
 * What the cap buys is a **bounded** row rather than one that grows with the
 * tree: uncapped, that same path put the leaf 130pt past the edge, and a
 * six-folder path would put it further.
 *
 * The row stays anchored at its leading edge when it does overflow, which is a
 * choice about what may go off screen. The pill in front of these is a
 * **control** — the way up, and the thing this whole band was rebuilt for — and
 * the leaf is a *statement*, which the document under it also makes. A control
 * you cannot reach is worse than a fact you have to scroll to; `NavBand`'s fade
 * is what says there is more.
 *
 * ## …except the leaf, which a fade is the wrong answer for
 *
 * The paragraph above shipped a screenshot: `3-resources / … / 2026 /
 * the-lean-startup`, with the leaf's trailing letters under the fade and the
 * rest of it off the scroller entirely — on the one segment that says *which
 * note this is*, which is the segment a phone has the least room to be vague
 * about. "scroll to see the rest" is a real answer for a folder somebody
 * mostly reads by shape; it is not one for the note's own name.
 *
 * So a caller with a width to spend passes a `budget`, and the leaf becomes
 * the thing that is protected rather than the thing that goes missing.
 * Folders are elided harder first, past the two-and-parent shape above — but
 * from the front, one ancestor at a time, rather than in one jump to a bare
 * `…`: the immediate parent is where "step back" actually goes, which the
 * pill in front of this row does not, so it stays a live folder for as long
 * as the width allows. Only when even that one folder alone leaves no room —
 * and, past it, only when a single `…` standing for the whole path still
 * does not — does the leaf's own label get shortened, and it is shortened in
 * the **middle** (`the-lean…tup`) rather than at an edge, so it keeps both the
 * word somebody typed and the word they'd search for. `CHAR_WIDTH_PX` is what
 * turns a pixel budget into a character one; see it for where the number came
 * from.
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
  | {
      kind: "leaf";
      label: string;
      path: string;
      /**
       * What the note is actually called, when `label` has been shortened to
       * fit a `budget`.
       *
       * Set only when truncation happened, so a renderer can hand a screen
       * reader the whole name while the screen shows the shortened one — those
       * are two different claims and only one of them fits on 390pt.
       */
      fullLabel?: string;
    }
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
 * Two — the root folder and the immediate parent — beside a context pill and in
 * front of the leaf. Three was tried and measured at 390pt: it left the leaf
 * further off the edge than two did on the same path, and the extra segment it
 * bought is the *middle* of the path, which is the part a breadcrumb is least
 * often read for. Exported so the test asserts the number rather than restating
 * it.
 */
export const MAX_FOLDER_CRUMBS = 2;

/**
 * How much of a point one character of the row costs, for the 11px monospace
 * face the folders and the leaf are drawn in.
 *
 * Derived rather than guessed, from the only two measurements this row has
 * ever had taken of it: eliding `3-resources/books/reading-notes/2026/` from
 * three kept folders to two — dropping the 13-character `reading-notes` and
 * the separator in front of it — moved the leaf's trailing edge from 137pt
 * past a 390pt screen to 27pt past it. 110pt for 14 characters (13 plus the
 * `/`) is 7.9pt each; rounded down to 7, which is the safe direction — a
 * budget that is stingier than the real font costs a folder that could have
 * stayed un-elided, never a leaf that spills past the edge it was computed
 * for. `breadcrumb-shots.ts` renders the real font in a real browser and is
 * where this gets checked against reality rather than arithmetic; measuring
 * the row it draws is also where `SEPARATOR_CHARS` below came from.
 */
export const CHAR_WIDTH_PX = 7;

/**
 * What a separator actually costs, in characters — not the one glyph it draws.
 *
 * `NavBand`'s row puts a 6pt flex gap on *both* sides of every separator, so a
 * crumb boundary costs `6 + <the glyph> + 6`, not the one glyph rowChars would
 * charge it counted naively. Measured at 390pt: the gap between two adjacent
 * folder segments was 18.6pt regardless of which folders they were, which is
 * `12 + 6.6` — the two flex gaps plus one more glyph at the row's own
 * `CHAR_WIDTH_PX`. Rounded up to 4 rather than to the nearer 3, again in the
 * direction that spends the budget faster rather than slower: undercounting
 * this is exactly how the leaf ended up under the fade in the first place.
 */
export const SEPARATOR_CHARS = 4;

/** What `crumbsFor` may spend on the whole row: the pill's neighbours only — it does not know about the pill itself. */
export interface RowBudget {
  /** Every folder label, separator, gap and the leaf, added together. */
  chars: number;
}

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
    /**
     * The row's width, spent as characters. `null` — the default — for a
     * caller that does not need the leaf protected, which today is every
     * caller except the phone's `pathOnly` row.
     *
     * Applied **after** `maxFolders`: the cap already elides the middle
     * folders on every phone-width row before this ever has anything to do.
     * This is what happens on the paths the cap alone still leaves too long —
     * folders collapse further, all the way to a single `…`, and only then is
     * the leaf's own label shortened. See the file header for the shape.
     */
    budget?: RowBudget | null;
  } = {},
): readonly Crumb[] {
  const { title, maxFolders = MAX_FOLDER_CRUMBS, budget = null } = options;

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

  /*
    **The cap is floored at two**, and that is a real guard rather than
    defensive padding: the elided shape is *first, gap, last*, so it costs two
    folders by construction. Asked for one, `slice(-0)` is `slice(0)` — the
    whole array — and the answer to "draw fewer" would have been the entire path
    with an ellipsis in the middle of it. A cap of one has no shape, so the
    smallest one that does is what it gets.

    It is floored **before** the comparison below, not after. Floored after, a
    two-folder path under a cap of one would elide into *first, gap, last* over
    the same two folders — a gap standing for nothing, which is worse than
    either answer it is between.
  */
  const cap = maxFolders === null ? null : Math.max(2, maxFolders);
  const folded: readonly Crumb[] =
    cap === null || folders.length <= cap
      ? [...folders, leaf]
      : (() => {
          /*
            First, gap, and the last `cap - 1`.

            The first is the PARA bucket — `1-projects`, `3-resources` — which is
            where somebody goes to start again, and the last is the immediate
            parent, which is where they go to step back. What is dropped is the
            middle, which is the part a path is least often read for.
          */
          const kept = folders.slice(-(cap - 1));
          const hidden = folders.slice(1, folders.length - kept.length).map((crumb) => crumb.label);
          return [folders[0]!, { kind: "gap" as const, hidden }, ...kept, leaf];
        })();

  if (budget === null || rowChars(folded) <= budget.chars) return folded;

  /*
    The cap's shape (root, gap, parent) is a **readable** answer, not a
    guaranteed fit — `crumbs.ts`'s header has the measurements. A budget is a
    caller saying it needs the fit guaranteed, so folders give it up next —
    but from the front, one at a time, rather than in one jump to nothing.
    The **immediate parent is the folder worth keeping pressable longest**: it
    is where "step back" actually goes, where the root a press on the pill
    already reaches is not. So this drops the oldest ancestor into the gap,
    then the next, only reaching a single `…` standing for every folder — and
    pressable nowhere — when even the immediate parent alone does not leave
    the leaf room.
  */
  let collapsed: readonly Crumb[] = folded;
  for (let kept = folders.length - 1; kept >= 0 && rowChars(collapsed) > budget.chars; kept -= 1) {
    const tail = folders.slice(folders.length - kept);
    const hidden = folders.slice(0, folders.length - kept).map((crumb) => crumb.label);
    collapsed = hidden.length === 0 ? [...tail, leaf] : [{ kind: "gap", hidden }, ...tail, leaf];
  }

  if (rowChars(collapsed) <= budget.chars) return collapsed;

  /*
    Folders have nothing left to give: the leaf's own name is why the row does
    not fit. It is shortened in the middle rather than at either end, which is
    the one cut that keeps both the word somebody typed at the start of the
    name and the word they would search for at the end of it.
  */
  const gap = collapsed.length === 2 ? (collapsed[0] as Extract<Crumb, { kind: "gap" }>) : null;
  const spent = gap === null ? 0 : rowChars([gap]);
  const leafBudget = Math.max(1, budget.chars - spent - SEPARATOR_CHARS);
  const shortLeaf: Crumb = { ...leaf, label: truncateMiddle(leaf.label, leafBudget), fullLabel: leaf.label };
  return gap === null ? [shortLeaf] : [gap, shortLeaf];
}

/**
 * The row's cost in characters: `SEPARATOR_CHARS` for the boundary in front of
 * every crumb (there is one before the first too — see `Breadcrumb.pathOnly`)
 * plus each crumb's own text, `…` counted as the one character it renders as.
 *
 * Deliberately blind to the few points a folder's own touch-target padding
 * costs beyond its glyphs — `SEPARATOR_CHARS` already rounds up past that, and
 * a second correction here would double-count it.
 */
function rowChars(crumbs: readonly Crumb[]): number {
  return crumbs.reduce(
    (total, crumb) => total + SEPARATOR_CHARS + (crumb.kind === "gap" ? 1 : crumb.label.length),
    0,
  );
}

/**
 * `label`, or as much of it as `maxChars` allows with a `…` standing for the
 * middle — never the end, so a name like `the-lean-startup` keeps both
 * `the-lean` and `startup` rather than losing everything after one of them.
 *
 * Splits the kept characters unevenly in the head's favour (`Math.ceil` on
 * the head, `Math.floor` on the tail): the head is where a name's own words
 * live and the tail is usually the shorter, more distinctive half — a date, a
 * short suffix — so the odd character out goes where there is more to read.
 */
function truncateMiddle(label: string, maxChars: number): string {
  if (label.length <= maxChars) return label;
  if (maxChars <= 1) return "…";
  const keep = maxChars - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${label.slice(0, head)}…${tail === 0 ? "" : label.slice(-tail)}`;
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
