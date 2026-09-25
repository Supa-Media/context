import { View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles } from "../../../design/theme";
import { initials } from "./copy";
import { makeStyles } from "./styles";

/**
 * A person's initials in a circle, or a group's mark.
 *
 * Initials rather than an icon because the list is read by *who*, and two
 * letters are faster to find than a repeated silhouette. A group is iris, the
 * palette's colour for "more than one person you did not pick one by one".
 */
export function Avatar({
  label,
  group = false,
  owner = false,
  size = "row",
  compact = false,
}: {
  label: string;
  group?: boolean;
  owner?: boolean;
  size?: "row" | "chip";
  compact?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const small = size === "chip";
  return (
    <View
      aria-hidden
      style={[
        styles.avatar,
        compact && !small && styles.avatarCompact,
        small && styles.avatarSmall,
        group && styles.avatarGroup,
        owner && !group && styles.avatarOwner,
      ]}
    >
      {group ? (
        <Icon name="people" size={small ? 12 : 16} color={colors.sharedText} />
      ) : (
        <Text style={[styles.avatarText, small && styles.avatarTextSmall]}>{initials(label)}</Text>
      )}
    </View>
  );
}
