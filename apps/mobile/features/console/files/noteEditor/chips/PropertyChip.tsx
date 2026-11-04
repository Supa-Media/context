import { useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { SketchMark } from "../../../../design/components/sketch/SketchMark";
import type { SketchLook } from "../../../../design/components/sketch/sketchGeometry";
import { Text } from "../../../../design/components/Text";
import { fonts, pointerType } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";

/**
 * How a property chip is drawn. The owner picked the highlighter on
 * 2026-11-04 ("lets go with c"), keeping the pencil loop and masking tape as
 * alternatives "we may end up mix matching between the app": each is a value
 * here, and a surface chooses one.
 *
 * - `marker`: no box. A status is swiped with a marker in its group's colour;
 *   any other value is underlined in pencil; an unset one is muted words that
 *   get their underline under the pointer.
 * - `loop`: a loose pencil loop round each value, the status dot in front;
 *   an unset one is a dashed loop.
 * - `tape`: each value on a strip of paper tape; an unset one gets its strip
 *   under the pointer.
 *
 * The words stay in the app's own type in every look: only the marks are drawn
 * (the Live map's rule, 2026-10-11).
 */
export type ChipStyle = "marker" | "loop" | "tape";

/** The look the note's property chips use. */
export const PROPERTY_CHIP_STYLE: ChipStyle = "marker";

export type Anchor = { x: number; y: number };

/** Which drawn mark a chip gets, and how strongly, for its state. */
export function chipMark(
  style: ChipStyle,
  chip: { set: boolean; status: boolean; hovered: boolean },
): { look: SketchLook; strength: number } | null {
  const { set, status, hovered } = chip;
  switch (style) {
    case "marker":
      if (set && status) return { look: "marker", strength: hovered ? 1.25 : 1 };
      if (set) return { look: "underline", strength: hovered ? 1.2 : 0.75 };
      return hovered ? { look: "underline", strength: 0.9 } : null;
    case "loop":
      if (set) return { look: "loop", strength: hovered ? 1.15 : 1 };
      return hovered ? { look: "loop", strength: 0.8 } : { look: "dashedLoop", strength: 1 };
    case "tape":
      if (set) return { look: "tape", strength: hovered ? 1.35 : 1 };
      return hovered ? { look: "tape", strength: 0.7 } : null;
  }
}

/**
 * One chip under a note's name: its lead glyph, its words, and the drawn mark
 * behind them. `markColor` is the status group's colour for a status, else
 * the pencil.
 */
export function PropertyChip({
  style,
  label,
  lead,
  set = false,
  status = false,
  markColor,
  hidden = false,
  accessibilityLabel,
  onPress,
  testID,
}: {
  style: ChipStyle;
  label: string;
  lead: ReactNode;
  set?: boolean;
  status?: boolean;
  markColor: string;
  hidden?: boolean;
  accessibilityLabel: string;
  /** Undefined for a value somebody may only read. */
  onPress?: (anchor: Anchor | undefined) => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const node = useRef<View>(null);
  const [hovered, setHovered] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (size === null || size.width !== width || size.height !== height) setSize({ width, height });
  };
  const mark = chipMark(style, { set, status, hovered: hovered && onPress !== undefined });
  const look = [styles.chip, style === "marker" ? styles.chipMarker : null, hidden && styles.hidden];
  const content = (
    <>
      {mark !== null && size !== null ? (
        <SketchMark
          look={mark.look}
          width={size.width}
          height={size.height}
          color={set ? markColor : colors.chromeMuted}
          seed={`${testID}:${label}`}
          strength={mark.strength}
          testID={`${testID}-mark-${mark.look}`}
        />
      ) : null}
      {lead}
      <Text numberOfLines={1} style={[styles.label, set ? styles.setText : styles.unsetText, hovered && !set && styles.unsetTextHover]}>
        {isolateForDisplay(label)}
      </Text>
    </>
  );
  if (onPress === undefined) {
    return (
      <View style={look} onLayout={onLayout} accessibilityLabel={accessibilityLabel} testID={testID}>
        {content}
      </View>
    );
  }
  return (
    <View ref={node} collapsable={false}>
      <Pressable
        onPress={() => {
          const measure = node.current?.measureInWindow;
          if (measure === undefined) onPress(undefined);
          else node.current!.measureInWindow((x, y, _width, height) => onPress({ x, y: y + height + 4 }));
        }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onLayout={onLayout}
        role="button"
        aria-haspopup="menu"
        accessibilityLabel={accessibilityLabel}
        // Out of the tab order and the pointer's way while it is not shown.
        disabled={hidden}
        style={look}
        testID={testID}
      >
        {content}
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    chip: {
      position: "relative",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      height: 26,
      maxWidth: 280,
      paddingHorizontal: 10,
      cursor: "pointer" as never,
    },
    // No outline to clear, so the words sit nearer one another.
    chipMarker: { paddingHorizontal: 6 },
    hidden: { opacity: 0 },
    label: { fontFamily: fonts.body, fontSize: pointerType.ui, lineHeight: 18, flexShrink: 1 },
    setText: { color: colors.text, fontWeight: "500" },
    unsetText: { color: colors.chromeMuted },
    unsetTextHover: { color: colors.text },
  });
