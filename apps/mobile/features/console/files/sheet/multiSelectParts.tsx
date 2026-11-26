/**
 * The pieces both multi-select pickers draw: an option's chip, tinted as the
 * grid tints it, and the editor's props. Its own file because a `.web` module
 * importing `./MultiSelectPanel` imports itself.
 */

import type { RefObject } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { optionTone } from "./CellDisplay";

export interface MultiSelectEditorProps {
  label: string;
  /** What the cell holds now, joined with ", ". */
  draft: string;
  /** The column's options, first seen first, which also pick each chip's tint. */
  options: readonly string[];
  /** The cell the panel opens over. */
  anchor: RefObject<View | null>;
  /** What the field starts with: a character typed on the selected cell. */
  initialTyped?: string;
  onDraft: (value: string) => void;
  /** Save and close: "enter" also moves down, "tab"/"backtab" across, "save" stays, "blur" only saves. */
  onFinish: (how: "enter" | "tab" | "backtab" | "save" | "blur") => void;
}

export function OptionChip({ word, options, size = 13, children }: { word: string; options: readonly string[]; size?: number; children?: React.ReactNode }) {
  const styles = useThemedStyles(makeChipStyles);
  const colors = useColors();
  const at = options.findIndex((o) => o.toLowerCase() === word.toLowerCase());
  const tone = optionTone(colors, at < 0 ? options.length : at);
  return (
    <View style={[styles.chip, { backgroundColor: tone.wash }]}>
      <View style={[styles.dot, { backgroundColor: tone.dot }]} />
      <Text variant="body" numberOfLines={1} style={[styles.word, { fontSize: size, lineHeight: Math.round(size * 1.4) }]}>
        {word}
      </Text>
      {children}
    </View>
  );
}

const makeChipStyles = (colors: Colors) =>
  StyleSheet.create({
    chip: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      height: 22,
      paddingHorizontal: space.x2,
      borderRadius: radii.sm,
      maxWidth: "100%",
    },
    dot: { width: 7, height: 7, borderRadius: 2 },
    word: { color: colors.text, flexShrink: 1 },
  });
