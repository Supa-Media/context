import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../../design/theme";

export interface PickOption<K extends string> {
  key: K;
  label: string;
  /** Drawn red, for the one option that removes something. */
  danger?: boolean;
}

/**
 * "Anyone ▾", "Can edit ▾": a quiet dropdown that opens a short list under
 * itself. The settings artboard draws both the Activity page's person filter
 * and a member's role this way, so they share one control.
 *
 * The list opens in place, under the trigger and over what follows, and
 * closes on a pick or a second press of the trigger.
 */
export function PickMenu<K extends string>({
  label,
  options,
  selected,
  onPick,
  accessibilityLabel,
  disabled = false,
  testID,
}: {
  label: string;
  options: readonly PickOption<K>[];
  selected?: K | null;
  onPick: (key: K) => void;
  accessibilityLabel: string;
  disabled?: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.wrap, open ? styles.wrapOpen : null]}>
      <Pressable
        role="button"
        accessibilityLabel={accessibilityLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onPress={() => setOpen((was) => !was)}
        style={[styles.trigger, open ? styles.triggerOpen : null, disabled ? styles.disabled : null]}
        testID={testID}
      >
        <Text variant="rowSub" style={styles.label}>
          {label}
        </Text>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={12} color={colors.muted} />
      </Pressable>
      {open ? (
        <View style={styles.menu} role="menu" testID={`${testID}-menu`}>
          {options.map((option) => {
            const on = option.key === selected;
            return (
              <Pressable
                key={option.key}
                role="menuitem"
                aria-checked={on}
                onPress={() => {
                  setOpen(false);
                  onPick(option.key);
                }}
                style={styles.row}
                testID={`${testID}-option-${option.key}`}
              >
                <Text
                  variant="rowSub"
                  numberOfLines={1}
                  style={[styles.rowText, option.danger ? styles.danger : null]}
                >
                  {option.label}
                </Text>
                {on ? <Icon name="check" size={13} color={colors.accent} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    wrap: { position: "relative", alignSelf: "flex-start" },
    // Above the rows that follow, so the open list is not drawn under them.
    wrapOpen: { zIndex: 20 },
    trigger: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    triggerOpen: { borderColor: colors.accent },
    disabled: { opacity: 0.5 },
    label: { color: colors.text },
    menu: {
      position: "absolute",
      top: "100%",
      right: 0,
      marginTop: 4,
      minWidth: 170,
      paddingVertical: 4,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      boxShadow: shadows.floating,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    rowText: { color: colors.text, flexShrink: 1 },
    danger: { color: colors.crit },
  });
