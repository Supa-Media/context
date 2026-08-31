import { StyleSheet, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import type { DragModifier } from "./dnd";
import { useRowInteractions } from "./rowInteractions";
import type { TreeRow } from "./tree";
import type { Visibility } from "./types";

/**
 * The folder tree.
 *
 * `.tnode` from `docs/design/console-mockup.html`: a 13px indent per level, a
 * quiet trailing marker, the selected row washed in accent. What is new is the
 * trailing marker being **pressable**, which is where visibility is changed.
 *
 * ## Why the markers look the way they do
 *
 * `privacy.md` is folder defaults plus exact-note exceptions, and the tree is
 * drawn to be a picture of that: **a row says something only when it differs
 * from the folder it is in**, and then it says it in the quietest register the
 * screen has — muted, right-aligned, at the size of metadata. `tree.ts` owns
 * the rule; this file owns the drawing.
 *
 * Two things this used to draw and no longer does, both deliberately:
 *
 *  - **A pill on an exceptional file.** A bordered, tinted, capsule-shaped
 *    label is the loudest object this app can put on a 36pt row, and it was
 *    landing on the one row somebody had already decided about. Loud is not the
 *    same as important. The word alone, right-aligned in `muted`, is Obsidian's
 *    idiom for exactly this class of trailing metadata, and it is legible
 *    without shouting over the name beside it.
 *  - **A dot on every inheriting file.** It existed as a press target rather
 *    than as a statement, and the cost was a mark on every row in the tree —
 *    which is precisely the noise the marker rule exists to prevent, reproduced
 *    one glyph smaller. The capability it carried is not lost: the row's own
 *    menu (`menu.ts`) offers `private`, `team` and "follow the folder" on every
 *    row whether or not it is marked, and it is reachable by right-click on a
 *    pointer and a long press under a thumb.
 *
 * A marker that *is* drawn is still pressable for an owner, because a label
 * that states a fact you may change is a control, and one press is a cheaper
 * route than a long press to a menu.
 *
 * ## Where the operations live now
 *
 * Every file operation used to be a button — a toolbar above the tree and a row
 * of seven above the note. They are on the row itself now, raised by a
 * right-click on a pointer and a long press under a thumb, reached through
 * `rowInteractions` so the *gesture* forks per platform while the items
 * (`menu.ts`) and the drop rules (`dnd.ts`) do not.
 *
 * A row that cannot be dragged is not merely inert: `privacy.md` is generated,
 * so `canDrag` is false for it and the browser refuses the drag outright rather
 * than starting one that `dnd.ts` would have to refuse after the animation.
 *
 * ## `touch` is a different tree, not a bigger one
 *
 * The mockup's row is 13px type in 5pt of padding — about 23pt tall. That is
 * right under a pointer and unusable under a thumb, and the drawer this renders
 * into on a phone is the *only* way to open a note there. So `touch` uses the
 * three measures in `layout` that were taken off Obsidian on iOS —
 * `explorerRow` (36), `explorerIndent` (16) and `explorerInset` (37) — and
 * grows the type to the size the rest of the phone reads at.
 *
 * **36 is below the 44pt touch floor and that is not a slip.** It is the pitch
 * the reference sets, and it is the difference between a drawer that shows
 * eight rows and one that shows five — on the only surface from which a note
 * can be opened at all. The floor is met by `hitSlop` on the pressable
 * (`layout.explorerRowSlop` on each edge, derived from the two numbers so they
 * cannot drift apart), which is the one legitimate way to draw under it: the
 * *visual* is 36 and the *target* is 44. An earlier pass met the floor by
 * making the row 48 tall, which is how a phone file tree ends up looking like a
 * settings screen.
 *
 * It is passed in rather than read from `useFrame` here for the reason the rest
 * of this file is prop-driven: the same tree is mounted inside the landing
 * page's fake console window, where the frame is a fallback and the density is
 * the *browser's*, not the picture's.
 */
export function FileTree({
  rows,
  canSetVisibility,
  onSelect,
  onToggle,
  onCycleVisibility,
  onMenu,
  drag,
  dropTarget = null,
  touch = false,
}: {
  rows: readonly TreeRow[];
  /**
   * Whether the visibility markers are pressable. Owner-only — an editor
   * changing visibility is an editor deciding their own clearance, which is
   * the live breach this prop's rename records. The marker still RENDERS for
   * everyone; what a non-owner loses is the press.
   */
  canSetVisibility: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onCycleVisibility: (row: TreeRow) => void;
  /** Raise the row's menu. Absent where there is nothing to offer. */
  onMenu?: (row: TreeRow, anchor: { x: number; y: number }) => void;
  /** Drag wiring. Absent in the read-only demo, which must not offer one. */
  drag?: TreeDragHandlers;
  /** The row under a drag, washed to say the drop would land there. */
  dropTarget?: string | null;
  /** Thumb sizing — see the file comment. */
  touch?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {rows.map((row) => {
        if (row.kind === "loading" || row.kind === "empty") {
          return (
            <View
              key={row.key}
              style={[
                styles.node,
                touch && styles.nodeTouch,
                { paddingLeft: indentFor(row.depth + 1, touch) },
              ]}
            >
              <Text variant="treeMeta">{row.label}</Text>
            </View>
          );
        }

        return (
          <FileRow
            key={row.key}
            row={row}
            canSetVisibility={canSetVisibility}
            onSelect={onSelect}
            onToggle={onToggle}
            onCycleVisibility={onCycleVisibility}
            onMenu={onMenu}
            drag={drag}
            isDropTarget={dropTarget === row.path}
            touch={touch}
          />
        );
      })}
    </>
  );
}

/** What the tree needs from whoever owns the drag. */
export interface TreeDragHandlers {
  onDragStart: (path: string) => void;
  onDragOver: (path: string, modifiers: readonly DragModifier[]) => void;
  onDragLeave: (path: string) => void;
  onDrop: (path: string, modifiers: readonly DragModifier[]) => void;
  onDragEnd: () => void;
  /** Whether this row may be picked up, and whether a drop may land on it. */
  canDrag: (row: TreeRow) => boolean;
  canDrop: (row: TreeRow) => boolean;
}

/**
 * One row.
 *
 * Extracted from the map so it can hold a hook — `useRowInteractions` attaches
 * the platform's gesture, and a hook cannot be called inside a loop body.
 */
function FileRow({
  row,
  canSetVisibility,
  onSelect,
  onToggle,
  onCycleVisibility,
  onMenu,
  drag,
  isDropTarget,
  touch,
}: {
  row: TreeRow;
  /**
   * Whether the visibility markers are pressable. Owner-only — an editor
   * changing visibility is an editor deciding their own clearance, which is
   * the live breach this prop's rename records. The marker still RENDERS for
   * everyone; what a non-owner loses is the press.
   */
  canSetVisibility: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onCycleVisibility: (row: TreeRow) => void;
  onMenu?: (row: TreeRow, anchor: { x: number; y: number }) => void;
  drag?: TreeDragHandlers;
  isDropTarget: boolean;
  touch: boolean;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const interactions = useRowInteractions({
    path: row.path,
    // Passed through as absent rather than wrapped in a no-op, because
    // "there is no menu here" is a fact the hook has to be able to see: it is
    // what stops a right-click being swallowed by a row that has nothing to
    // put in the browser menu's place.
    onMenu: onMenu === undefined ? undefined : (anchor) => onMenu(row, anchor),
    canDrag: drag !== undefined && drag.canDrag(row),
    canDrop: drag !== undefined && drag.canDrop(row),
    onDragStart: drag?.onDragStart ?? noopPath,
    onDragOver: drag?.onDragOver ?? noopDrop,
    onDragLeave: drag?.onDragLeave ?? noopPath,
    onDrop: drag?.onDrop ?? noopDrop,
    onDragEnd: drag?.onDragEnd ?? noopVoid,
  });

  return (
    <View style={[styles.row, isDropTarget && styles.rowDrop]} ref={interactions.ref as never}>
      <PressRow
        accessibilityLabel={describeRow(row)}
        selected={row.selected}
        onPress={() => (row.kind === "folder" ? onToggle(row.path) : onSelect(row.path))}
        radius={radii.sm}
        /*
          The 8pt the 36pt row is short of the touch floor, split between its
          two edges. See the file comment: on a phone the drawn row is
          `layout.explorerRow` and the target is `layout.minTouchTarget`, and
          this is the whole of the difference between them.
        */
        hitSlop={touch ? { top: ROW_SLOP, bottom: ROW_SLOP } : undefined}
        style={StyleSheet.flatten([
          styles.node,
          styles.nodeGrow,
          touch && styles.nodeTouch,
          { paddingLeft: indentFor(row.depth, touch) },
        ])}
        hoverStyle={styles.nodeHover}
        selectedStyle={touch ? styles.nodeSelectedTouch : styles.nodeSelected}
        // Unconditional: `useRowInteractions` already returns nothing to
        // spread when there is no menu, and one copy of that rule is the point
        // — a second one here is the copy that would drift.
        {...interactions.pressableProps}
      >
        {/*
          A folder gets a chevron and a file gets an empty box of the same
          width, so every name in the tree starts on one vertical line. A file
          with no reserved box would hang its name under its folder's chevron,
          which reads as a second level of indent that is not there.
        */}
        <View style={[styles.chevron, touch && styles.chevronTouch]}>
          {row.kind === "folder" ? (
            <Icon
              name={row.expanded ? "chevronDown" : "chevronRight"}
              size={touch ? 15 : 12}
              color={colors.muted}
            />
          ) : null}
        </View>
        <Text
          variant={touch ? "treeTouch" : "tree"}
          numberOfLines={1}
          style={row.selected && !touch ? styles.nodeSelectedLabel : undefined}
        >
          {row.label}
        </Text>
      </PressRow>

      <VisibilityControl
        row={row}
        canSetVisibility={canSetVisibility}
        onPress={() => onCycleVisibility(row)}
      />
    </View>
  );
}

/**
 * The chevron gutter on a phone: the box, plus the gap after it.
 *
 * Named because `indentFor` has to subtract it. `explorerInset` is measured to
 * where a top-level *name* begins, which is the thing the eye actually lines
 * up on, but `paddingLeft` is applied before the chevron — so the padding is
 * the inset minus whatever the chevron occupies. Writing 13 here instead and
 * claiming in a comment that it comes to 37 is the shape of arithmetic this
 * codebase keeps finding has quietly stopped being true.
 */
const CHEVRON_GUTTER = 18 + 6;

const ROW_SLOP = layout.explorerRowSlop;

/**
 * The indent for a depth, which is not one number times a level.
 *
 * A thumb row is half again as tall as a pointer row, and 13pt of indent that
 * reads clearly against a 23pt row is thin against a 36pt one — the eye judges
 * the step against the height of the thing being stepped. The phone's two
 * numbers are measured off Obsidian on iOS (`layout.explorerIndent`,
 * `layout.explorerInset`) rather than chosen; the pointer layout keeps the
 * mockup's.
 */
function indentFor(depth: number, touch: boolean): number {
  if (!touch) return 8 + 13 * depth;
  return layout.explorerInset - CHEVRON_GUTTER + layout.explorerIndent * depth;
}

function noopPath(_path: string): void {}
function noopDrop(_path: string, _modifiers: readonly DragModifier[]): void {}
function noopVoid(): void {}

function VisibilityControl({
  row,
  canSetVisibility,
  onPress,
}: {
  row: TreeRow;
  /**
   * Whether the visibility markers are pressable. Owner-only — an editor
   * changing visibility is an editor deciding their own clearance, which is
   * the live breach this prop's rename records. The marker still RENDERS for
   * everyone; what a non-owner loses is the press.
   */
  canSetVisibility: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  // `privacy.md` has no visibility of its own — it *is* the visibility — so it
  // says what it is rather than offering a control that would have nothing to
  // do.
  if (row.readOnly) {
    return (
      <View style={styles.marker}>
        <Text
          variant="treeMeta"
          style={styles.markerLabel}
          accessibilityLabel="privacy.md is generated and read-only"
        >
          generated
        </Text>
      </View>
    );
  }

  /*
    Nothing at all for a row that is its folder's default, which is nearly
    every row. Not an empty box either: a reserved 22pt gutter down the right
    of the tree is the same visual weight as the dot it replaced, spent on
    saying nothing. `tree.ts` decides what counts as worth saying.
  */
  if (row.marker === undefined) return null;

  const body = (
    <Text variant="treeMeta" style={styles.markerLabel} numberOfLines={1}>
      {row.marker}
    </Text>
  );

  if (!canSetVisibility) return <View style={styles.marker}>{body}</View>;

  return (
    <PressRow
      accessibilityLabel={describeVisibility(row)}
      onPress={onPress}
      radius={radii.sm}
      style={styles.marker}
      hoverStyle={styles.markerHover}
    >
      {body}
    </PressRow>
  );
}

/** What a screen reader hears. Says the state *and* what pressing would do. */
export function describeVisibility(row: TreeRow): string {
  const next: Visibility = row.marker === "team" ? "private" : "team";
  if (row.kind === "folder") {
    return `${row.label} folder default is ${row.marker}. Change it to ${next}.`;
  }
  if (row.marker === undefined) {
    return `${row.label} follows its folder. Give it its own visibility.`;
  }
  return `${row.label} is ${row.marker}, unlike its folder. Change it to ${next}.`;
}

/*
  What a screen reader hears for the row itself.

  `label`, not `name`: it is what is on screen, and announcing "README dot m d"
  for a row that reads "README" describes a screen the listener is not on. The
  extension is never the distinguishing fact here — every note in a context is
  markdown — and where it *is* (an attachment) `displayName` keeps it.
*/
function describeRow(row: TreeRow): string {
  if (row.kind === "folder") return `${row.label}, folder, ${row.expanded ? "open" : "closed"}`;
  return row.label;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", borderRadius: radii.sm },
  /**
   * The row a drop would land in.
   *
   * A wash, never an insertion line between rows: a bucket lists
   * alphabetically, so there is no position to drop *between*, and a line would
   * promise an ordering the storage does not have.
   */
  rowDrop: { backgroundColor: colors.accentDim },

  /** `.tnode` */
  node: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 5,
    paddingRight: 8,
    borderRadius: radii.sm,
  },
  nodeGrow: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  nodeHover: { backgroundColor: colors.surface3 },
  nodeSelected: { backgroundColor: colors.accentDim },
  nodeSelectedLabel: { color: colors.accentText },
  /**
   * The same row, thumb-sized — see the file comment.
   *
   * `height` rather than `minHeight`: the pitch is the measurement, and a row
   * free to grow past it is a tree whose rhythm depends on how long a name is.
   */
  nodeTouch: {
    height: layout.explorerRow,
    paddingVertical: 0,
    paddingRight: 12,
    gap: 6,
    borderRadius: radii.md,
  },
  /**
   * The selected row on a phone: a grey wash, and the name in ordinary ink.
   *
   * The accent wash and accent label are the pointer layout's, from the
   * mockup, and they are right there — a tree beside a note needs to say which
   * of forty rows the document on the right belongs to. On a phone the tree is
   * a drawer that closes the moment you choose something, so the selection is
   * a memory aid rather than a live correspondence, and a blue-on-blue row is
   * the loudest thing on the panel for no work done. Obsidian tints it grey.
   */
  nodeSelectedTouch: { backgroundColor: colors.surface3 },
  chevron: { width: 12, alignItems: "center", justifyContent: "center" },
  chevronTouch: { width: 18 },

  /**
   * The trailing metadata's box.
   *
   * No fill, no border, no minimum width: it is a word, and the only reason it
   * is a `PressRow` at all is that the fact it states is one an owner may
   * change. See the file comment for what used to be here.
   */
  marker: {
    flexGrow: 0,
    flexShrink: 0,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
    alignItems: "flex-end",
    justifyContent: "center",
  },
  markerHover: { backgroundColor: colors.surface3 },
  markerLabel: { color: colors.muted },
});
