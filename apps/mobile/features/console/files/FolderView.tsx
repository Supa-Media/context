/**
 * A folder, as somewhere you are rather than a settings panel about it.
 *
 * What was here before: the folder's path, one sentence about visibility, a
 * "Make this folder private" button, and then a screenful of nothing. On a
 * phone that is most of the screen empty, and it was the *only* thing a folder
 * did — the notes inside it were reachable only through the tree drawer, which
 * is the one surface a phone makes hardest to get at.
 *
 * So the contents are the screen now, and everything that was here is a header
 * above them. That also makes a folder navigable without the drawer: tap a
 * folder, see what is in it, tap a note.
 *
 * ## It is the tree, in the other place
 *
 * A folder listing and the file tree are the same thing shown twice, so they
 * are drawn the same way: the 36pt pitch, the chevron gutter, the stripped
 * extension, the exception mark. They had drifted into two idioms — the tree
 * drew plain rows and this drew full-width grey cards with borders and 10pt of
 * padding, printed `README.md` where the tree printed `README`, and marked a
 * folder with a trailing `/` where the tree marks it with a chevron. Eight
 * files rendered as eight form fields, which reads as a settings screen rather
 * than as a place with notes in it.
 *
 * ## Its two controls are the frame's, not its own
 *
 * A "Share…" pill in the heading and a full-width "Make this folder private"
 * beneath it used to be the first two things on the screen, and they were the
 * same two capabilities a *note* offers through a different pair of controls in
 * a different place. They are one pair now — a lock and a share, in the group
 * the frame draws — so a folder and a note are acted on identically. See
 * `shareTarget` and `visibilityTarget` in `app/(app)/console/_layout.tsx`, and
 * the note head in `BrowsePane` for the pointer layout.
 *
 * The visibility *sentence* stays. It is the one thing here that says something
 * a lock cannot: what `team` means for the notes inside this folder.
 *
 * `displayName` is shared with the tree rather than reimplemented, so "what a
 * row is called" cannot come to have two answers. The **order** is the
 * server's — folders first, then files, each case-insensitively alphabetical —
 * for the reason `buildTreeRows` gives: re-sorting here would only introduce a
 * second opinion.
 *
 * ## What it deliberately does not do
 *
 * **It does not list what the caller cannot see.** The rows come from the same
 * `listings` the tree draws, which the server already filtered at the caller's
 * scope — a private note is absent for a member rather than present and
 * refused, and this must not invent a count that says otherwise. An empty
 * folder and a folder full of notes somebody may not read look identical here,
 * which is the point.
 *
 * **It does not list the folder's placeholder either.** The `README.md` that
 * makes the prefix exist is plumbing rather than a note, and a folder holding
 * nothing else reads as empty here. The filter is `listedEntries`, shared with
 * the tree so the two cannot come to disagree about what is in a folder.
 *
 * ## The foot, and why only the root page has one
 *
 * `foot` is where `storage · index · counts` lands on a phone — the line that
 * used to be the file tree's footer and lost its home when a phone stopped
 * having a file tree. (It was `explorer-vault-detail` there, a testID that no
 * longer exists anywhere; what survives on a pointer layout is the counts-only
 * remnant of that footer, `explorer-counts`.) `BrowsePane` supplies it for the
 * **context root and nothing else**, and that is a decision rather than an
 * accident of where it was easy to put:
 *
 *  - Those three facts are about the *context*, not about a folder. The root is
 *    the one folder page that **is** the context — this file already takes a
 *    `contextLabel` for exactly that reason — so under its heading they read as
 *    a caption on the thing they describe.
 *  - The counts are `loadedCounts` over every listing that has been read, not
 *    over this folder. Printed under `3-resources`' own eight rows they would
 *    be read as a count *of* `3-resources`, and would be wrong — a line that is
 *    accurate and misread is worse than one that is absent.
 *  - A caption repeated under forty folder pages is chrome, and the same
 *    argument the breadcrumb's `pathOnly` makes about not saying a thing twice
 *    applies to saying it forty times.
 *
 * It is a string rather than a node, and it is composed by `contextFoot.ts`
 * rather than here, because this file has no business knowing what a storage
 * binding or a backfill is — the same split `Explorer` made for the same line.
 */

import { StyleSheet, View, useWindowDimensions } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { densityFor, noteColumnWidth } from "../../app/frame";
import { baseName, displayName } from "./paths";
import { useRightClick } from "./rightClick";
import { listedEntries } from "./tree";
import { isGroupVisibility } from "./types";
import type { FileEntry, FolderListing } from "./types";

