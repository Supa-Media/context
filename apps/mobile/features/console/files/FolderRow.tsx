/**
 * One row of a folder's Files listing, drawn as the tree draws one — split out
 * of `FolderView` so the page around it can grow its List and Board views
 * (`folderPage/`) without the file crossing its size limit. Nothing about the
 * row changed in the move; the reasons below are the ones it was written with.
 */

import { StyleSheet, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import type { DragModifier } from "./dnd";
import type { FolderDrag, FolderMenu } from "./FolderView";
import { displayName } from "./paths";
import type { SyncMark } from "./pendingMarks";
import { useRowInteractions } from "./rowInteractions";
import { SyncMarkDot, withSyncMark } from "./SyncMarkDot";
import { isGroupVisibility } from "./types";
import type { FileEntry } from "./types";

/**
 * One row, drawn as the tree draws one.
 *
 * The chevron gutter is reserved for a file as well as for a folder, so every
 * name in the listing starts on one vertical line — the same reason
 * `FileTree`'s empty box exists. `hitSlop` buys back the 8pt the 36pt row is
 * short of the touch floor: pad the pressable, never the visual.
 */
export function FolderRow({
  row,
  onSelect,
  menu,
  drag,
  card = false,
  sync = null,
}: {
  row: FileEntry;
  onSelect: (path: string) => void;
  menu?: FolderMenu;
  drag?: FolderDrag;
  /** Drawn inside the phone's grouped card — see the listing. */
  card?: boolean;
  /** This note's edit is not in the bucket yet. `null` for one that is. */
  sync?: SyncMark | null;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const label = displayName(row.name);
  /*
    THE SAME HOOK THE TREE'S ROWS USE, AND FOR THE SAME REASON.

    This used to be `useRightClick`, which is web-only by construction — so on
    the native build, where this pane is the *only* browse surface, a row had
    no menu at all and every verb the tree offers by long press was
    unreachable. `useRowInteractions` is the pair whose native half is
    `onLongPress` and whose web half binds `contextmenu` *and* the HTML5 drag
    events, so one call gets this listing the phone's menu and the pointer's
    pick-up at once, from the file the tree already trusts for both.

    A wrapper `View` rather than a ref on the `PressRow`: react-native-web
    forwards neither `onContextMenu` nor `draggable`, and reaching the real
    node through a plain view is the contained way to get at one. The wrapper
    sets no style, so it adds no box — the row inside keeps its own 36pt pitch.
  */
  const interactions = useRowInteractions({
    path: row.path,
    // Absent rather than a no-op, which is the fact that stops a right-click
    // being swallowed by a row with nothing to put in the browser menu's
    // place. See `rowInteractions.web.ts`.
    onMenu: menu === undefined ? undefined : (anchor) => menu.onRow(row, anchor),
    canDrag: drag !== undefined && drag.canDrag(row),
    canDrop: drag !== undefined && drag.canDrop(row),
    onDragStart: drag?.onDragStart ?? noopPath,
    onDragOver: drag?.onDragOver ?? noopDrop,
    onDragLeave: drag?.onDragLeave ?? noopPath,
    onDrop: drag?.onDrop ?? noopDrop,
    onDragEnd: drag?.onDragEnd ?? noopVoid,
  });
  const isDropTarget = drag !== undefined && drag.target === row.path;
  return (
    <View
      ref={interactions.ref as never}
      collapsable={false}
      style={isDropTarget ? [styles.rowDrop, card && styles.rowDropCard] : undefined}
    >
    <PressRow
      onPress={() => onSelect(row.path)}
      style={[styles.row, card && styles.rowCard]}
      hoverStyle={styles.rowHover}
      radius={card ? 0 : radii.md}
      hitSlop={{ top: ROW_SLOP, bottom: ROW_SLOP }}
      accessibilityLabel={withSyncMark(row.kind === "folder" ? `${label}, folder` : label, sync)}
      testID="folder-row"
      // Unconditional: `useRowInteractions` returns nothing to spread when
      // there is no menu, and one copy of that rule is the point — a second
      // one here is the copy that would drift. Same call as `FileTree`'s.
      {...interactions.pressableProps}
    >
      {/*
        A GLYPH IN THE CARD, A CHEVRON OUTSIDE IT.

        `Phone-Browse.dc.html` puts an 18pt folder mark at the head of every
        row, and the reason is not decoration: inside the card the chevron is
        already **trailing**, where it says "this row goes somewhere". A
        leading chevron there meant a folder row drew a chevron at each end —
        two marks with two meanings and one shape — while a file row drew an
        empty gutter, so a mixed listing said nothing at all about which of its
        rows were folders. The glyph says it, once, in the slot the board puts
        it in.

        Outside the card there is no trailing chevron, so the leading one is
        still the only thing carrying "this is a folder" and it stays.
      */}
      <View style={styles.chevron}>
        {card ? (
          <Icon
            name={row.kind === "folder" ? "folder" : "file"}
            size={16}
            color={colors.muted}
          />
        ) : row.kind === "folder" ? (
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
      {/*
        The sync mark leads the trailing marks, before the exception pip.

        **It is not an exception mark, and it does not dilute that slot's one
        claim** (see `pip` below): it is a different shape — a ring, or a ringed
        disc — saying a different thing, and it is transient where the pip is a
        standing fact. It leads because it is the one of the two a person may
        have to act on.
      */}
      {sync === null ? null : <SyncMarkDot mark={sync} />}
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
      {/*
        The trailing chevron the canvas draws, and only inside the card.

        In a grouped list it is the thing that says a row goes somewhere — the
        leading gutter's chevron says "this is a folder", which is a different
        claim and is why both exist. Outside the card there is no list edge for
        it to sit against and the leading one already carries the listing.
      */}
      {card ? <Icon name="chevronRight" size={14} color={colors.chromeMuted} /> : null}
    </PressRow>
    </View>
  );
}

/** See `FileTree`: the 8pt a 36pt row is short of the touch floor, halved. */
const ROW_SLOP = layout.explorerRowSlop;

const makeStyles = (colors: Colors) => StyleSheet.create({
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
  /**
   * Under a drag that would land here. `FileTree`'s own wash, to the pixel.
   *
   * On the wrapper the gestures are attached to rather than on the `PressRow`,
   * so it cannot be overwritten by a hover fill — a pointer holding a drag is
   * over the row by definition, and the two painting the same box would mean
   * the drop target is invisible exactly when it matters. It carries the row's
   * own corner radius because the wrapper has none of its own, and a square
   * block behind a rounded row is the artefact that gives away a wash drawn in
   * the wrong place.
   */
  rowDrop: { backgroundColor: colors.accentDim, borderRadius: radii.md },
  /** Square inside the phone's grouped card, whose rows are flush. */
  rowDropCard: { borderRadius: 0 },
  /*
    Taller inside the card: `layout.explorerRow` is the tree's 36pt pitch,
    drawn for a 260pt column beside a document. A grouped list on a phone is
    the screen, and the canvas draws 48 — which is also comfortably over the
    touch floor, so `hitSlop` stops doing work here.
  */
  rowCard: { height: 48, paddingLeft: space.x4, paddingRight: space.x4 },
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
   *
   * **This slot is for exceptions, and that is why there is no count here.**
   * `Phone-Browse.dc.html` draws a `3` beside `0-inbox` in this position; the
   * owner declined it on 2026-09-18 — "that is not what the inbox there means"
   * — and the reason it belongs in this comment rather than only in the design
   * record is that the slot is the argument. A count is not an exception about
   * anything, so it would be the first mark here not making the listing's one
   * claim, and the pip beside it would lose the meaning it has by being the
   * only thing in the slot. See `docs/decisions/app-and-console.md`, "A folder
   * row says what differs, so `0-inbox` gets no count".
   */
  pip: { width: 7, height: 7, borderRadius: 4 },
  pipTeam: { backgroundColor: colors.accent },
  pipPrivate: { backgroundColor: colors.muted },
  /* The violet this palette already defines as "somebody else's access". */
  pipGroup: { backgroundColor: colors.sharedText },
});

/*
  The shapes `useRowInteractions` needs when there is no drag to wire. Spelled
  out here rather than imported from `FileTree`, whose copies are private to
  it — three empty functions are cheaper than a shared module, and neither file
  has an opinion the other could drift from.
*/
function noopPath(_path: string): void {}
function noopDrop(_path: string, _modifiers: readonly DragModifier[]): void {}
function noopVoid(): void {}
