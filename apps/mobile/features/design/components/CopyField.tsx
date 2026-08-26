import { StyleSheet, View, type ViewStyle } from "react-native";
import { colors, radii } from "../tokens";
import { useCopy } from "../useCopy";
import { Button } from "./Button";
import { Text } from "./Text";

/**
 * `.copyfield` — a monospaced value in a well, with an optional copy button
 * that flips to "Copied" for a moment. The state machine behind the label is
 * `copyController.ts`.
 */
export function CopyField({
  value,
  copyable = true,
  label,
  style,
  testID,
}: {
  value: string;
  copyable?: boolean;
  /** Announced on the copy button, e.g. "Copy your MCP endpoint". */
  label?: string;
  style?: ViewStyle;
  testID?: string;
}) {
  const { label: buttonLabel, copy } = useCopy(value);

  return (
    <View style={[styles.field, style]} testID={testID}>
      <Text variant="mono" numberOfLines={1} style={styles.value} selectable>
        {value}
      </Text>
      {copyable ? (
        <Button
          label={buttonLabel}
          accessibilityLabel={label ?? `Copy ${value}`}
          onPress={copy}
          variant="mini"
          testID={testID ? `${testID}-copy` : undefined}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingRight: 10,
    paddingLeft: 15,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.xl,
    backgroundColor: colors.well,
  },
  value: {
    flex: 1,
    minWidth: 0,
  },
});