/**
 * The folder listing's right-click wiring.
 *
 * Supplied by the pane rather than built here, for the reason every other
 * decision in this file is: this component draws a folder and knows nothing
 * about a `FileBrowser`, a clipboard or who is allowed to do what. Both
 * handlers report whether they actually opened a menu — see `rightClick.web.ts`
 * for why the answer is what decides whether the browser's own menu is
 * suppressed.
 *
 * Absent on a read-only console and on native, and the listing then has no
 * pointer gesture at all rather than one that does nothing.
 */
export interface FolderMenu {
  onRow: (entry: FileEntry, anchor: { x: number; y: number }) => boolean;
  onBackground: (anchor: { x: number; y: number }) => boolean;
}

export function FolderView({
  entry,
  listing,
  canSetVisibility,
  contextLabel,
  foot,
  onSelect,
  menu,
}: {
  entry: FileEntry;
  /** The folder's own listing, or `undefined` while it loads. */
  listing: FolderListing | undefined;
  /**
   * Owner-only, like every visibility control — and all this decides now is
   * which sentence the empty state gets, since the control itself moved to the
   * frame. Kept rather than derived from `canShare` at the call site: they are
   * two different server rules and the day they diverge is not the day to find
   * out this file guessed.
   */
  canSetVisibility: boolean;
  /**
   * What the context is called, for the one folder that has no name of its own.
   *
   * The root is `""`, so `baseName` gives nothing and the heading was blank —
   * which nothing reached until the phone's path bar made the root pressable.
   * A context's root folder *is* the context, so it says so.
   */
  contextLabel: string;
  /**
   * `storage · index · counts`, for the one folder page that is the context.
   *
   * Absent everywhere else, and absent on a pointer layout, where the status
   * strip and the top bar's chip already carry the same three facts. See the
   * file header for why the root page and not every folder page.
   */
  foot?: string;
  onSelect: (path: string) => void;
  /** Right-click. Absent where there is nothing to offer — see `FolderMenu`. */
  menu?: FolderMenu;
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    The document's own side margin, on the density where nothing else supplies
    one. `BrowsePane` runs the phone's scroll surface full-bleed so a note can
    keep its own reading margin, which left this listing's title and its first
    row hanging on the edge of the glass. On a pointer layout the pane pads
    itself and this must not pay twice.
  */
  const compact = densityFor(useWindowDimensions().width) === "compact";
  const isTeam = entry.visibility === "team";
  // A group rule is neither of the two sentences below, and the `private` one
  // would be the overstatement `privacy/words.ts` forbids — "yours alone" about
  // a folder two colleagues can read.
  const groupRule = isGroupVisibility(entry.visibility) ? entry.visibility : null;
  /*
    `listedEntries` rather than the listing itself, so this page and the tree
    agree about what is in a folder — including the folder placeholder, which
    neither of them draws. See `tree.ts`. No `keep` here: the open thing on
    this screen is the folder, so there is no note to hold visible.
  */
  const rows = listedEntries(listing?.entries ?? []);

  /*
    The background gesture is on the **whole view**, not on a filler strip under
    the last row.

    Right-clicking the heading, the visibility line, or the space beside a short
    name is a right-click on this folder in every file manager there is, and a
    listing that answered only below its last row would be a target you have to
    find. Rows stop propagation on a gesture they answer (`rightClick.web.ts`),
    so a row's own menu still wins where there is one — this catches exactly
    what is left, which is the folder itself.
  */
  const background = useRightClick(menu === undefined ? undefined : menu.onBackground);

  return (
    <View
      style={[styles.folder, compact && styles.folderCompact]}
      ref={background.ref}
      collapsable={false}
    >
      {/*
        The page, in the note's own column.

        A folder listing is a page in the same frame as a note, and it was laid
        out by a different rule: rows pinned to the left edge of a 900pt pane
        with the rest of it empty, beside a note that is a centred measure. The
        width is `noteColumnWidth` rather than a number of this file's own, so
        the folder's first character lands exactly where the note's first line
        starts — which is also where the breadcrumb above both pages is indented
        to, since `noteGutterFor` is this same centring with the editor's padding
        named separately.

        It is the *contents* that are centred and not the view: the right-click
        background is the outer view above, and a folder you can only aim at
        within the measure would be a target that shrinks as the window grows.

        Inert on a phone, where 342pt of screen is far short of the measure and
        `folderCompact`'s margin goes on governing — the same floor the editor's
        `max(0, …)` has.
      */}
      <View style={styles.column} testID="folder-column">
        {/*
          The folder names itself the way a note does — an inline title at the top
          of its own content — rather than under a `FOLDER` eyebrow. The route
          already said which folder you asked for, so the eyebrow was labelling
          the obvious in the space where the first row should be.
        */}
        <View style={styles.head}>
          <Text variant="noteTitle" role="heading" aria-level={2} style={styles.title}>
            {baseName(entry.path) || contextLabel}
          </Text>
        </View>

        {/*
          The visibility, as a quiet line rather than a paragraph under a heading.

          It was body copy plus a footnote spelling out what `team` means, under
          every folder — and the footnote is an explanation of the model, which
          belongs where somebody has gone looking for it rather than under each of
          forty listings. What is left says what is true of this folder.
        */}
        <Text variant="treeMeta" style={styles.rule}>
          {groupRule
            ? `${groupRule} — visible to that group, and to nobody else in this context`
            : isTeam
              ? "team — visible to the people you granted access, unless a note is held back"
              : "private — yours alone, unless a note is shared as an exception"}
        </Text>

        <View style={styles.contents}>
          {listing === undefined ? (
            <Text variant="meta" style={styles.aside}>
              Loading…
            </Text>
          ) : rows.length === 0 ? (
            /*
              "Nothing you can see", not "nothing here". A member reading a
              folder whose notes are all private would otherwise be told the
              folder is empty, which is a different and untrue statement — and
              the one the visibility rules exist to avoid making.
            */
            <Text variant="meta" style={styles.aside}>
              {canSetVisibility
                ? "This folder has nothing in it yet."
                : "Nothing in this folder is shared with you."}
            </Text>
          ) : (
            rows.map((row) => (
              <FolderRow key={row.path} row={row} onSelect={onSelect} menu={menu} />
            ))
          )}
          {listing?.truncated ? (
            <Text variant="treeMeta" style={styles.aside}>
              This folder has more in it than is shown here.
            </Text>
          ) : null}
        </View>

        {/*
          The context's own caption, under its listing.

          Below the rows rather than above them, for the reason the tree put it at
          its foot: it is a caption on what you have just read, and a phone's
          first screen belongs to the notes rather than to a line about them. It
          scrolls with the page — this whole view is inside `BrowsePane`'s
          scroller on a phone — so it costs nothing permanent.
        */}
        {foot === undefined ? null : (
          <Text variant="treeMeta" style={styles.foot} testID="context-foot">
            {foot}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * One row, drawn as the tree draws one.
 *
 * The chevron gutter is reserved for a file as well as for a folder, so every
 * name in the listing starts on one vertical line — the same reason
 * `FileTree`'s empty box exists. `hitSlop` buys back the 8pt the 36pt row is
 * short of the touch floor: pad the pressable, never the visual.
 */
function FolderRow({
  row,
  onSelect,
  menu,
}: {
  row: FileEntry;
  onSelect: (path: string) => void;
  menu?: FolderMenu;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const label = displayName(row.name);
  /*
    A wrapper rather than a ref on the `PressRow`, which is the escape hatch
    the rail's own right-click used before the rail folded away, and for the
    same reason: react-native-web forwards no `onContextMenu`, and reaching the
    real node through a plain `View` is the contained way to get at one. The
    wrapper sets no style, so it adds no box — the row inside keeps its own
    36pt pitch.
  */
  const rightClick = useRightClick(
    menu === undefined ? undefined : (anchor) => menu.onRow(row, anchor),
  );
  return (
    <View ref={rightClick.ref} collapsable={false}>
    <PressRow
      onPress={() => onSelect(row.path)}
      style={styles.row}
      hoverStyle={styles.rowHover}
      radius={radii.md}
      hitSlop={{ top: ROW_SLOP, bottom: ROW_SLOP }}
      accessibilityLabel={row.kind === "folder" ? `${label}, folder` : label}
      testID="folder-row"
    >
      <View style={styles.chevron}>
        {row.kind === "folder" ? (
          <Icon name="chevronRight" size={15} color={colors.muted} />
        ) : null}
      </View>
      <Text variant="treeTouch" style={styles.rowName} numberOfLines={1}>
        {label}
      </Text>
      {/*
        The tree marks **only exceptions**, and so does this. A trailing "team"
        on every row of a context whose root is private is the folder's default
        drawn once per file, which buries the one note that differs from it. See
        `FileEntry.exception`.

        **It is a pip here and a word in the tree, and this comment used to say
        the two were the same mark.** They were, briefly: `FileTree` drew a 7pt
        pip under `touch`, because a 372pt panel lying over a note had no width
        for `team` beside every row. There is no such panel — the tree is a
        pointer-layout column now (`features/app/frame.ts`) — so `FileTree` has
        one presentation and it is the word, in a column with room for it, and
        its own comment says so. This is the surface that still has no width: a
        folder listing on a phone is the note's own measure, and a word at the
        end of every row would be competing with the file name. One rule, two
        marks, and the two are never on screen together.
      */}
      {row.exception ? (
        <View
          style={[
            styles.pip,
            row.visibility === "team"
              ? styles.pipTeam
              : isGroupVisibility(row.visibility)
                ? styles.pipGroup
                : styles.pipPrivate,
          ]}
          // The label is a claim, and "private" is a false one about a note a
          // group can read. It names the group instead.
          accessibilityLabel={
            row.visibility === "team"
              ? "shared"
              : isGroupVisibility(row.visibility)
                ? `shared with ${row.visibility}`
                : "private"
          }
          testID="folder-row-exception"
        />
      ) : null}
    </PressRow>
    </View>
  );
}

/** See `FileTree`: the 8pt a 36pt row is short of the touch floor, halved. */
const ROW_SLOP = layout.explorerRowSlop;

const makeStyles = (colors: Colors) => StyleSheet.create({
  /**
   * `flexGrow` so the listing *is* the pane, not just the rows in it.
   *
   * The right-click target is this whole view (see the render), and without
   * this the view is exactly as tall as its content — so on a folder with three
   * notes in it the large empty area underneath belonged to the pane rather
   * than to the folder, and a right-click there went on reaching the browser.
   * That area is most of the screen on most folders, and it is the obvious
   * place to aim for "new note here".
   *
   * Inert where it should be: on a phone this sits inside `BrowsePane`'s
   * scroller, whose content container does not stretch its children, so the
   * page goes on being as long as what is in it.
   */
  folder: { flexGrow: 1 },
  folderCompact: { paddingHorizontal: layout.readingMargin },
  /**
   * The document column: the note's measure, centred in what is left.
   *
   * The gap lives here rather than on `folder` because this is the stack of
   * the page's own parts; `folder` is the region behind it, and its only job
   * now is to be the thing a right-click lands on. See the render.
   */
  column: { gap: space.x2, width: "100%", maxWidth: noteColumnWidth, alignSelf: "center" },
  head: { flexDirection: "row", alignItems: "flex-start", gap: space.x2 },
  title: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  rule: { color: colors.muted },
  action: { alignSelf: "flex-start", marginTop: space.x1 },
  contents: { marginTop: space.x3 },

  /**
   * The row, at `layout.explorerRow`'s pitch.
   *
   * `height` rather than `minHeight`: the pitch **is** the measurement, and a
   * row free to grow is a listing whose rhythm depends on how long a name is.
   * The touch floor is paid by the pressable's `hitSlop` rather than by the
   * visual — see that token, and `PressRow`.
   *
   * It used to attribute that reason to `FileTree.nodeTouch`. **There is no
   * such symbol**, and there is no longer an argument there to defer to either:
   * `FileTree`'s whole `touch` fork went when a phone lost its left panel, and
   * this file is the surface that inherited its measurements. So the reason is
   * stated here, where the last reader of it lives.
   */
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: layout.explorerRow,
    paddingRight: space.x3,
    borderRadius: radii.md,
  },
  rowHover: { backgroundColor: colors.surface3 },
  /** The chevron gutter, so a file's name lines up with a folder's. */
  chevron: { width: 18, alignItems: "center", justifyContent: "center" },
  rowName: { flexGrow: 1, flexShrink: 1, minWidth: 0, color: colors.text },

  /**
   * The exception mark: a 7pt disc, not a word.
   *
   * `team` printed on every row was the loudest thing in the listing and said
   * the least — on a bucket laid out the standard way it is the same word eight
   * times over. A pip reads as "this one differs" at a glance, and carries its
   * meaning in the accessible name for anybody who needs it spelled out.
   */
  pip: { width: 7, height: 7, borderRadius: 4 },
  pipTeam: { backgroundColor: colors.accent },
  pipPrivate: { backgroundColor: colors.muted },
  /* The violet this palette already defines as "somebody else's access". */
  pipGroup: { backgroundColor: colors.sharedText },

  aside: { paddingVertical: space.x2 },
  /** The caption at the foot of the context's own page. See the file header. */
  foot: { marginTop: space.x4, color: colors.muted },
});
