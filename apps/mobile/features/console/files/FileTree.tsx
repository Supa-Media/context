import { StyleSheet, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
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
 * ## There is one presentation, and it is the pointer's
 *
 * **A `touch` prop used to fork every measurement in this file** — a 36pt row
 * at Obsidian's pitch with `hitSlop` making up the 8pt to the touch floor,
 * indent guides, a 15.5pt name, a grey full-width selection, and the trailing
 * marker as a pip rather than a word. It was passed in rather than read from
 * `useFrame`, on the stated grounds that "the same tree is mounted inside the
 * landing page's fake console window". Neither half survived: the landing page
 * mounts no tree, and `<Explorer>` — the only thing that mounts this — is a
 * region `frame.ts` answers `hidden` for at `compact`, so the prop could only
 * ever be `false`.
 *
 * The measurements were not wasted and are not lost. `FolderView` is the
 * phone's browse surface now and carries them (`layout.explorerRow`,
 * `layout.explorerRowSlop`, the `treeTouch` type variant) for the rows it
 * draws; the reference they came off is in `docs/design/obsidian-parity`; and
 * the removed drawing is in the history. What is gone from here is a fork with
 * one caller that could not choose it.
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
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {rows.map((row) => {
        if (row.kind === "loading" || row.kind === "empty") {
          return (
            <View
              key={row.key}
              style={[styles.node, { paddingLeft: indentFor(row.depth + 1) }]}
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
    <View
      style={[styles.row, isDropTarget && styles.rowDrop]}
      ref={interactions.ref as never}
    >
      <PressRow
        accessibilityLabel={describeRow(row)}
        selected={row.selected}
        onPress={() => (row.kind === "folder" ? onToggle(row.path) : onSelect(row.path))}
        radius={radii.sm}
        style={StyleSheet.flatten([
          styles.node,
          styles.nodeGrow,
          { paddingLeft: indentFor(row.depth) },
        ])}
        hoverStyle={styles.nodeHover}
        selectedStyle={styles.nodeSelected}
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
        <View style={styles.chevron}>
          {row.kind === "folder" ? (
            <Icon
              name={row.expanded ? "chevronDown" : "chevronRight"}
              size={12}
              color={colors.muted}
            />
          ) : null}
        </View>
        <Text
          variant="tree"
          numberOfLines={1}
          style={row.selected ? styles.nodeSelectedLabel : undefined}
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

/** The mockup's indent: 8pt of leading padding, 13pt more per level. */
function indentFor(depth: number): number {
  return 8 + 13 * depth;
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

  /*
    The word itself. The column beside a document has the width for `team`, and
    the mockup asks for it there.

    A 7pt pip was drawn instead under `touch`, because a 372pt panel over a note
    does not have that width — on a bucket whose root is private and whose PARA
    folders are not, *every* top-level row differs from its parent, so the rule
    "mark only what differs" printed the same word down the whole tree. There is
    no such panel any more (see the file header), so there is one presentation.
  */
  const body = (
    <Text variant="treeMeta" style={styles.markerLabel} numberOfLines={1}>
      {row.marker}
    </Text>
  );

  if (!canSetVisibility) {
    return (
      <View style={styles.marker} accessibilityLabel={describeVisibility(row)}>
        {body}
      </View>
    );
  }

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
  row: { flexDirection: "row", alignItems: "center", borderRadius: radii.sm, position: "relative" },
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
  chevron: { width: 12, alignItems: "center", justifyContent: "center" },

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
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: radii.sm,
    alignItems: "flex-end",
    justifyContent: "center",
  },
  markerHover: { backgroundColor: colors.surface3 },
  markerLabel: { color: colors.muted },
});
