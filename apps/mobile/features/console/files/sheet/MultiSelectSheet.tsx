/**
 * A multi-select cell being edited on a phone: the sheet from the bottom that
 * every sheet menu uses there. The column's name and "Netflix · 3 chosen" head
 * it, with Done at the top right so the keyboard never covers it; a field
 * finds or creates an option; and every option is a row with a ✓ when chosen,
 * toggled by a tap, in the column's order so nothing jumps. Closing it any way
 * saves, as Done does.
 */

import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { Popover } from "./Popover";
import { addOption, chosenOf, draftOf, optionFor, sheetList, toggleOption } from "./multiSelect";
import { OptionChip, type MultiSelectEditorProps } from "./multiSelectParts";

export function MultiSelectSheet({
  label,
  rowLabel,
  draft,
  options,
  onDraft,
  onFinish,
}: Omit<MultiSelectEditorProps, "anchor"> & { rowLabel: string }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [typed, setTyped] = useState("");
  const chosen = chosenOf(draft);
  const list = sheetList(options, chosen, typed);
  const set = (next: string[]) => onDraft(draftOf(next));
  const done = () => {
    if (typed.trim() !== "") set(addOption(chosen, optionFor(options, typed)));
    onFinish("save");
  };
  const count = `${chosen.length} chosen`;

  return (
    <Popover anchor={null} width={320} maxHeight={560} onDismiss={done} testID="sheet-multiselect-sheet">
      <View style={styles.head}>
        <View style={styles.titles}>
          <Text variant="body" numberOfLines={1} style={styles.title}>
            {label}
          </Text>
          <Text variant="meta" numberOfLines={1} style={styles.muted}>
            {rowLabel === "" ? count : `${rowLabel} · ${count}`}
          </Text>
        </View>
        <Pressable accessibilityRole="button" onPress={done} style={[styles.done, { backgroundColor: colors.accent }]} testID="sheet-multiselect-done">
          <Text variant="body" style={[styles.doneText, { color: colors.ground }]}>
            Done
          </Text>
        </Pressable>
      </View>
      <TextInput
        value={typed}
        onChangeText={(value) => setTyped(value.replace(/,/g, " "))}
        onSubmitEditing={() => {
          if (typed.trim() === "") return;
          set(addOption(chosen, optionFor(options, typed)));
          setTyped("");
        }}
        placeholder="Find or create an option"
        placeholderTextColor={colors.chromeMuted}
        accessibilityLabel={`Find or create a ${label} option`}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.field}
        testID="sheet-cell-editor"
      />
      <View style={styles.group}>
        {list.rows.map((word, i) => {
          const on = chosen.some((c) => c.toLowerCase() === word.toLowerCase());
          return (
            <Pressable
              key={word}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              onPress={() => set(toggleOption(chosen, word))}
              style={[styles.row, i > 0 && styles.rule]}
              testID="sheet-option-row"
            >
              <OptionChip word={word} options={options} size={15} />
              {on ? <Text variant="body" style={styles.check}>✓</Text> : null}
            </Pressable>
          );
        })}
        {list.create === null ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              set(addOption(chosen, list.create as string));
              setTyped("");
            }}
            style={[styles.row, list.rows.length > 0 && styles.rule]}
            testID="sheet-option-create"
          >
            <Text variant="body" style={styles.muted}>
              Create
            </Text>
            <OptionChip word={list.create} options={options} size={15} />
          </Pressable>
        )}
      </View>
    </Popover>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "center", gap: space.x2, marginBottom: space.x3 },
    titles: { flex: 1, gap: 2 },
    title: { color: colors.text, fontWeight: "600" },
    muted: { color: colors.muted },
    done: { height: 34, paddingHorizontal: space.x3, borderRadius: 10, justifyContent: "center" },
    doneText: { fontWeight: "600" },
    field: {
      height: 44,
      paddingHorizontal: space.x3,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.control,
      color: colors.text,
      backgroundColor: colors.ground,
      fontSize: 16,
      marginBottom: space.x3,
    } as object,
    group: { borderRadius: 14, backgroundColor: colors.ground, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
    row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.x2, paddingHorizontal: space.x4 },
    rule: { borderTopWidth: 1, borderColor: colors.line },
    check: { marginLeft: "auto", color: colors.accentText, fontWeight: "600" },
  });
