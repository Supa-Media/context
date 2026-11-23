/**
 * A column's menu, opened by pressing its name: rename, its type, sort, insert
 * either side, hide for this session, delete. A read-only sheet keeps only
 * sort and hide, since those change the view and not the file.
 *
 * The menu holds no data of its own. Each choice calls the grid, which applies
 * it to the file and closes the menu.
 */

import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { Popover, type Anchor } from "./Popover";
import { COLUMN_TYPE_ORDER, TYPE_GLYPH, TYPE_LABEL, type ColumnType, type SheetColumn } from "./sheetModel";

export interface ColumnMenuActions {
  onRename: (to: string) => void;
  onRetype: (type: ColumnType) => void;
  onSort: (direction: "asc" | "desc") => void;
  onInsert: (side: "left" | "right") => void;
  onHide: () => void;
  onDelete: () => void;
}

export function ColumnMenu({
  column,
  readOnly,
  anchor,
  actions,
  onClose,
}: {
  column: SheetColumn;
  readOnly: boolean;
  anchor: Anchor | null;
  actions: ColumnMenuActions;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [name, setName] = useState(column.name);
  const [renamed, setRenamed] = useState(false);

  // Rename is kept to the field: it applies on Enter or when focus leaves, and never twice for the same name.
  const rename = () => {
    const next = name.trim();
    if (readOnly || renamed || next === "" || next === column.name) return;
    setRenamed(true);
    actions.onRename(next);
  };
  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <Popover anchor={anchor} width={240} maxHeight={480} onDismiss={onClose} testID="sheet-column-menu">
      <View style={styles.body}>
        <Text variant="meta" style={styles.label}>
          Column name
        </Text>
        <TextInput
          value={name}
          onChangeText={(value) => {
            setName(value);
            setRenamed(false);
          }}
          onBlur={rename}
          onSubmitEditing={rename}
          editable={!readOnly}
          accessibilityLabel="Column name"
          autoFocus={!readOnly}
          style={styles.field}
          testID="sheet-column-name"
        />
        {readOnly ? null : (
          <>
            <Text variant="meta" style={styles.section}>
              Type
            </Text>
            <View style={styles.types}>
              {COLUMN_TYPE_ORDER.map((type) => {
                const current = type === column.type;
                return (
                  <Pressable
                    key={type}
                    accessibilityRole="button"
                    accessibilityState={{ selected: current }}
                    onPress={() => run(() => actions.onRetype(type))}
                    style={[styles.type, current && { backgroundColor: colors.accentDim }]}
                    testID={`sheet-type-${type}`}
                  >
                    <Text variant="mono" style={styles.glyph}>
                      {TYPE_GLYPH[type]}
                    </Text>
                    <Text variant="tree" style={[styles.typeLabel, current && { color: colors.accentText }]}>
                      {TYPE_LABEL[type]}
                    </Text>
                    {current ? <Text variant="tree" style={styles.check}>✓</Text> : null}
                  </Pressable>
                );
              })}
            </View>
          </>
        )}
        <View style={styles.rule} />
        <Item label="Sort ascending" onPress={() => run(() => actions.onSort("asc"))} />
        <Item label="Sort descending" onPress={() => run(() => actions.onSort("desc"))} />
        {readOnly ? null : (
          <>
            <Item label="Insert column left" onPress={() => run(() => actions.onInsert("left"))} />
            <Item label="Insert column right" onPress={() => run(() => actions.onInsert("right"))} />
          </>
        )}
        <Item label="Hide column" onPress={() => run(actions.onHide)} />
        {readOnly ? null : <Item label="Delete column" danger onPress={() => run(actions.onDelete)} />}
      </View>
    </Popover>
  );
}

function Item({ label, danger = false, onPress }: { label: string; danger?: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.item}>
      <Text variant="tree" style={danger ? styles.danger : styles.itemText}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: { gap: space.x1, padding: space.x1 },
    label: { color: colors.chromeMuted, paddingHorizontal: space.x1 },
    section: { color: colors.chromeMuted, paddingHorizontal: space.x1, marginTop: space.x1 },
    field: {
      height: 30,
      paddingHorizontal: space.x2,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.sm,
      color: colors.text,
      backgroundColor: colors.ground,
      fontSize: 13,
    } as object,
    types: { flexDirection: "row", flexWrap: "wrap" },
    type: {
      width: "50%",
      height: 28,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      paddingHorizontal: space.x2,
      borderRadius: radii.sm,
    },
    glyph: { color: colors.chromeMuted, width: 18, textAlign: "center" },
    typeLabel: { color: colors.text, flexShrink: 1 },
    check: { marginLeft: "auto", color: colors.accentText },
    rule: { height: 1, backgroundColor: colors.line, marginVertical: space.x1 },
    item: { height: 30, justifyContent: "center", paddingHorizontal: space.x2, borderRadius: radii.sm },
    itemText: { color: colors.text },
    danger: { color: colors.crit },
  });
