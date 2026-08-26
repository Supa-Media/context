import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { colors, radii } from "../tokens";
import { AutoGrid } from "./AutoGrid";
import { Text } from "./Text";

/** `.field` — an uppercase label over a read-only monospaced value in a well. */
export interface FieldSpec {
  label: string;
  value: string;
}

export function Field({ label, value }: FieldSpec) {
  return (
    <View style={styles.field}>
      <Text variant="eyebrow" style={styles.label}>
        {label}
      </Text>
      <View style={styles.well}>
        <Text variant="mono" numberOfLines={1} selectable>
          {value}
        </Text>
      </View>
    </View>
  );
}

/** `.grid2` — `repeat(auto-fit, minmax(238px, 1fr))`, gap 11. */
export function FieldGrid({ fields }: { fields: ReadonlyArray<FieldSpec> }) {
  return (
    <AutoGrid
      items={fields}
      minItemWidth={238}
      gap={11}
      keyExtractor={(field) => field.label}
      renderItem={(field) => <Field label={field.label} value={field.value} />}
    />
  );
}

/** `.check` — one line of the storage capability report. */
export function Check({ tone, children }: { tone: "ok" | "warn"; children: ReactNode }) {
  return (
    <View style={styles.check}>
      <Text
        variant="check"
        style={tone === "ok" ? styles.checkOk : styles.checkWarn}
        aria-hidden
      >
        {tone === "ok" ? "✓" : "!"}
      </Text>
      <Text variant="check" style={styles.checkBody}>
        {children}
      </Text>
    </View>
  );
}

/** `.hint` — the blue explanatory panel. */
export function Hint({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.hint, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  field: {
    minWidth: 0,
  },
  label: {
    marginBottom: 6,
  },
  well: {
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
  },
  check: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 9,
  },
  checkOk: { color: colors.ok, fontWeight: "700" },
  checkWarn: { color: colors.warn, fontWeight: "700" },
  checkBody: { flex: 1, minWidth: 0 },
  hint: {
    marginTop: 15,
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    backgroundColor: colors.hintWash,
    borderWidth: 1,
    borderColor: colors.hintBorder,
  },
});
