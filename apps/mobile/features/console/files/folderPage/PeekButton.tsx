/**
 * "Open" on a List row, shown while the row is hovered or focused: opens the
 * row in the side panel — Notion's "OPEN" beside a title, with the side
 * panel's mark. Pressing the row itself does the same; this is the button
 * that says so. Drawn only where there is a panel to open (`onPeek`), so a
 * phone, where a row opens its page, has none.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii, space, type Shadows } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import type { ItemActions } from "./items";
import type { FolderItem } from "./model";
import { keyboardFocus } from "./rowCells";

const HINT = "Open in side panel";

export function PeekButton({ item, actions, shown }: { item: FolderItem; actions: ItemActions; shown: boolean }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const peek = actions.onPeek ?? null;
  if (peek === null) return null;
  return (
    <View style={styles.anchor}>
      <Pressable
        onPress={() => peek(item)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onFocus={(event) => setFocused(keyboardFocus(event))}
        onBlur={() => setFocused(false)}
        role="button"
        accessibilityLabel={HINT}
        style={[styles.pill, !shown && !focused && styles.quiet]}
        testID="folder-row-peek"
      >
        <Icon name="panelRight" size={12} color={colors.text2} />
        <Text variant="meta" style={styles.word}>
          Open
        </Text>
      </Pressable>
      {hovered ? (
        // The words the mark stands for, as Notion's tooltip says them — under the pointer only: a
        // button keeps the focus a click gave it, and a hint left standing over the row above it
        // covered that row's name until something else was clicked. The keyboard hears the label.
        <View style={styles.hint} aria-hidden pointerEvents="none">
          <Text variant="treeMeta" numberOfLines={1} style={styles.hintText}>
            {HINT}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    anchor: { flexShrink: 0 },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface3,
      borderRadius: radii.sm,
      paddingHorizontal: space.x2,
      paddingVertical: 2,
    },
    quiet: { opacity: 0 },
    word: { color: colors.text2 },
    hint: {
      position: "absolute",
      bottom: "100%",
      right: 0,
      marginBottom: space.x1,
      paddingHorizontal: space.x2,
      paddingVertical: space.x1,
      borderRadius: radii.sm,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.line,
      zIndex: 3,
      boxShadow: shadows.floating,
    } as never,
    hintText: { color: colors.text2 },
  });
