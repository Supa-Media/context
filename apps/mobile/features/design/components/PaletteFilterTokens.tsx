import { Pressable, StyleSheet, View } from "react-native";
import type { PaletteItem } from "../../console/files/palette";
import { fonts, pointerType, radii, space } from "../tokens";
import { useColors, useThemedStyles, type Colors } from "../theme";
import { Icon } from "./Icon";
import { Text } from "./Text";

/**
 * Typed filters for a palette: what is offered while one is being typed, and
 * the chips in the field for the ones already picked. The rules are the
 * caller's (⌘K's are `console/layout/searchFilters.ts`); the palette only asks.
 */
export interface PaletteFilters {
  /** The filters in force, drawn as chips at the start of the field. */
  active: readonly { key: string; label: string }[];
  remove: (key: string) => void;
  /**
   * While a filter is being typed ("rent in:ac"): the rows to pick from, what
   * to say when there are none, and the words that remain the search.
   */
  suggest: (query: string) => { heading: string; items: PaletteItem[]; empty: string; rest: string } | null;
  /** Listed under an empty field, after Recent, so people find out filters exist. */
  idle: { heading: string; items: PaletteItem[] } | null;
  /** A filter row was picked; returns what the field says now. */
  pick: (item: PaletteItem, query: string) => string;
  /** The field changed; returns it with any finished filter turned into a chip. */
  absorb: (query: string) => string;
}

/** The chips at the start of the field, each with its own ×. */
export function FilterTokens({ filters }: { filters: PaletteFilters | undefined }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  if (filters === undefined || filters.active.length === 0) return null;
  return (
    <View style={styles.tokens}>
      {filters.active.map((token) => (
        <Pressable
          key={token.key}
          onPress={() => filters.remove(token.key)}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${token.label}`}
          style={({ pressed }) => [styles.token, pressed ? styles.pressed : null]}
          testID={`palette-filter-${token.key}`}
        >
          <Text style={styles.tokenText} numberOfLines={1}>{token.label}</Text>
          <Icon name="close" size={12} color={colors.text2} />
        </Pressable>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    tokens: { flexDirection: "row", gap: space.x1, flexShrink: 0 },
    token: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      height: 26,
      paddingLeft: space.x2,
      paddingRight: 6,
      borderRadius: radii.pill,
      backgroundColor: colors.accentDim,
    },
    tokenText: { fontFamily: fonts.body, fontSize: pointerType.meta, fontWeight: "600", color: colors.accentText, maxWidth: 180 },
    pressed: { opacity: 0.6 },
  });
