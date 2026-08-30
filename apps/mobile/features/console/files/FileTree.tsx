import { StyleSheet, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { colors, layout, radii } from "../../design/tokens";
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
 * drawn to be a picture of that:
 *
 *  - a **folder** carries its default as the mockup's quiet 10px `.lock`
 *    label. It is information, not an alarm;
 *  - a **file that differs from its folder** gets a pill — visually louder,
 *    because it is the exceptional thing on the screen;
 *  - a **file that inherits** gets a single muted dot. Not a label: labelling
 *    every note in a private folder "private" draws the default five times and
 *    leaves the one shared note with no more weight than its neighbours, which
 *    is the opposite of what the file says. The dot is a target to press, not a
 *    statement, and its accessibility label spells out what it would change.
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
 * into on a phone is the *only* way to open a note there. So `touch` raises the
 * row to `layout.touchRow`, widens the indent step so two levels are still
 * distinguishable at that height, and grows the type to the size the rest of
 * the phone reads at.
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
              <Text variant="treeMeta">{row.name}</Text>
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
        style={StyleSheet.flatten([
          styles.node,
          styles.nodeGrow,
          touch && styles.nodeTouch,
          { paddingLeft: indentFor(row.depth, touch) },
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
          style={row.selected ? styles.nodeSelectedLabel : undefined}
        >
          {row.name}
        </Text>
      </PressRow>

      <VisibilityControl row={row} canSetVisibility={canSetVisibility} onPress={() => onCycleVisibility(row)} />
    </View>
  );
}

/**
 * The indent for a depth, which is not one number times a level.
 *
 * A thumb row is twice as tall as a pointer row, and 13pt of indent that reads
 * clearly against a 23pt row disappears against a 48pt one — the eye judges the
 * step against the height of the thing being stepped. Both start from the same
 * leading padding so the two trees have the same left margin.
 */
function indentFor(depth: number, touch: boolean): number {
  return (touch ? 12 : 8) + (touch ? 17 : 13) * depth;
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
  // `privacy.md` has no visibility of its own — it *is* the visibility — so it
  // gets a lock rather than a control that would have nothing to do.
  if (row.readOnly) {
    return (
      <View style={styles.marker}>
        <Text variant="treeMeta" accessibilityLabel="privacy.md is generated and read-only">
          generated
        </Text>
      </View>
    );
  }

  const body =
    row.marker === undefined ? (
      <Text variant="treeMeta" style={styles.inherit} aria-hidden>
        ·
      </Text>
    ) : row.markerIsDefault ? (
      <Text variant="treeMeta" style={styles.defaultMarker}>
        {row.marker}
      </Text>
    ) : (
      <View style={[styles.pill, row.marker === "team" ? styles.pillTeam : styles.pillPrivate]}>
        <Text variant="pill" style={row.marker === "team" ? styles.pillTeamText : styles.pillPrivateText}>
          {row.marker}
        </Text>
      </View>
    );

  if (!canSetVisibility) return <View style={styles.marker}>{body}</View>;

  return (
    <PressRow
      accessibilityLabel={describeVisibility(row)}
      onPress={onPress}
      radius={radii.pill}
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
    return `${row.name} folder default is ${row.marker}. Change it to ${next}.`;
  }
  if (row.marker === undefined) {
    return `${row.name} follows its folder. Give it its own visibility.`;
  }
  return `${row.name} is ${row.marker}, unlike its folder. Change it to ${next}.`;
}

function describeRow(row: TreeRow): string {
  if (row.kind === "folder") return `${row.name}, folder, ${row.expanded ? "open" : "closed"}`;
  return row.name;
}

const styles = StyleSheet.create({
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
  /** The same row, thumb-sized — see the file comment. */
  nodeTouch: { minHeight: layout.touchRow, paddingVertical: 0, paddingRight: 12, gap: 6 },
  chevron: { width: 12, alignItems: "center", justifyContent: "center" },
  chevronTouch: { width: 18 },

  marker: {
    flexGrow: 0,
    flexShrink: 0,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: radii.pill,
    minWidth: 22,
    alignItems: "center",
  },
  markerHover: { backgroundColor: colors.surface3 },
  /** The "follows its folder" affordance: reachable, not shouted. */
  inherit: { color: colors.line, fontSize: 13 },
  defaultMarker: { color: colors.muted },

  /** `.pill`, shrunk to sit on a 13px row. */
  pill: {
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  pillTeam: { backgroundColor: colors.okWash, borderColor: colors.okBorder },
  pillTeamText: { color: colors.okText, fontSize: 10 },
  pillPrivate: { backgroundColor: colors.surface3, borderColor: colors.lineStrong },
  pillPrivateText: { color: colors.text2, fontSize: 10 },
});
