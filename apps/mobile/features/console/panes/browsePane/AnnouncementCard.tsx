import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useFrame } from "../../../app/AppFrame";
import { Button, PressRow } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { clearOfToasts, useToastEdge } from "../../../design/components/toastEdge";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../../design/theme";
import { radii, space } from "../../../design/tokens";
import type { Announcement } from "./announcements";

/** The card's width at a pointer density; a phone's is the glass less its gutters. */
export const ANNOUNCEMENT_CARD_WIDTH = 340;

/**
 * What is new, in the corner: one announcement at a time, over the note.
 *
 * Absolutely placed in the browse region, so it never moves a line of the page
 * it sits on. Bottom right above the status strip at a pointer density; full
 * width just above the floating toolbar on a phone. Either way it shares that
 * edge with the toasts: it sits above a toast that is showing, and for the one
 * frame before a new toast has been measured it is not drawn at all (see
 * `toastEdge.tsx`), because a card over an Undo is worse than a card late.
 *
 * On a phone it is also put away while the keyboard's accessory bar is up. The
 * toolbar it sits above has gone then, and a card floating over the line being
 * typed is the full-page takeover this replaced, in a smaller box.
 */
export function AnnouncementCard({
  items,
  compact,
}: {
  items: readonly Announcement[];
  compact: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const frame = useFrame();
  const edge = useToastEdge();
  const [at, setAt] = useState(0);

  if (items.length === 0) return null;
  if (compact && frame.accessoryOpen) return null;
  // An answered item leaves the list; the one after it takes its place, or the last one if it was last.
  const index = Math.min(at, items.length - 1);
  const item = items[index]!;
  const base = compact ? frame.contentInsets.bottom + space.x2 : space.x4;
  const bottom = clearOfToasts(base, edge, space.x2);
  if (bottom === null) return null;

  const paged = items.length > 1;
  return (
    <View
      style={[compact ? styles.placePhone : styles.place, { bottom }]}
      testID="announcement-card"
    >
      <View
        style={[styles.card, compact && styles.cardPhone]}
        role="region"
        accessibilityLabel="Announcements"
        testID={item.testID}
      >
        <View style={styles.head}>
          <Icon name={item.icon ?? "sparkle"} size={compact ? 13 : 11} color={colors.accent} />
          <Text variant="eyebrow" style={styles.eyebrow} numberOfLines={1}>
            {item.eyebrow}
          </Text>
          {paged ? (
            <View style={styles.pager} testID="announcement-pager">
              <PressRow
                accessibilityLabel="Previous"
                onPress={() => setAt(Math.max(0, index - 1))}
                disabled={index === 0}
                radius={radii.sm}
                style={styles.pagerHit}
                hitSlop={8}
                testID="announcement-previous"
              >
                <Icon name="chevronLeft" size={compact ? 14 : 11} color={index === 0 ? colors.chromeMuted : colors.muted} />
              </PressRow>
              <Text variant={compact ? "rowSub" : "treeMeta"} testID="announcement-position">
                {index + 1} of {items.length}
              </Text>
              <PressRow
                accessibilityLabel="Next"
                onPress={() => setAt(Math.min(items.length - 1, index + 1))}
                disabled={index === items.length - 1}
                radius={radii.sm}
                style={styles.pagerHit}
                hitSlop={8}
                testID="announcement-next"
              >
                <Icon
                  name="chevronRight"
                  size={compact ? 14 : 11}
                  color={index === items.length - 1 ? colors.chromeMuted : colors.muted}
                />
              </PressRow>
            </View>
          ) : null}
        </View>
        <Text variant={compact ? "treeTouch" : "rowTitle"} style={compact ? styles.titlePhone : undefined}>
          {item.title}
        </Text>
        <Text variant={compact ? "rowValueTouch" : "rowSub"}>
          {item.body}
        </Text>
        <View style={styles.actions}>
          {item.actions.map((action) => (
            <Button
              key={action.testID}
              label={action.label}
              onPress={action.onPress}
              disabled={action.disabled}
              testID={action.testID}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    // `box-none`: only the card is a target, never the strip of page around it.
    place: {
      position: "absolute",
      right: space.x4,
      width: ANNOUNCEMENT_CARD_WIDTH,
      zIndex: 20,
      pointerEvents: "box-none",
    },
    placePhone: {
      position: "absolute",
      left: space.x3,
      right: space.x3,
      zIndex: 20,
      pointerEvents: "box-none",
    },
    /*
      The toast's materials, one step quieter: `surface2` rather than the
      toast's `surface3`, which in the dark palette is what lifts it off the
      page, and the floating shadow every other object over the editor uses.
    */
    card: {
      paddingTop: space.x3,
      paddingBottom: space.x3,
      paddingHorizontal: space.x4,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
      boxShadow: shadows.floating,
      gap: 6,
    },
    cardPhone: { borderRadius: radii.sheet, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 14, gap: space.x2 },
    head: { flexDirection: "row", alignItems: "center", gap: 6 },
    eyebrow: { color: colors.accent, flexGrow: 1, flexShrink: 1, minWidth: 0 },
    pager: { flexDirection: "row", alignItems: "center", gap: 2 },
    pagerHit: { padding: 3 },
    titlePhone: { fontWeight: "600" },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2, marginTop: 6 },
  });
