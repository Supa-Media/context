import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";

/**
 * The one head row of a screen inside the Vault: a key, a key being edited,
 * or New key. The name is the way back (‹ Stripe), a quiet line under it,
 * and one small action at the end. The same row everywhere in the Vault, so
 * the panel never stacks a list's head, a back link and a second title
 * (Dev, 2026-11-23: "what the heck is this ugly header").
 */
export function VaultBackRow({
  title,
  sub,
  onBack,
  backLabel,
  trailing,
  testID,
}: {
  title: string;
  sub?: string;
  /** Back to the list; absent where there is no list to go back to (side by side). */
  onBack?: () => void;
  /** What a screen reader hears for the back press. */
  backLabel: string;
  trailing?: ReactNode;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const words = (
    <View style={styles.words}>
      <Text variant="rowTitle" style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {sub ? (
        <Text variant="rowSub" style={styles.sub} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
  return (
    <View style={styles.row}>
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={backLabel}
          onPress={onBack}
          testID={testID}
          style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [styles.back, (hovered || pressed) && styles.hover]}
        >
          <Icon name="chevronLeft" size={16} color={colors.accent} />
          {words}
        </Pressable>
      ) : (
        <View style={styles.still}>{words}</View>
      )}
      {trailing}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: -8, paddingRight: 8, minHeight: 48 },
    back: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4, paddingLeft: 4, paddingRight: 8, borderRadius: radii.md },
    still: { flex: 1, minWidth: 0, paddingHorizontal: 8 },
    hover: { backgroundColor: colors.chipFill },
    words: { flex: 1, minWidth: 0 },
    title: { fontWeight: "600" },
    sub: { color: colors.muted },
  });
