import { Pressable, StyleSheet, View } from "react-native";
import { radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { meetingBadge, meetingSubtitle } from "../format";
import type { MeetingSession } from "../protocol";

/**
 * One meeting in the list: what it was, when, how long, and whether it is done.
 *
 * The mockup's grouped-list row — a 38pt rounded mark, a title, a subtitle, and
 * a trailing marker that is either a state or a chevron. Rows share one card
 * with hairlines between them, and the hairline is inset to the text rather
 * than run full width, which is what makes it read as a list rather than as a
 * stack of separate cards.
 *
 * ## The trailing element carries the one thing that matters
 *
 * A meeting whose note is in the customer's bucket shows a chevron; one that is
 * not shows **Draft**. That distinction is the product: this app is a way of
 * getting a meeting into storage the customer owns, and a row that looked the
 * same either way would hide the only fact worth knowing about it. `format.ts`
 * decides the word, so the list, the live screen and the bar cannot disagree.
 */
export function MeetingRow({
  meeting,
  onPress,
  locale,
}: {
  meeting: MeetingSession;
  onPress: () => void;
  locale?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const badge = meetingBadge(meeting);
  const subtitle = meetingSubtitle(meeting, { locale });

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      // The visible row is three separate texts; a screen reader should hear
      // one sentence, in the order a sighted reader takes them in.
      accessibilityLabel={[meeting.title, subtitle, badge?.label].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`meeting-row-${meeting.id}`}
    >
      <View style={styles.mark} aria-hidden>
        <Icon name={meeting.state === "complete" ? "file" : "folder"} size={17} color={colors.text2} />
      </View>

      <View style={styles.grow}>
        <Text variant="rowTitle" numberOfLines={1}>
          {meeting.title}
        </Text>
        <Text variant="rowSub" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>

      {badge === null ? (
        <Icon name="chevronRight" size={16} color={colors.heroDim} />
      ) : (
        <View style={[styles.badge, badge.tone === "crit" ? styles.badgeCrit : styles.badgeWarn]}>
          <Text
            variant="pill"
            style={badge.tone === "crit" ? styles.badgeCritText : styles.badgeWarnText}
          >
            {badge.label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/** The hairline between two rows, inset to the text the way the mockup draws it. */
export function RowDivider() {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.divider} aria-hidden />;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  pressed: { backgroundColor: colors.surface3 },
  mark: {
    width: 38,
    height: 38,
    borderRadius: radii.card,
    backgroundColor: colors.surface3,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  grow: { flex: 1, minWidth: 0, gap: 3 },
  badge: {
    height: 24,
    paddingHorizontal: 9,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  badgeWarn: { backgroundColor: colors.warnWash, borderColor: colors.warnBorder },
  badgeWarnText: { color: colors.warnText },
  badgeCrit: { backgroundColor: colors.critWash, borderColor: colors.critBorder },
  badgeCritText: { color: colors.critText },
  divider: { height: 1, backgroundColor: colors.line, marginLeft: 67 },
});
