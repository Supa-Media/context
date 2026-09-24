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
  testID,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <PressRow
      accessibilityLabel={label}
      onPress={onPress}
      radius={radii.md}
      style={styles.iconButton}
      hoverStyle={styles.iconButtonHover}
      testID={testID}
    >
      <Icon name={icon} size={15} color={colors.text2} />
    </PressRow>
  );
}
