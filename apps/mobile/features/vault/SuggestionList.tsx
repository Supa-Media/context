import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../design/components/Text";
import { useThemedStyles, type Colors } from "../design/theme";
import { radii } from "../design/tokens";

/**
 * The list under a website field on the vault's save form: each row an
 * address and the name it belongs to, one tap to fill the field. Used by
 * "Only ever sent to" (API addresses) and "Fills on" (sites).
 */
export function SuggestionList({
  items,
  onPick,
  disabled,
  testID,
}: {
  items: { value: string; name: string }[];
  onPick: (value: string) => void;
  disabled: boolean;
  /** The list's id; each row is `${testID-without-s}-${value}` ("vault-site-suggestion-convex.dev"). */
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  if (items.length === 0) return null;
  const row = testID.replace(/s$/, "");
  return (
    <View style={styles.list} accessibilityLabel="Suggested websites" testID={testID}>
      {items.map((item, index) => (
        <Pressable
          key={item.value}
          accessibilityRole="button"
          accessibilityLabel={`Use ${item.value}, ${item.name}`}
          onPress={() => onPick(item.value)}
          disabled={disabled}
          style={({ pressed }) => [styles.option, index > 0 && styles.divided, pressed && styles.pressed]}
          testID={`${row}-${item.value}`}
        >
          <Text variant="rowTitle" numberOfLines={1}>
            {item.value}
          </Text>
          <Text variant="rowSub" numberOfLines={1}>
            {item.name}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: {
      marginTop: -6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface,
      overflow: "hidden",
    },
    option: { paddingVertical: 9, paddingHorizontal: 12, gap: 1, minHeight: 44, justifyContent: "center" },
    divided: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
    pressed: { backgroundColor: colors.rowSelected },
  });
