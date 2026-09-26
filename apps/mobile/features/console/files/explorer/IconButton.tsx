import { PressRow } from "../../../design/components/Button";
import { Icon, type IconName } from "../../../design/components/Icon";
import { radii } from "../../../design/tokens";
import { useColors, useThemedStyles } from "../../../design/theme";
import { makeStyles } from "./styles";

/** One of the column header's square glyph buttons. */
export function IconButton({
  label,
  icon,
  onPress,
  on = false,
  menu = false,
  testID,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  /** Lit: its menu is open, or what it toggles is on. */
  on?: boolean;
  /** Opens a menu rather than acting, which a screen reader is told. */
  menu?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <PressRow
      accessibilityLabel={label}
      onPress={onPress}
      radius={radii.md}
      style={[styles.iconButton, on && styles.iconButtonOn]}
      hoverStyle={styles.iconButtonHover}
      {...(menu ? { ariaHasPopup: "menu" as const, ariaExpanded: on } : {})}
      testID={testID}
    >
      <Icon name={icon} size={15} color={on ? colors.text : colors.text2} />
    </PressRow>
  );
}
