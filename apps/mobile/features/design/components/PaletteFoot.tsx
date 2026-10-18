import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { fonts, pointerType, space } from "../tokens";
import { useThemedStyles, type Colors } from "../theme";
import { Text } from "./Text";
import type { PaletteItem } from "../../console/files/palette";
import { isRich } from "./PaletteResultRow";

/** Wide enough for the list and the note beside it (board B1); narrower, the panel is the list alone. */
export const PREVIEW_MIN_WIDTH = 1100;

/**
 * Whether the panel splits, and what reads beside the list: only on a window
 * wide enough, only once there are answers, and only for an answer.
 */
export function previewPane(
  preview: ((item: PaletteItem, query: string) => ReactNode) | undefined,
  width: number,
  items: readonly PaletteItem[],
  selected: number,
  query: string,
): { wide: boolean; reading: ReactNode } {
  if (preview === undefined || width < PREVIEW_MIN_WIDTH || !items.some(isRich)) return { wide: false, reading: null };
  const highlighted = selected < 0 ? undefined : items[selected];
  return { wide: true, reading: highlighted !== undefined && isRich(highlighted) ? preview(highlighted, query) : null };
}

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

/** The list and, beside it, the highlighted answer read in full (board B1). */
export function PaletteSplit({ list, preview }: { list: ReactNode; preview: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.split}>
      <View style={styles.splitList}>{list}</View>
      <View style={styles.splitPreview} testID="palette-preview">
        {preview}
      </View>
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
    split: { flexDirection: "row", alignItems: "stretch" },
    splitList: { width: 520, flexShrink: 0, borderRightWidth: 1, borderRightColor: colors.line },
    splitPreview: { flex: 1, minWidth: 0 },
  });
