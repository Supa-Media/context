import { useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import { cardPlacement, type AccountCardAnchor } from "../AccountCard";
import type { PhoneBackTarget } from "./phoneBack";

/**
 * The phone's top-left on any page below Home: a round ‹ that opens the levels
 * above the page.
 *
 * The owner's redesign of the note's top bar (2026-10-13): the capsule that
 * spelled out "‹ health" looked ugly, and there was no way Home but backing out
 * one level at a time. They picked the board where pressing ‹ opens a short
 * menu — Home, then each folder down to the page's own — so the bar is the same
 * round key as the ••• beside it, and Home is always the menu's first row.
 *
 * With one level (a page at the top of the workspace, or the map) there is
 * nothing to choose between, and ‹ goes there at once.
 *
 * `after` is anything that has to stay beside it: a signed-out visitor's Sign
 * in, which is the one call to action the top bar carries and has nowhere else
 * to go.
 */
export function PhoneBack({
  levels,
  onGo,
  after,
}: {
  /** From `phoneBackLevels`: Home first, the page's own folder last. Never empty. */
  levels: PhoneBackTarget[];
  onGo: (target: PhoneBackTarget) => void;
  after?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const triggerRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<AccountCardAnchor | null>(null);
  const only = levels.length === 1 ? levels[0] : null;
  const nearest = levels[levels.length - 1];

  const press = () => {
    if (only !== null) return onGo(only);
    // Opened under the button at once, then moved onto its measured box: the
    // measure answers asynchronously on the web.
    setAnchor({ x: space.x3, y: 0, width: layout.minTouchTarget, height: layout.minTouchTarget });
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor((was) => (was === null ? was : { x, y, width, height }));
    });
  };

  const go = (target: PhoneBackTarget) => {
    setAnchor(null);
    onGo(target);
  };

  return (
    <View style={styles.row}>
      <View ref={triggerRef}>
        <Pressable
          onPress={press}
          accessibilityRole="button"
          accessibilityLabel={only !== null ? `Back to ${only.label}` : `Back to ${nearest.label}, or further up`}
          aria-haspopup={only !== null ? undefined : "menu"}
          aria-expanded={only !== null ? undefined : anchor !== null}
          style={({ pressed }) => [styles.key, pressed ? styles.pressed : null]}
          testID="phone-back"
        >
          <Icon name="chevronLeft" size={20} color={colors.accent} />
        </Pressable>
      </View>
      {after}
      {anchor === null ? null : (
        <LevelsMenu levels={levels} anchor={anchor} onGo={go} onDismiss={() => setAnchor(null)} />
      )}
    </View>
  );
}

/**
 * The levels, dropping from the button. A `Modal` for the same dismissal every
 * other card here has: a press outside, Escape on the web, Back on Android.
 * Rows are 44pt, because this is only ever under a thumb.
 */
function LevelsMenu({
  levels,
  anchor,
  onGo,
  onDismiss,
}: {
  levels: PhoneBackTarget[];
  anchor: AccountCardAnchor;
  onGo: (target: PhoneBackTarget) => void;
  onDismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const view = useWindowDimensions();
  const box = cardPlacement(anchor, view);
  return (
    <Modal transparent visible animationType="none" onRequestClose={onDismiss}>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onDismiss}
        accessibilityLabel="Close"
        testID="phone-back-scrim"
      />
      <View role="menu" aria-label="Go back to" style={[styles.menu, box]} testID="phone-back-menu">
        {levels.map((level) => (
          <Pressable
            key={level.folder ?? ""}
            role="menuitem"
            accessibilityLabel={level.label}
            onPress={() => onGo(level)}
            style={({ pressed }) => [styles.item, pressed ? styles.itemPressed : null]}
            testID={`phone-back-level-${level.folder ?? "home"}`}
          >
            <Icon name={level.folder === null ? "home" : "folder"} size={18} color={colors.muted} />
            <Text variant="rowTitle" numberOfLines={1} style={styles.itemLabel}>
              {level.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, minWidth: 0, flexShrink: 1 },
    key: {
      alignItems: "center",
      justifyContent: "center",
      width: layout.minTouchTarget,
      height: layout.minTouchTarget,
      minHeight: layout.minTouchTarget,
      borderRadius: radii.pill,
      backgroundColor: colors.chrome,
      boxShadow: shadows.floating,
    },
    pressed: { opacity: 0.7 },
    menu: {
      position: "absolute",
      paddingVertical: space.x1,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
      boxShadow: "0 24px 60px -18px rgba(0,0,0,.9)",
      overflow: "hidden",
    },
    item: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: layout.minTouchTarget,
      paddingHorizontal: space.x4,
    },
    itemPressed: { backgroundColor: colors.surface2 },
    itemLabel: { flexShrink: 1 },
  });
