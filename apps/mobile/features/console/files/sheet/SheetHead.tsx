/**
 * The sheet's own heading, as the approved design draws it: the table glyph
 * in a tile, the file's name, and "Sheet" with who can see it. A note's
 * heading is its first line of Markdown; a CSV has none, so the name is the
 * file's.
 */

import { StyleSheet, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";

export function SheetHead({ path, visibility }: { path: string; visibility?: string }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const name = path.split("/").pop() ?? path;
  return (
    <View style={styles.head} testID="sheet-head">
      <View style={styles.tile}>
        <Icon name="table" size={18} color={colors.accentText} />
      </View>
      <View style={styles.words}>
        <Text variant="paneTitle" numberOfLines={1} testID="sheet-title">
          {name}
        </Text>
        <Text variant="meta" style={styles.sub} testID="sheet-subtitle">
          {visibility === undefined ? "Sheet" : `Sheet · ${visibility}`}
        </Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "flex-start", gap: space.x3, marginBottom: space.x3 },
    tile: {
      width: 32,
      height: 32,
      marginTop: 2,
      borderRadius: radii.sm,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface2,
    },
    words: { flexShrink: 1, gap: 2 },
    sub: { color: colors.muted },
  });
