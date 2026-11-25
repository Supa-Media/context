/**
 * The lock line over a sheet a source keeps up to date (the data sources
 * board, 08): who keeps it, that an edit would be replaced at the next sync,
 * and a link to the source's own page. The sheet under it is read-only.
 * On a phone the link is left off, as the board draws it: the page's back
 * button goes to the source's folder.
 */

import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType, radii } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { LockGlyph } from "../data/Marks";

export function SyncedBanner({ name, compact, onOpenSource }: { name: string; compact: boolean; onOpenSource?: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={[styles.banner, compact && styles.bannerPhone]} role="note" testID="sheet-synced">
      <View style={compact ? styles.lockPhone : undefined}>
        <LockGlyph size={13} color={colors.muted} />
      </View>
      <Text style={[styles.words, compact && styles.wordsPhone]}>{`Kept up to date by ${name}. Edits here are replaced at the next sync.`}</Text>
      {compact || onOpenSource === undefined ? null : (
        <Pressable onPress={onOpenSource} role="link" accessibilityLabel={`${name} source`} hitSlop={6} testID="sheet-synced-source">
          <Text style={styles.link}>{`${name} source`}</Text>
        </Pressable>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    banner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 8,
      paddingHorizontal: 12,
      marginBottom: 12,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    bannerPhone: { alignItems: "flex-start", paddingVertical: 10, borderRadius: radii.card },
    lockPhone: { marginTop: 3 },
    words: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: pointerType.meta, lineHeight: 18, color: colors.text2 },
    wordsPhone: { fontSize: pointerType.ui, lineHeight: 20 },
    link: { fontSize: pointerType.meta, lineHeight: 18, fontWeight: "500", color: colors.accentText },
  });
