/**
 * The Tex tab's one control: a compact button that opens a menu (the owner,
 * 2026-10-24: "the filter rows are more compact, drop downs not never ending
 * bubbles"). One button per filter or setting, whatever the number of values
 * behind it.
 *
 * `multi` makes every row a tick that toggles, with "All" on top to clear;
 * otherwise picking a row sets it. The menu is the app's own (`Menu`), so a
 * phone gets the bottom sheet and a pointer gets a popover.
 */

import { useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { Menu } from "../design/components/Menu";
import type { MenuItem } from "../console/files/menuItem";

export interface PickerOption {
  value: string;
  label: string;
  /** Shown muted on the right, e.g. how many conversations carry it. */
  count?: number;
}

const ALL = "__all__";

export function TexPicker({
  label,
  title,
  options,
  picked,
  multi = false,
  onPick,
  active = false,
  testID,
}: {
  /** What the button says. */
  label: string;
  /** The menu's heading on a phone. */
  title: string;
  options: readonly PickerOption[];
  picked: readonly string[];
  multi?: boolean;
  /** Single: the value picked. Multi: the value toggled, or null for "All". */
  onPick: (value: string | null) => void;
  /** Drawn as set, so a filter in force stands out from the rest. */
  active?: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const button = useRef<View>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const open = () => {
    button.current?.measureInWindow((x, y, _width, height) => setMenu({ x, y: y + height + 4 }));
    setMenu((was) => was ?? { x: 0, y: 0 });
  };
  const items: MenuItem<string>[] = [
    ...(multi ? [{ id: ALL, label: "All", checked: picked.length === 0 }] : []),
    ...options.map((option, index) => ({
      id: option.value,
      label: option.label,
      value: option.count === undefined ? undefined : String(option.count),
      checked: picked.includes(option.value),
      separatorBefore: multi && index === 0,
    })),
  ];
  return (
    <View>
      <Pressable
        ref={button}
        role="button"
        accessibilityLabel={`${label}. Change`}
        onPress={open}
        style={[styles.button, active && styles.buttonOn]}
        testID={testID}
      >
        <Text variant="meta" numberOfLines={1} style={[styles.label, active && styles.labelOn]}>
          {label}
        </Text>
        <Text variant="meta" style={styles.caret} aria-hidden>
          ▾
        </Text>
      </Pressable>
      {menu !== null ? (
        <Menu<string>
          items={items}
          anchor={menu}
          title={title}
          onSelect={(id) => onPick(id === ALL ? null : id)}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    button: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 8,
      paddingHorizontal: space.x3,
      paddingVertical: 6,
      maxWidth: 240,
    },
    buttonOn: { borderColor: colors.accent },
    label: { flexShrink: 1, color: colors.text2 },
    labelOn: { color: colors.text },
    caret: { color: colors.muted },
  });
