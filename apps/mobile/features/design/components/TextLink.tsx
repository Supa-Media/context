import { StyleSheet, type StyleProp, type TextStyle } from "react-native";
import { pointerType as t } from "../tokens";
import { useThemedStyles, type Colors } from "../theme";
import { Text } from "./Text";

/**
 * A secondary action drawn as the canvas draws one: accent, semibold,
 * underlined — "What is the difference?", "Change email →", "I'll do this
 * later".
 *
 * It exists because the alternative in use was `Button variant="ghost"`, which
 * renders a bare label with no colour, no underline and no box. Beside a
 * filled primary it read as loose text floating in the row rather than as
 * something to press — the "floating Skip for now" of the onboarding review.
 * A link says what it is on sight, and sits on the same baseline as the button
 * beside it.
 */
export function TextLink({
  label,
  onPress,
  disabled = false,
  accessibilityLabel,
  style,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text
      role="link"
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={disabled ? undefined : onPress}
      style={[styles.link, disabled && styles.disabled, style]}
      testID={testID}
    >
      {label}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    link: {
      fontSize: t.ui,
      fontWeight: "600",
      color: colors.accent,
      textDecorationLine: "underline",
      paddingVertical: 8,
    },
    disabled: { opacity: 0.5 },
  });
