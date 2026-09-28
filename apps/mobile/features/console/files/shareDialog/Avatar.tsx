import { View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { useColors, useThemedStyles } from "../../../design/theme";
import { PersonFace } from "../../faces/PersonFace";
import { makeStyles } from "./styles";

/**
 * A person's face in a circle, or a group's mark.
 *
 * The face is the one drawn everywhere else (`PersonFace`: a photo, their
 * workspace icon, or a silhouette), so somebody looks the same in this list
 * as on the note behind it. Initials went everywhere at once (Dev2,
 * 2026-09-28); the name is always printed beside the face here. A group is
 * iris, the palette's colour for "more than one person you did not pick one
 * by one".
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
        <PersonFace name={label} size={small ? 22 : compact ? 36 : 32} />
      )}
    </View>
  );
}
