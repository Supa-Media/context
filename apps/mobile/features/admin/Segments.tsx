/**
 * The console header's segmented track, a size down: a row of chips, one on.
 *
 * Used for the Waitlist tab's lists, the "Invited by friends" sub-filters and
 * the community link form's choices, so they are one shape rather than three.
 * It wraps on a phone rather than scrolling sideways.
 */

import { Pressable, StyleSheet, View } from "react-native";
import { Text, leading, radii, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { useCompact } from "./AdminKit";

export function Segments<K extends string>({
  options,
  value,
  onChange,
  counts,
  role = "tablist",
  label,
  testID,
}: {
  options: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  /** A number after each label; `null` or missing draws none. */
  counts?: (key: K) => number | null;
  /** `tablist` for switching views, `radiogroup` for a form's choice. */
  role?: "tablist" | "radiogroup";
  label?: string;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const itemRole = role === "tablist" ? "tab" : "radio";
  return (
    <View style={styles.track} role={role} aria-label={label}>
      {options.map((option) => {
        const on = option.key === value;
        const count = counts?.(option.key) ?? null;
        return (
          <Pressable
            key={option.key}
            role={itemRole}
            aria-selected={itemRole === "tab" ? on : undefined}
            aria-checked={itemRole === "radio" ? on : undefined}
            onPress={() => onChange(option.key)}
            style={[styles.chip, compact && styles.chipCompact, on && styles.chipOn]}
            testID={`${testID}-${option.key}`}
          >
            <Text style={[styles.label, compact && styles.labelCompact, on && styles.labelOn]}>
              {option.label}
              {count === null ? "" : ` ${count}`}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    track: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignSelf: "flex-start",
      gap: 2,
      padding: 2,
      borderRadius: radii.lg,
      backgroundColor: colors.chipFill,
    },
    chip: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: 5 },
    chipCompact: { paddingVertical: 5, paddingHorizontal: 14 },
    chipOn: {
      backgroundColor: colors.surface,
      boxShadow: `0 0 0 1px ${colors.line}, 0 1px 2px rgba(0,0,0,.06)`,
    },
    label: {
      fontSize: pointerType.meta,
      lineHeight: leading(pointerType.meta, 1.55),
      fontWeight: "500",
      color: colors.muted,
      fontVariant: ["tabular-nums"],
    },
    labelCompact: { fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.55) },
    labelOn: { color: colors.text },
  });
