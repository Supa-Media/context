import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import { T } from "./TexPageParts";

export interface SelectOption {
  key: string;
  label: string;
}

/**
 * The mock's `<select>`, two looks: `sel` (a setting's value, filled) and
 * `pick` (the chat picker in the header, outlined and quiet). A short list
 * opens under it, over what follows, and closes on a pick or a second press.
 */
export function TexSelect({
  options,
  selected,
  onPick,
  label,
  look = "sel",
  testID,
}: {
  options: readonly SelectOption[];
  selected: string;
  onPick: (key: string) => void;
  /** What a screen reader says the control is for. */
  label: string;
  look?: "sel" | "pick";
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.key === selected)?.label ?? selected;
  return (
    <View style={[styles.wrap, open ? styles.wrapOpen : null]}>
      <Pressable
        role="button"
        accessibilityLabel={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onPress={() => setOpen((was) => !was)}
        style={[styles.trigger, look === "pick" ? styles.pick : styles.sel]}
        testID={testID}
      >
        <T size={13} weight="500" tone={look === "pick" ? "text2" : "text"} numberOfLines={1} line={1.35} style={{ flexShrink: 1 }}>
          {current}
        </T>
        <Icon name="chevronDown" size={11} color={colors.muted} />
      </Pressable>
      {open ? (
        <View style={styles.menu} role="menu" testID={`${testID}-menu`}>
          {options.map((o) => (
            <Pressable
              key={o.key}
              role="menuitem"
              aria-checked={o.key === selected}
              onPress={() => {
                setOpen(false);
                if (o.key !== selected) onPick(o.key);
              }}
              style={styles.row}
              testID={`${testID}-option-${o.key}`}
            >
              <T size={13} numberOfLines={1} style={{ flexShrink: 1 }}>
                {o.label}
              </T>
              {o.key === selected ? <Icon name="check" size={13} color={colors.accent} /> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    wrap: { position: "relative", alignSelf: "flex-start" },
    wrapOpen: { zIndex: 20 },
    trigger: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 8, borderWidth: 1, paddingVertical: 5, paddingHorizontal: 8 },
    sel: { backgroundColor: colors.surface2, borderColor: colors.lineStrong },
    pick: { backgroundColor: "transparent", borderColor: colors.lineStrong, maxWidth: 108 },
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
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingHorizontal: 12, paddingVertical: 8 },
  });
