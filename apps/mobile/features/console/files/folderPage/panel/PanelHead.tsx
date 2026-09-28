/**
 * The side panel's top line: where the row is ("Café opening › Get the
 * kitchen ready"), then Expand, Open in new tab and ✕ — Notion's side peek.
 *
 * - **Expand** opens the row as its whole page here, where pressing it used
 *   to go: a note's page, or a folder's.
 * - **Open in new tab** opens it in a tab of its own and leaves the list and
 *   the panel where they are (`ConsoleNav.follow`, in the background, as a
 *   ⌘-click on a link does). A tab holds a note, so a folder opens its front
 *   note; a folder with none, or a surface with no tabs, is not offered it.
 * - **✕** closes the panel, as Escape does.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { FolderItem } from "../model";

export function PanelHead({
  where,
  parent,
  onShow,
  onExpand,
  onNewTab,
  onClose,
}: {
  /** What the page is called. */
  where: string;
  /** The task the row sits in, when it is nested. */
  parent: FolderItem | null;
  onShow: (path: string) => void;
  onExpand: () => void;
  /** Null where there is no tab to open it in. */
  onNewTab: (() => void) | null;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.crumb} testID="task-panel-crumb">
      <Text variant="treeMeta" numberOfLines={1} style={[styles.muted, styles.shrink]}>
        {where}
      </Text>
      {parent === null ? null : (
        <>
          <Text variant="treeMeta" style={styles.muted}>
            ›
          </Text>
          <Pressable onPress={() => onShow(parent.path)} role="link" style={styles.shrink} testID="task-panel-crumb-parent">
            <Text variant="treeMeta" numberOfLines={1} style={styles.link}>
              {parent.label}
            </Text>
          </Pressable>
        </>
      )}
      <View style={styles.push} />
      <HeadButton icon="expand" label="Expand" word="Expand" onPress={onExpand} testID="task-panel-expand" />
      {onNewTab === null ? null : <HeadButton icon="openTab" label="Open in new tab" word="New tab" onPress={onNewTab} testID="task-panel-new-tab" />}
      <HeadButton icon="close" label="Close" onPress={onClose} testID="task-panel-close" />
    </View>
  );
}

function HeadButton({
  icon,
  label,
  word,
  onPress,
  testID,
}: {
  icon: IconName;
  /** What it does, for somebody who cannot see the mark. */
  label: string;
  /** The word beside the mark, where there is one. */
  word?: string;
  onPress: () => void;
  testID: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={[styles.button, hovered && styles.hovered]}
      testID={testID}
    >
      <Icon name={icon} size={13} color={colors.chromeMuted} />
      {word === undefined ? null : (
        <Text variant="treeMeta" style={styles.muted}>
          {word}
        </Text>
      )}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    crumb: { flexDirection: "row", alignItems: "center", gap: space.x2, minWidth: 0 },
    push: { flexGrow: 1 },
    shrink: { flexShrink: 1, minWidth: 0 },
    muted: { color: colors.chromeMuted },
    link: { color: colors.chromeMuted, textDecorationLine: "underline" },
    button: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      paddingVertical: space.x1,
      paddingHorizontal: space.x2,
      borderRadius: radii.sm,
    },
    hovered: { backgroundColor: colors.surface3 },
  });
