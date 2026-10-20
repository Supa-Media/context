/**
 * Finding people on the Waitlist by their answer to "what would you use it
 * for?" (Tex launch, 2026-10-20: "staff need to read/search/filter these
 * reasons … to prioritize people if volume is high"). A search field and an
 * "Answered only" chip under the segments, and the sentence that says what
 * they found. The filtering itself is the server's (`listWaitlist`'s `search`
 * and `answered`), because the list on screen is only the newest page.
 */

import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Text, leading, radii, space, useColors, useThemedStyles, type Colors } from "../design";
import { Icon } from "../design/components/Icon";
import { useFieldFont } from "../design/fieldFont";
import { fonts, pointerType } from "../design/tokens";
import { useCompact } from "./AdminKit";
import { filterSentence } from "./waitlist";

export function WaitlistFilter({
  search,
  onSearch,
  answered,
  onAnswered,
  result,
  total,
}: {
  search: string;
  onSearch: (value: string) => void;
  answered: boolean;
  onAnswered: (value: boolean) => void;
  /** What the server found for the applied filter, when one is applied and has answered. */
  result: { matches: number; capped: boolean } | null;
  /** Everyone in this list, for "131 of 214 answered". */
  total: number | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const compact = useCompact();
  const fieldFont = useFieldFont(pointerType.ui);
  const sentence = result === null ? null : filterSentence(search, answered, result, total);
  return (
    <View style={[styles.bar, compact && styles.barCompact]} testID="admin-waitlist-filter-bar">
      <View style={[styles.field, compact && styles.fieldCompact]}>
        <Icon name="search" size={14} color={colors.muted} />
        <TextInput
          value={search}
          onChangeText={onSearch}
          placeholder="Search answers"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Search answers"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={100}
          style={[styles.input, fieldFont]}
          testID="admin-waitlist-search"
        />
        {search.length > 0 ? (
          <Pressable
            onPress={() => onSearch("")}
            accessibilityLabel="Clear search"
            role="button"
            hitSlop={compact ? 12 : 8}
            style={styles.clear}
            testID="admin-waitlist-search-clear"
          >
            <Icon name="close" size={10} color={colors.text2} />
          </Pressable>
        ) : null}
      </View>
      <Pressable
        onPress={() => onAnswered(!answered)}
        role="checkbox"
        aria-checked={answered}
        accessibilityLabel="Answered only"
        style={[styles.chip, compact && styles.chipCompact, answered && styles.chipOn]}
        testID="admin-waitlist-answered"
      >
        <View style={[styles.box, answered && styles.boxOn]}>
          {answered ? <Icon name="check" size={9} color={colors.white} /> : null}
        </View>
        <Text style={[styles.chipLabel, answered && styles.chipLabelOn]}>Answered only</Text>
      </Pressable>
      {sentence !== null ? (
        <Text variant="meta" role="status" style={[styles.sentence, compact && styles.sentenceCompact]} testID="admin-waitlist-filter-sentence">
          {sentence}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    bar: { flexDirection: "row", alignItems: "center", gap: space.x2, flexWrap: "wrap" },
    barCompact: { alignItems: "stretch" },
    field: {
      width: 360,
      maxWidth: "100%",
      height: 36,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.well,
    },
    fieldCompact: { width: "100%", height: 48 },
    input: {
      flex: 1,
      minWidth: 0,
      height: "100%",
      fontFamily: fonts.body,
      color: colors.text,
      outlineStyle: "none",
    } as never,
    clear: {
      width: 20,
      height: 20,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface3,
    },
    chip: {
      height: 36,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.pill,
    },
    chipCompact: { height: 44 },
    chipOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
    box: {
      width: 14,
      height: 14,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1.5,
      borderColor: colors.lineStrong,
      borderRadius: radii.xs,
    },
    boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipLabel: { fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.4), color: colors.text },
    chipLabelOn: { color: colors.accent, fontWeight: "600" },
    sentence: { marginLeft: "auto" },
    sentenceCompact: { marginLeft: 0, width: "100%" },
  });
