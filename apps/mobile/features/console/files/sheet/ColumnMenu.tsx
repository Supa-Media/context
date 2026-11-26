/**
 * A column's menu, opened by pressing its name: rename, its type, wrap its
 * text (text, link and multi-select), sort, insert either side, hide for this
 * session, delete. A phone, which has no edge to drag, also sets the width
 * here: − and + by 40, and Fit. Wrap and width are written into the header, so
 * everyone who opens the sheet sees the same. A read-only sheet keeps only
 * sort and hide, since those change the view and not the file.
 *
 * The menu holds no data of its own. Each choice calls the grid, which applies
 * it to the file and closes the menu.
 */

import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { Switch } from "../../../design/components/Switch";
import { densityFor } from "../../../app/frame";
import { Text } from "../../../design/components/Text";
import { pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { Popover, type Anchor } from "./Popover";
import { canWrap, COLUMN_TYPE_ORDER, TYPE_GLYPH, TYPE_LABEL, type ColumnType, type SheetColumn } from "./sheetModel";

/** How far one press of the phone's width − or + moves it. */
export const WIDTH_STEP = 40;
import { useFieldFont } from "../../../design/fieldFont";

export interface ColumnMenuActions {
  onRename: (to: string) => void;
  onRetype: (type: ColumnType) => void;
  onWrap: (wrap: boolean) => void;
  /** A width in pixels, or "fit" for the longest value shown. */
  onWidth: (width: number | "fit") => void;
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
  width,
}: {
  column: SheetColumn;
  readOnly: boolean;
  /** The width the column draws at now, which the phone's stepper starts from. */
  width: number;
  anchor: Anchor | null;
  actions: ColumnMenuActions;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(pointerType.ui);
  const colors = useColors();
  const [name, setName] = useState(column.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renamed, setRenamed] = useState(false);
  const windowWidth = useWindowDimensions().width;
  const phone = anchor === null || densityFor(windowWidth) === "compact";
  const wraps = column.wrap !== false;

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
          style={[styles.field, fieldFont]}
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
                    <Text variant="tree" numberOfLines={1} style={[styles.typeLabel, current && { color: colors.accentText }]}>
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
        {readOnly || phone || !canWrap(column.type) ? null : (
          // Applies at once and leaves the menu open, so the ✓ shows what it did.
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: wraps }}
            onPress={() => actions.onWrap(!wraps)}
            style={styles.item}
            testID="sheet-wrap-text"
          >
            <View style={styles.toggleRow}>
              <Text variant="tree" style={styles.itemText}>
                Wrap text
              </Text>
              {wraps ? <Text variant="tree" style={styles.check}>✓</Text> : null}
            </View>
          </Pressable>
        )}
        {readOnly || !phone ? null : (
          <View style={styles.group}>
            {!canWrap(column.type) ? null : (
              <View style={[styles.groupRow, styles.groupRule]}>
                <Text variant="body" style={styles.itemText}>
                  Wrap text
                </Text>
                <Switch value={wraps} onValueChange={actions.onWrap} label="Wrap text" testID="sheet-wrap-text" style={{ marginLeft: "auto", alignSelf: "center" }} />
              </View>
            )}
            <View style={styles.groupRow}>
              <Text variant="body" style={styles.itemText}>
                Width
              </Text>
              <Text variant="body" style={styles.widthValue} testID="sheet-width-value">
                {width}
              </Text>
              <View style={styles.stepper}>
                <Step label="−" name="Narrower" onPress={() => actions.onWidth(width - WIDTH_STEP)} />
                <Step label="Fit" name="Fit to its values" onPress={() => actions.onWidth("fit")} />
                <Step label="+" name="Wider" onPress={() => actions.onWidth(width + WIDTH_STEP)} />
              </View>
            </View>
          </View>
        )}
        <Item label="Sort ascending" onPress={() => run(() => actions.onSort("asc"))} />
        <Item label="Sort descending" onPress={() => run(() => actions.onSort("desc"))} />
        {readOnly ? null : (
          <>
            <Item label="Insert column left" onPress={() => run(() => actions.onInsert("left"))} />
            <Item label="Insert column right" onPress={() => run(() => actions.onInsert("right"))} />
          </>
        )}
        <Item label="Hide column" onPress={() => run(actions.onHide)} />
        {readOnly ? null : (
          // Deleting drops every value in the column, so it takes a second press.
          <Item
            label={confirmDelete ? `Delete “${column.name}” and its values` : "Delete column"}
            danger
            onPress={() => (confirmDelete ? run(actions.onDelete) : setConfirmDelete(true))}
          />
        )}
      </View>
    </Popover>
  );
}

function Step({ label, name, onPress }: { label: string; name: string; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onPress} style={styles.step} testID="sheet-width-step">
      <Text variant="body" style={styles.itemText}>
        {label}
      </Text>
    </Pressable>
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
      fontSize: pointerType.ui,
    } as object,
    types: { flexDirection: "row", flexWrap: "wrap" },
    type: {
      width: "50%",
      height: 28,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      // 6, not 8: "Single select" only just fits half of the 240-wide menu.
      paddingHorizontal: 6,
      borderRadius: radii.sm,
    },
    glyph: { color: colors.chromeMuted, width: 16, textAlign: "center" },
    typeLabel: { color: colors.text, flexShrink: 1 },
    // Out of the row's flow, in its right padding, so "Multi-select ✓" fits half the menu on one line.
    check: { position: "absolute", right: 1, color: colors.accentText },
    rule: { height: 1, backgroundColor: colors.line, marginVertical: space.x1 },
    item: { height: 30, justifyContent: "center", paddingHorizontal: space.x2, borderRadius: radii.sm },
    itemText: { color: colors.text },
    toggleRow: { flexDirection: "row", alignItems: "center" },
    group: { borderRadius: 14, backgroundColor: colors.ground, borderWidth: 1, borderColor: colors.line, marginVertical: space.x1, overflow: "hidden" },
    groupRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.x2, paddingHorizontal: space.x4 },
    groupRule: { borderBottomWidth: 1, borderColor: colors.line },
    widthValue: { color: colors.muted, fontVariant: ["tabular-nums"] },
    stepper: { marginLeft: "auto", flexDirection: "row", gap: space.x2 },
    step: { minWidth: 44, height: 34, paddingHorizontal: space.x3, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface3 },
    danger: { color: colors.crit },
  });
