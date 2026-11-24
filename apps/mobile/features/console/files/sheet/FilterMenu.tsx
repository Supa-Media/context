/**
 * The "+ Filter" menu, in two steps: which column, then how it is compared
 * and to what. A select or person offers the values the column already has;
 * a checkbox filters on ticked or not in one press, and so do "is empty" and
 * "is not empty", which compare with nothing; anything else takes a typed
 * value, which Enter or "Add filter" adds. The filter is session state and is
 * never written to the file.
 *
 * Pressing a filter's chip opens the same menu at step two, filled in with that
 * filter, to change it ("Update filter") or take it off ("Remove filter").
 */

import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { Popover, type Anchor } from "./Popover";
import {
  distinctValues,
  filterOpsFor,
  opTakesValue,
  TYPE_GLYPH,
  type FilterOp,
  type SheetColumn,
  type SheetData,
  type SheetFilter,
} from "./sheetModel";
import { useFieldFont } from "../../../design/fieldFont";

export function FilterMenu({
  sheet,
  anchor,
  editing,
  onAdd,
  onRemove,
  onClose,
}: {
  sheet: SheetData;
  anchor: Anchor | null;
  /** The filter whose chip was pressed: the menu opens on it, and a choice replaces it. */
  editing?: SheetFilter;
  /** Add the filter, or put it in place of `editing`. */
  onAdd: (filter: SheetFilter) => void;
  /** Take `editing` off. */
  onRemove?: () => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(pointerType.ui);
  const colors = useColors();
  const [column, setColumn] = useState<SheetColumn | null>(
    () => (editing ? (sheet.columns.find((c) => c.name === editing.column) ?? null) : null),
  );
  const [op, setOp] = useState<FilterOp | null>(editing?.op ?? null);
  const [value, setValue] = useState(editing?.value ?? "");
  const verb = editing ? "Update filter" : "Add filter";

  const add = (filter: SheetFilter) => {
    onAdd(filter);
    onClose();
  };
  const back = () => {
    setColumn(null);
    setOp(null);
    setValue("");
  };

  let body;
  if (column === null) {
    body = (
      <>
        <Text variant="meta" style={styles.heading}>
          Filter by
        </Text>
        {sheet.columns.map((c) => (
          <Pressable
            key={c.name}
            accessibilityRole="button"
            onPress={() => {
              setColumn(c);
              setOp(filterOpsFor(c.type)[0]);
            }}
            style={styles.row}
          >
            <Text variant="mono" style={styles.glyph}>
              {TYPE_GLYPH[c.type]}
            </Text>
            <Text variant="tree" style={styles.text}>
              {c.name}
            </Text>
          </Pressable>
        ))}
      </>
    );
  } else {
    const current = column;
    const ops = filterOpsFor(current.type);
    const choose = (next: FilterOp) => setOp(next);
    const chosen = op ?? ops[0];
    body = (
      <>
        <View style={styles.step}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back to columns" onPress={back} style={styles.back}>
            <Text variant="tree" style={styles.muted}>
              ‹
            </Text>
          </Pressable>
          <Text variant="tree" style={styles.title}>
            {current.name}
          </Text>
        </View>
        <View style={styles.ops}>
          {ops.map((o) => (
            <Pressable
              key={o}
              accessibilityRole="button"
              accessibilityState={{ selected: o === chosen }}
              onPress={() => {
                choose(o);
                // Nothing to type: a checkbox's two operators, and "is empty" or "is not empty", are the whole filter.
                if (!opTakesValue(o)) add({ column: current.name, op: o, value: "" });
              }}
              style={[styles.op, o === chosen && { backgroundColor: colors.accentDim }]}
              testID="sheet-filter-op"
            >
              <Text variant="meta" style={o === chosen ? styles.accent : styles.text}>
                {o}
              </Text>
            </Pressable>
          ))}
        </View>
        {!opTakesValue(chosen) ? null : current.type === "select" || current.type === "person" ? (
          <View>
            {distinctValues(sheet, current.name).map((v) => {
              const on = editing !== undefined && v === value;
              return (
                <Pressable
                  key={v}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => add({ column: current.name, op: chosen, value: v })}
                  style={[styles.row, on && { backgroundColor: colors.accentDim }]}
                >
                  <Text variant="tree" style={on ? styles.accent : styles.text}>
                    {v}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <View style={styles.typed}>
            <TextInput
              autoFocus
              value={value}
              onChangeText={setValue}
              onSubmitEditing={() => {
                if (value.trim() !== "") add({ column: current.name, op: chosen, value: value.trim() });
              }}
              placeholder={current.type === "date" ? "YYYY-MM-DD" : "Value, then Enter"}
              placeholderTextColor={colors.chromeMuted}
              accessibilityLabel="Filter value"
              style={[styles.field, fieldFont, { outlineColor: colors.accent } as object]}
              testID="sheet-filter-value"
            />
          </View>
        )}
        {editing === undefined && (!opTakesValue(chosen) || current.type === "select" || current.type === "person") ? null : (
          <View style={styles.foot}>
            {editing === undefined ? null : (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  onRemove?.();
                  onClose();
                }}
                style={styles.add}
                testID="sheet-filter-remove"
              >
                <Text variant="meta" style={styles.muted}>
                  Remove filter
                </Text>
              </Pressable>
            )}
            {!opTakesValue(chosen) || current.type === "select" || current.type === "person" ? null : (
              <Pressable
                accessibilityRole="button"
                disabled={value.trim() === ""}
                onPress={() => add({ column: current.name, op: chosen, value: value.trim() })}
                style={[styles.add, styles.submit]}
                testID="sheet-filter-submit"
              >
                <Text variant="meta" style={[styles.accent, styles.strong]}>
                  {verb}
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </>
    );
  }

  return (
    <Popover anchor={anchor} width={240} maxHeight={380} onDismiss={onClose} testID="sheet-filter-menu">
      <View style={styles.body}>{body}</View>
    </Popover>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: { padding: space.x1, gap: 2 },
    heading: { color: colors.chromeMuted, paddingHorizontal: space.x2, paddingVertical: space.x1 },
    row: { height: 30, flexDirection: "row", alignItems: "center", gap: space.x2, paddingHorizontal: space.x2, borderRadius: radii.sm },
    glyph: { color: colors.chromeMuted, width: 18, textAlign: "center" },
    text: { color: colors.text, flexShrink: 1 },
    muted: { color: colors.text2 },
    accent: { color: colors.accentText },
    title: { color: colors.text, fontWeight: "600" },
    step: { flexDirection: "row", alignItems: "center", gap: space.x1, marginBottom: space.x1 },
    back: { width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: radii.sm },
    ops: { flexDirection: "row", flexWrap: "wrap", gap: 4, paddingVertical: space.x1 },
    op: { height: 26, justifyContent: "center", paddingHorizontal: space.x2, borderRadius: radii.sm, backgroundColor: colors.chipFill },
    typed: { gap: space.x1, paddingTop: space.x1 },
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
    add: { height: 28, justifyContent: "center", paddingHorizontal: space.x2 },
    foot: { flexDirection: "row", alignItems: "center", paddingTop: space.x1 },
    submit: { marginLeft: "auto" },
    strong: { fontWeight: "600" },
  });
