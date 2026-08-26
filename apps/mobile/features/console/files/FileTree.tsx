import { StyleSheet, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { colors, radii } from "../../design/tokens";
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
 */
export function FileTree({
  rows,
  canEdit,
  onSelect,
  onToggle,
  onCycleVisibility,
}: {
  rows: readonly TreeRow[];
  canEdit: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onCycleVisibility: (row: TreeRow) => void;
}) {
  return (
    <>
      {rows.map((row) => {
        if (row.kind === "loading" || row.kind === "empty") {
          return (
            <View
              key={row.key}
              style={[styles.node, { paddingLeft: 8 + 13 * (row.depth + 1) }]}
            >
              <Text variant="treeMeta">{row.name}</Text>
            </View>
          );
        }

        return (
          <View key={row.key} style={styles.row}>
            <PressRow
              accessibilityLabel={describeRow(row)}
              selected={row.selected}
              onPress={() => (row.kind === "folder" ? onToggle(row.path) : onSelect(row.path))}
              radius={radii.sm}
              style={StyleSheet.flatten([
                styles.node,
                styles.nodeGrow,
                { paddingLeft: 8 + 13 * row.depth },
              ])}
              hoverStyle={styles.nodeHover}
              selectedStyle={styles.nodeSelected}
            >
              <Text variant="treeMeta" style={styles.chevron} aria-hidden>
                {row.kind === "folder" ? (row.expanded ? "▾" : "▸") : " "}
              </Text>
              <Text
                variant="tree"
                numberOfLines={1}
                style={row.selected ? styles.nodeSelectedLabel : undefined}
              >
                {row.name}
              </Text>
            </PressRow>

            <VisibilityControl
              row={row}
              canEdit={canEdit}
              onPress={() => onCycleVisibility(row)}
            />
          </View>
        );
      })}
    </>
  );
}

function VisibilityControl({
  row,
  canEdit,
  onPress,
}: {
  row: TreeRow;
  canEdit: boolean;
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

  if (!canEdit) return <View style={styles.marker}>{body}</View>;

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
  row: { flexDirection: "row", alignItems: "center" },

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
  chevron: { width: 9, color: colors.muted },

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
