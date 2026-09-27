/**
 * One quiet line above a folder's files, when its subfolders could be tracked
 * by status and nothing in it has one yet (spec A7): "Track these folders by
 * status?" and `Show as list`, which only switches the view — the grouped
 * list, with everything under No status and `Set status` on each row, is the
 * rest of the answer. No banner, no colour but the accent on the one action;
 * closed per viewer with the `×`.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";

export function TrackNudge({
  onShow,
  onDismiss,
  compact,
}: {
  onShow: () => void;
  onDismiss: () => void;
  compact: boolean;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <View style={styles.line} testID="folder-nudge">
      <View style={styles.sentence}>
        <Text variant="tree" style={styles.words}>
          Track these folders by status?
        </Text>
        <Pressable
          role="button"
          accessibilityLabel="Show as list"
          onPress={onShow}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          hitSlop={6}
          testID="folder-nudge-show"
        >
          <Text
            variant="tree"
            style={[styles.action, hovered && styles.actionHover]}
          >
            Show as list
          </Text>
        </Pressable>
      </View>
      <Pressable
        role="button"
        accessibilityLabel="Dismiss"
        onPress={onDismiss}
        hitSlop={compact ? 14 : 8}
        style={styles.close}
        testID="folder-nudge-dismiss"
      >
        <Icon name="close" size={12} color={colors.chromeMuted} />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    line: { flexDirection: "row", alignItems: "flex-start", gap: space.x3 },
    sentence: {
      flexGrow: 1,
      flexShrink: 1,
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      columnGap: space.x3,
      rowGap: 2,
    },
    words: { color: colors.muted },
    action: { color: colors.accentText, fontWeight: "600" },
    actionHover: { textDecorationLine: "underline" },
    close: { paddingTop: 4 },
  });
