/**
 * A row's menu, opened from its number in the gutter (a press on a pointer, a
 * long-press on a phone, where `Popover` draws it as a bottom sheet): insert a
 * row above or below, or delete this one. Deleting drops every value in the
 * row, so it takes a second press, as deleting a column does; while it waits,
 * the row is drawn in red so it is plain what will go.
 */

import { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { Popover, type Anchor } from "./Popover";

export function RowMenu({
  number,
  label,
  anchor,
  onInsert,
  onDelete,
  onArm,
  onClose,
}: {
  /** The row's number as the gutter shows it. */
  number: number;
  /** The row's first value, to say which row this is. */
  label: string;
  anchor: Anchor | null;
  onInsert: (side: "above" | "below") => void;
  onDelete: () => void;
  /** The first press on Delete: the grid draws the row as about to go. */
  onArm: () => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [armed, setArmed] = useState(false);
  const run = (fn: () => void) => {
    fn();
    onClose();
  };
  const mac = Platform.OS === "web" && typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
  return (
    <Popover anchor={anchor} width={216} onDismiss={onClose} testID="sheet-row-menu">
      <View style={styles.body}>
        <View style={styles.head}>
          <Text variant="meta" style={styles.headNumber}>
            {`Row ${number}`}
          </Text>
          {label === "" ? null : (
            <Text variant="meta" numberOfLines={1} style={styles.headLabel}>
              {label}
            </Text>
          )}
        </View>
        <Item label="Insert row above" onPress={() => run(() => onInsert("above"))} />
        <Item label="Insert row below" onPress={() => run(() => onInsert("below"))} />
        <View style={styles.rule} />
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (armed) run(onDelete);
            else {
              setArmed(true);
              onArm();
            }
          }}
          style={styles.item}
          testID="sheet-row-delete"
        >
          <Text variant="tree" style={styles.danger}>
            {armed ? `Delete row ${number} and its values` : "Delete row"}
          </Text>
          {armed || Platform.OS !== "web" ? null : (
            <Text variant="meta" style={styles.keys}>
              {mac ? "⌘⌫" : "Ctrl+⌫"}
            </Text>
          )}
        </Pressable>
      </View>
    </Popover>
  );
}

function Item({ label, onPress }: { label: string; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.item}>
      <Text variant="tree" style={styles.itemText}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: { padding: 4 },
    head: { flexDirection: "row", alignItems: "baseline", gap: space.x1, paddingHorizontal: space.x2, paddingVertical: space.x1 },
    headNumber: { color: colors.text2, fontWeight: "600" },
    headLabel: { color: colors.muted, flexShrink: 1 },
    rule: { height: 1, backgroundColor: colors.line, marginVertical: 4 },
    item: { height: 30, flexDirection: "row", alignItems: "center", paddingHorizontal: space.x2, borderRadius: radii.sm },
    itemText: { color: colors.text },
    danger: { color: colors.crit, flex: 1 },
    keys: { color: colors.muted },
  });
