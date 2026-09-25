import { StyleSheet } from "react-native";
import { radii } from "../tokens";
import { useColors, useThemedStyles, type Colors } from "../theme";
import { PressRow } from "./Button";
import { Icon } from "./Icon";

/**
 * Delete a row somebody added — a folder they named, an invitee they typed.
 *
 * A bin rather than the word "Remove": the word was a ghost button, which
 * draws a bare label, so it read as a stray piece of text on the end of the
 * row rather than as a control. The glyph is what every platform draws for
 * this, and the accessible name still says exactly which row it removes.
 *
 * Only for taking back something unsaved. Removing something that already
 * exists — a member, a domain — stays a two-step "Remove → Confirm" button,
 * because a bin that acts on one tap is the wrong shape for anything that
 * cannot be typed again in a second.
 */
export function DeleteButton({
  accessibilityLabel,
  onPress,
  disabled = false,
  testID,
}: {
  /** Which row — "Remove folder 2", never just "Remove". */
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <PressRow
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
      radius={radii.md}
      style={[styles.box, disabled && styles.disabled]}
      hoverStyle={styles.hover}
      hitSlop={6}
      testID={testID}
    >
      <Icon name="trash" size={16} color={colors.text2} />
    </PressRow>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radii.md,
    },
    hover: { backgroundColor: colors.surface3 },
    disabled: { opacity: 0.5 },
  });
