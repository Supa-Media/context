import { useRef } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles } from "../../../design/theme";
import type { MenuAnchor } from "./ShareMenu";
import { makeStyles } from "./styles";

/** Open a menu from a trigger, measuring where the trigger is once it can. */
export type OpenFrom = (measure: (done: (anchor: MenuAnchor) => void) => void) => void;

/**
 * "Can read ⌄" — the quiet dropdown at the end of a row.
 *
 * Text and a chevron with no box until it is pressed, the way Google Docs
 * draws "Editor ⌄": a row of bordered buttons down the right edge was the
 * clunkiest thing on the old sheet.
 */
export function MenuTrigger({
  label,
  open,
  onOpen,
  accessibilityLabel,
  compact,
  testID,
}: {
  label: string;
  open: boolean;
  onOpen: OpenFrom;
  accessibilityLabel: string;
  compact: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const ref = useRef<View>(null);
  return (
    <Pressable
      ref={ref}
      accessibilityLabel={accessibilityLabel}
      aria-haspopup="menu"
      aria-expanded={open}
      testID={testID}
      style={[styles.dropdown, open && styles.dropdownOpen]}
      onPress={() =>
        onOpen((done) =>
          ref.current?.measureInWindow((x, y, width, height) => done({ x, y, width, height })),
        )
      }
    >
      <Text style={[styles.dropdownText, compact && styles.roleCompact]}>{label}</Text>
      <Icon name="chevronDown" size={14} color={colors.muted} />
    </Pressable>
  );
}
