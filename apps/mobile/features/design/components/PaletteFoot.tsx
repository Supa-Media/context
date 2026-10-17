import { StyleSheet, View } from "react-native";
import { fonts, pointerType, space } from "../tokens";
import { useThemedStyles, type Colors } from "../theme";
import { Text } from "./Text";

/** Wide enough for the list and the note beside it (board B1); narrower, the panel is the list alone. */
export const PREVIEW_MIN_WIDTH = 1100;

/**
 * The pointer panel's foot: the keys, and Tab's "show only these names in the
 * tree" while something is typed. Tab is what the tree's own filter field did
 * before search became one bar (leadership weekly, 2026-10-17), so it is said
 * where somebody looking for that field will look: under the list.
 */
export function PaletteFoot({ onNarrowTree }: { onNarrowTree?: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.foot} testID="palette-foot">
      <Key styles={styles} glyph="↑↓" label="move" />
      <Key styles={styles} glyph="↵" label="open" />
      {onNarrowTree === undefined ? null : (
        <Text
          style={[styles.label, styles.trailing]}
          onPress={onNarrowTree}
          role="button"
          accessibilityLabel="Show only these names in the tree"
          testID="palette-narrow-tree"
        >
          <Text style={styles.kbd}>⇥</Text> Show only these names in the tree
        </Text>
      )}
    </View>
  );
}

function Key({ styles, glyph, label }: { styles: ReturnType<typeof makeStyles>; glyph: string; label: string }) {
  return (
    <Text style={styles.label}>
      <Text style={styles.kbd}>{glyph}</Text> {label}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    foot: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x4,
      paddingHorizontal: space.x4,
      paddingVertical: space.x2,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    label: { fontFamily: fonts.body, fontSize: pointerType.label, color: colors.muted },
    kbd: { fontFamily: fonts.mono, fontSize: pointerType.label, color: colors.text2 },
    trailing: { marginLeft: "auto", color: colors.text, fontWeight: "600" },
  });
