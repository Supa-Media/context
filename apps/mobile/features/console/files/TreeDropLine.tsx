import { StyleSheet, View } from "react-native";
import { radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * The insertion line on a tree row: a folder dropped here goes above or below
 * this row, among its siblings (or into this row's level from another;
 * `treeDrop.ts`). It starts at `left`, under the row's icon, with a small
 * ring, so a line inside Projects sits visibly further in than one between
 * top-level folders: the level the folder would join is the thing to read
 * off it. Drawn by `FileTree`'s row, which owns the indent.
 */
export function TreeDropLine({ side, left }: { side: "above" | "below"; left: number }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[styles.line, side === "above" ? styles.above : styles.below, { left }]}
      testID={`tree-drop-${side}`}
      aria-hidden
    >
      <View style={styles.ring} />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    /** 2pt of accent across the row's edge, above the row's own pressable. */
    line: {
      position: "absolute",
      zIndex: 2,
      right: 4,
      height: 2,
      borderRadius: radii.pill,
      backgroundColor: colors.accent,
    },
    /** Centred on the 1pt gap between rows, so the line above one row is the line below the last. */
    above: { top: -1 },
    below: { bottom: -2 },
    /** The line's start: a ring, so where it begins (the level) reads at a glance. */
    ring: {
      position: "absolute",
      left: -6,
      top: -3,
      width: 8,
      height: 8,
      borderRadius: 4,
      borderWidth: 2,
      borderColor: colors.accent,
      backgroundColor: colors.chrome,
    },
  });
