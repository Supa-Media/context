import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { fonts, layout, radii, space, touchType } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { baseName, folderLabel } from "../files/paths";

/**
 * "Search in Clients" (board 07b of the phone Home artboards, 2026-09-30).
 *
 * The bottom bar on a folder page opens search narrowed to that folder and
 * everything inside it; one chip widens it to the whole workspace. The
 * narrowing is the gateway's own `prefix` (`searchContext`), with a trailing
 * slash so `clients` never finds `clients-old`.
 */
export function scopeLabel(folder: string): string {
  return folderLabel(baseName(folder));
}

/** The prefix the server narrows by: the folder and everything under it, never a sibling. */
export function scopePrefix(folder: string): string {
  return `${folder}/`;
}

export function SearchScopeChips({
  folder,
  onWiden,
}: {
  folder: string;
  onWiden: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row} testID="search-scope">
      <View style={[styles.chip, styles.on]} accessibilityState={{ selected: true }} testID="search-scope-folder">
        <Text style={[styles.text, styles.textOn]} numberOfLines={1}>{`In ${scopeLabel(folder)}`}</Text>
      </View>
      <Pressable
        onPress={onWiden}
        accessibilityRole="button"
        accessibilityLabel="Search everywhere"
        style={({ pressed }) => [styles.chip, pressed ? styles.pressed : null]}
        testID="search-scope-everywhere"
      >
        <Text style={styles.text}>Everywhere</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", gap: space.x2, paddingHorizontal: layout.readingMargin, paddingVertical: space.x2 },
    chip: {
      height: 36,
      paddingHorizontal: space.x3,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.line,
      justifyContent: "center",
      maxWidth: 220,
    },
    on: { backgroundColor: colors.accentDim, borderColor: colors.accent },
    text: { fontFamily: fonts.body, fontSize: touchType.ui, color: colors.text2 },
    textOn: { color: colors.accentText, fontWeight: "600" },
    pressed: { opacity: 0.6 },
  });
