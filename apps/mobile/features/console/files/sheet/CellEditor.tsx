/**
 * The editor that replaces a cell while it is being changed, by its type: a
 * date picker, a choice from the column's values or the workspace's people
 * (new values allowed for a select), or a plain field for the rest. Enter and
 * Tab are read by the grid's keyboard handler on the web; on a phone the field's
 * own submit and blur do the same job.
 */

import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { DateField } from "./DateField";
import type { ColumnType } from "./sheetModel";

/** Choices a select or person editor offers for what has been typed. */
export function suggestionsFor(choices: readonly string[], draft: string, limit = 6): string[] {
  const q = draft.trim().toLowerCase();
  return choices.filter((c) => c.toLowerCase().includes(q) && c.toLowerCase() !== q).slice(0, limit);
}

export function CellEditor({
  type,
  label,
  draft,
  choices,
  onDraft,
  onPick,
  onBlur,
  onSubmit,
}: {
  type: ColumnType;
  label: string;
  draft: string;
  /** A select's values so far, or the workspace's people. */
  choices: readonly string[];
  onDraft: (value: string) => void;
  /** A suggestion was chosen: commit it at once. */
  onPick: (value: string) => void;
  /** Commit what is typed when focus leaves. Not used by choice editors, whose blur comes before a pick. */
  onBlur: () => void;
  onSubmit: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const web = Platform.OS === "web";

  if (type === "date") {
    return <DateField value={draft} label={label} onChange={onDraft} onBlur={onBlur} onSubmit={onSubmit} />;
  }

  const isChoice = type === "select" || type === "person";
  const suggestions = isChoice ? suggestionsFor(choices, draft) : [];
  return (
    <View style={styles.wrap}>
      <TextInput
        autoFocus
        accessibilityLabel={label}
        placeholder={type === "select" ? "Pick or type a new option" : type === "person" ? "Choose a person" : undefined}
        placeholderTextColor={colors.chromeMuted}
        value={draft}
        onChangeText={onDraft}
        onBlur={isChoice ? undefined : onBlur}
        // On the web Enter is read by the grid's keyboard handler, so the field does not also submit.
        onSubmitEditing={web ? undefined : onSubmit}
        keyboardType={type === "number" || type === "usd" ? "decimal-pad" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, (type === "number" || type === "usd") && styles.right]}
        testID="sheet-cell-editor"
      />
      {suggestions.length === 0 ? null : (
        <View style={styles.menu} testID="sheet-cell-suggestions">
          {suggestions.map((s) => (
            <Pressable key={s} accessibilityRole="button" onPress={() => onPick(s)} style={styles.option}>
              <Text variant="body" numberOfLines={1} style={styles.optionText}>
                {s}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { width: "100%", height: 26 },
    input: {
      height: 26,
      paddingHorizontal: space.x1,
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: radii.sm,
      color: colors.text,
      backgroundColor: colors.ground,
      fontSize: 13,
      outlineStyle: "none",
    } as object,
    right: { textAlign: "right", fontVariant: ["tabular-nums"] } as object,
    menu: {
      position: "absolute",
      top: 30,
      left: 0,
      minWidth: 180,
      zIndex: 10,
      padding: space.x1,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
    },
    option: { height: 28, justifyContent: "center", paddingHorizontal: space.x2, borderRadius: radii.sm },
    optionText: { color: colors.text },
  });
