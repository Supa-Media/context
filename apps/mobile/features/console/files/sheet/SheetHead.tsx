/**
 * The sheet's own heading, as the approved design draws it: the table glyph
 * in a tile, the file's name, and "Sheet" with who can see it. A note's
 * heading is its first line of Markdown; a CSV has none, so the name is the
 * file's.
 */

import { StyleSheet, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { visibilityLabel, type Visibility } from "../types";
import { baseName, displayName } from "../paths";

export function SheetHead({ path, visibility, compact = false }: { path: string; visibility?: string; compact?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  // Contained like every name the console draws (`displayName`); a sheet keeps its `.csv`.
  const name = displayName(baseName(path));
  return (
    <View style={styles.head} testID="sheet-head">
      <View style={styles.tile}>
        <Icon name="table" size={18} color={colors.accentText} />
      </View>
      <View style={styles.words}>
        {/* A phone's page already shows the name as its title, so here it would say it twice. */}
        {compact ? null : (
          <Text variant="paneTitle" numberOfLines={1} style={styles.title} testID="sheet-title">
            {name}
          </Text>
        )}
        <Text variant="meta" style={styles.sub} testID="sheet-subtitle">
          {visibility === undefined ? "Sheet" : `Sheet · ${visibilityLabel(visibility as Visibility)}`}
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
    words: { flexShrink: 1, gap: 2, justifyContent: "center", minHeight: 32 },
    title: { fontSize: pointerType.h3, lineHeight: 26 },
    sub: { color: colors.muted },
  });
