import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { layout, radii, space } from "../tokens";
import { useThemedStyles, type Colors } from "../theme";
import { Text } from "./Text";

/** `.field` — an uppercase label over a read-only monospaced value in a well. */
export interface FieldSpec {
  label: string;
  value: string;
}

export function Field({ label, value }: FieldSpec) {
  const styles = useThemedStyles(makeStyles);
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

/**
 * A binding, read as a list: label, value, a rule between them.
 *
 * This replaced `FieldGrid`, which drew the same facts as labelled *wells* in
 * a two-up grid — a box with a mono value in it, which is the shape this app
 * draws a text input in. Nothing in a binding is editable, and four
 * input-shaped boxes above a "Rotate key" button invite somebody to type in
 * one. A list says these are facts; a form says these are fields.
 *
 * The value keeps `mono` and keeps `selectable`: an endpoint and an access key
 * are on this screen to be copied out of it.
 *
 * `testIDPrefix` is what lets a caller address one row — the storage pane
 * asserts that a backend without a bucket has no bucket row, which needs the
 * rows to be nameable rather than counted.
 */
export function FieldList({
  fields,
  testID,
  testIDPrefix,
}: {
  fields: ReadonlyArray<FieldSpec>;
  testID?: string;
  /** e.g. `storage-field` → `storage-field-access-key`, from the label. */
  testIDPrefix?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View testID={testID}>
      {fields.map((field, index) => {
        const id =
          testIDPrefix === undefined
            ? undefined
            : `${testIDPrefix}-${field.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        return (
          <View
            key={field.label}
            style={[styles.listRow, index === 0 ? null : styles.listRuled]}
            testID={id}
          >
            <Text variant="rowSub" style={styles.listLabel} numberOfLines={1}>
              {field.label}
            </Text>
            <Text
              variant="mono"
              style={styles.listValue}
              numberOfLines={1}
              selectable
              testID={id === undefined ? undefined : `${id}-value`}
            >
              {field.value}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** `.check` — one line of the storage capability report. */
export function Check({ tone, children }: { tone: "ok" | "warn"; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
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
  const styles = useThemedStyles(makeStyles);
  return <View style={[styles.hint, style]}>{children}</View>;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
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
  /*
    A row on the 4pt ladder: 12 of padding around a 20pt line is 44, which is
    a touch target on a phone and an unhurried row under a pointer. The label
    column is fixed so the values line up — a binding read down its values is
    how somebody checks one against their provider's console.
  */
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x4,
    paddingVertical: space.x3,
    minHeight: layout.minTouchTarget,
  },
  /* The one hairline this pane spends, and only between rows. */
  listRuled: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  listLabel: { width: 132, flexShrink: 0, color: colors.muted },
  listValue: { flex: 1, minWidth: 0 },
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
