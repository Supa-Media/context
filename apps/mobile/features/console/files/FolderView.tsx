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
 */

import { StyleSheet, View, useWindowDimensions } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { densityFor } from "../../app/frame";
import { baseName, displayName } from "./paths";
import type { FileEntry, FolderListing } from "./types";

export function FolderView({
  entry,
  listing,
  canSetVisibility,
  contextLabel,
  onSelect,
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
  onSelect: (path: string) => void;
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
  const rows = listing?.entries ?? [];

  return (
    <View style={[styles.folder, compact && styles.folderCompact]}>
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
        {isTeam
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
          rows.map((row) => <FolderRow key={row.path} row={row} onSelect={onSelect} />)
        )}
        {listing?.truncated ? (
          <Text variant="treeMeta" style={styles.aside}>
            This folder has more in it than is shown here.
          </Text>
        ) : null}
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
function FolderRow({ row, onSelect }: { row: FileEntry; onSelect: (path: string) => void }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const label = displayName(row.name);
  return (
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
        The tree marks **only exceptions**, and so does this — as the same pip,
        not as a word. A trailing "team" on every row of a context whose root is
        private is the folder's default drawn once per file, which buries the
        one note that differs from it. See `FileEntry.exception`.
      */}
      {row.exception ? (
        <View
          style={[styles.pip, row.visibility === "team" ? styles.pipTeam : styles.pipPrivate]}
          accessibilityLabel={row.visibility === "team" ? "shared" : "private"}
          testID="folder-row-exception"
        />
      ) : null}
    </PressRow>
  );
}

/** See `FileTree`: the 8pt a 36pt row is short of the touch floor, halved. */
const ROW_SLOP = layout.explorerRowSlop;

const makeStyles = (colors: Colors) => StyleSheet.create({
  folder: { gap: space.x2 },
  folderCompact: { paddingHorizontal: layout.readingMargin },
  head: { flexDirection: "row", alignItems: "flex-start", gap: space.x2 },
  title: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  rule: { color: colors.muted },
  action: { alignSelf: "flex-start", marginTop: space.x1 },
  contents: { marginTop: space.x3 },

  /**
   * The tree's row, at the tree's pitch.
   *
   * `height` rather than `minHeight`, for the reason `FileTree.nodeTouch`
   * gives: the pitch is the measurement, and a row free to grow is a listing
   * whose rhythm depends on how long a name is.
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

  aside: { paddingVertical: space.x2 },
});
