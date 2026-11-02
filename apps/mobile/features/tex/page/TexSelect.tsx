import { useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
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
 * opens under it and closes on a pick, a second press or a tap anywhere else.
 *
 * The list is drawn in a layer of its own over the whole page, placed under
 * the control from where it sits on screen. On the web every view is its own
 * stacking layer, so a list drawn inside the control was painted under the
 * tiles and slots that follow it, whatever its zIndex (2026-11-02).
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
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const at = useRef<View>(null);
  const screen = useWindowDimensions();
  const toggle = () => {
    if (open) return setOpen(false);
    const node = at.current;
    if (node && typeof node.measureInWindow === "function") node.measureInWindow((x, y, w, h) => setAnchor({ x, y, w, h }));
    setOpen(true);
  };
  const current = options.find((o) => o.key === selected)?.label ?? selected;
  return (
    <View ref={at} style={styles.wrap}>
      <Pressable
        role="button"
        accessibilityLabel={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onPress={toggle}
        style={[styles.trigger, look === "pick" ? styles.pick : styles.sel]}
        testID={testID}
      >
        <T size={13} weight="500" tone={look === "pick" ? "text2" : "text"} numberOfLines={1} line={1.35} style={{ flexShrink: 1 }}>
          {current}
        </T>
        <Icon name="chevronDown" size={11} color={colors.muted} />
      </Pressable>
      <Modal transparent visible={open} animationType="none" onRequestClose={() => setOpen(false)}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} accessibilityLabel="Close" testID={`${testID}-away`} />
        <View
          style={[styles.menu, anchor ? place(anchor, options.length, screen) : null]}
          role="menu"
          testID={`${testID}-menu`}
        >
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
      </Modal>
    </View>
  );
}

/** Under the control, its right edges lined up; above it when the list would run off the bottom of the screen. */
function place(a: { x: number; y: number; w: number; h: number }, rows: number, screen: { width: number; height: number }) {
  const right = Math.max(8, screen.width - a.x - a.w);
  const tall = rows * ROW_HEIGHT + 10;
  const below = a.y + a.h + 4;
  return below + tall > screen.height && a.y - 4 - tall > 0 ? { right, top: a.y - 4 - tall } : { right, top: below };
}

/** One row's height: 13 px text at its line height, padded 8 above and below. */
const ROW_HEIGHT = 34;

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    wrap: { position: "relative", alignSelf: "flex-start" },
    trigger: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 8, borderWidth: 1, paddingVertical: 5, paddingHorizontal: 8 },
    sel: { backgroundColor: colors.surface2, borderColor: colors.lineStrong },
    pick: { backgroundColor: "transparent", borderColor: colors.lineStrong, maxWidth: 108 },
    menu: {
      position: "absolute",
      top: 0,
      right: 8,
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
