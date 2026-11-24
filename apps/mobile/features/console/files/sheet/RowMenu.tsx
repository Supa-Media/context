/**
 * A row's menu, opened from its number in the gutter (a press on a pointer, a
 * long-press on a phone, where `Popover` draws it as a bottom sheet): insert a
 * row above or below, or delete this one. Deleting drops every value in the
 * row, so it takes a second press, as deleting a column does; while it waits,
 * the row is drawn in red so it is plain what will go.
 */

import { useState } from "react";
import { Platform, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType, radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { Popover, type Anchor } from "./Popover";
import { densityFor } from "../../../app/frame";
import { isApplePlatform } from "../../../design/applePlatform";

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
  // A phone's bottom sheet: grouped rows a thumb can hit, with Delete in a group of its own.
  const windowWidth = useWindowDimensions().width;
  const phone = anchor === null || densityFor(windowWidth) === "compact";
  const run = (fn: () => void) => {
    fn();
    onClose();
  };
  const mac = isApplePlatform();
  const deleteLabel = armed ? `Delete row ${number} and its values` : "Delete row";
  const pressDelete = () => {
    if (armed) run(onDelete);
    else {
      setArmed(true);
      onArm();
    }
  };
  if (phone) {
    return (
      <Popover anchor={anchor} width={216} onDismiss={onClose} testID="sheet-row-menu">
        <View style={styles.phoneBody}>
          <View style={styles.phoneHead}>
            <Text variant="body" style={styles.phoneTitle}>
              {`Row ${number}`}
            </Text>
            {label === "" ? null : (
              <Text variant="meta" numberOfLines={1} style={styles.headLabel}>
                {label}
              </Text>
            )}
          </View>
          <View style={styles.group}>
            <PhoneItem label="Insert row above" onPress={() => run(() => onInsert("above"))} />
            <View style={styles.groupRule} />
            <PhoneItem label="Insert row below" onPress={() => run(() => onInsert("below"))} />
          </View>
          <View style={styles.group}>
            <PhoneItem label={deleteLabel} danger onPress={pressDelete} testID="sheet-row-delete" />
          </View>
        </View>
      </Popover>
    );
  }
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
        <Pressable accessibilityRole="button" onPress={pressDelete} style={styles.item} testID="sheet-row-delete">
          <Text variant="tree" style={styles.danger}>
            {deleteLabel}
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

function PhoneItem({ label, danger = false, onPress, testID }: { label: string; danger?: boolean; onPress: () => void; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.phoneItem} testID={testID}>
      <Text variant="body" style={[styles.phoneText, danger && styles.phoneDanger]}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: {},
    phoneBody: { gap: space.x3 },
    phoneHead: { paddingHorizontal: space.x1, gap: 2 },
    phoneTitle: { color: colors.text, fontWeight: "600" },
    group: { borderRadius: radii.control, backgroundColor: colors.surface3, overflow: "hidden" },
    groupRule: { height: 1, backgroundColor: colors.line, marginLeft: space.x3 },
    phoneItem: { height: 48, justifyContent: "center", paddingHorizontal: space.x3 },
    phoneText: { color: colors.text, fontSize: pointerType.body },
    phoneDanger: { color: colors.crit },
    head: { flexDirection: "row", alignItems: "baseline", gap: space.x1, paddingHorizontal: space.x2, paddingVertical: space.x1 },
    headNumber: { color: colors.text2, fontWeight: "600" },
    headLabel: { color: colors.muted, flexShrink: 1 },
    rule: { height: 1, backgroundColor: colors.line, marginVertical: 4 },
    item: { height: 30, flexDirection: "row", alignItems: "center", paddingHorizontal: space.x2, borderRadius: radii.sm },
    itemText: { color: colors.text },
    danger: { color: colors.crit, flex: 1 },
    keys: { color: colors.muted },
  });
