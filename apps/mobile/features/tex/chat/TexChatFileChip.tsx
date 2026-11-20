import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii, space, texChatType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";

const KIB = 1024;
const MIB = 1024 * 1024;

/** A file's size as a person reads it: whole KB under a megabyte, then MB to one decimal. */
export function formatFileSize(bytes: number): string {
  if (bytes < MIB) return `${Math.max(1, Math.round(bytes / KIB))} KB`;
  return `${(bytes / MIB).toFixed(1)} MB`;
}

export interface TexChatFileChipProps {
  testID: string;
  name: string;
  /** The size, drawn after the name in muted type, or none. */
  detail?: string;
  /** Pressing the whole chip. Makes it a button labelled `pressLabel`. */
  onPress?: () => void;
  pressLabel?: string;
  /** A close key at the end, for a file the person picked and can drop before sending. */
  onRemove?: () => void;
  removeLabel?: string;
  removeTestID?: string;
}

/**
 * A file, drawn as a chip: its icon, its name on one line, and what the person
 * can do with it. Used by the composer for files picked to send and by a row for
 * files it carries, saved or still sending.
 */
export function TexChatFileChip({
  testID,
  name,
  detail,
  onPress,
  pressLabel,
  onRemove,
  removeLabel,
  removeTestID,
}: TexChatFileChipProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const body = (
    <>
      <Icon name="file" size={14} color={colors.muted} />
      <Text variant="meta" style={styles.name} numberOfLines={1}>
        {name}
      </Text>
      {detail !== undefined ? (
        <Text variant="meta" style={styles.detail} numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
      {onRemove !== undefined ? (
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={removeLabel ?? `Remove ${name}`}
          style={styles.remove}
          testID={removeTestID}
        >
          <Icon name="close" size={12} color={colors.muted} />
        </Pressable>
      ) : null}
    </>
  );

  if (onPress !== undefined) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={pressLabel ?? name}
        style={styles.chip}
        testID={testID}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View style={styles.chip} testID={testID}>
      {body}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      maxWidth: "100%",
      height: 36,
      paddingVertical: 6,
      paddingHorizontal: space.x2,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
    },
    name: { maxWidth: 160, flexShrink: 1, fontSize: texChatType.cardTitle, color: colors.text },
    detail: { flexShrink: 0, fontSize: texChatType.status, color: colors.muted },
    remove: {
      width: 24,
      height: 24,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radii.control,
    },
  });
