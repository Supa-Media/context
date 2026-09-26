import { useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { radii } from "../design/tokens";
import { useColors, useThemedStyles } from "../design/theme";
import { makeStyles as explorerStyles } from "../console/files/explorer/styles";
import { acceptLabel, dismissLabel, reviewCopy, reviewMeta, suggestionsLine } from "./copy";
import { groupSuggestions } from "./rules";
import { makeSheetStyles, makeStyles } from "./styles";
import type { OrganizerSuggestion } from "./types";
import type { OrganizerView } from "./useOrganizer";

/**
 * 04 — the one review list: the popover's over the tree and the phone's sheet.
 *
 * Accepting one never removes the rest; each row goes on its own answer. On a
 * pointer the ✓ and ✕ are lit on the row under it (present and focusable at
 * rest, as the explorer's toolbar is), and on a phone always.
 */
export function ReviewList({ organizer, touch = false }: { organizer: OrganizerView; touch?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState<string | null>(null);
  const { list, loading, failed, busy } = organizer.suggestions;

  if (list === null || list.length === 0) {
    return (
      <View style={styles.reviewNote} testID="organizer-review-note">
        {loading ? (
          <View style={styles.reviewLoading}>
            <ActivityIndicator size="small" color={colors.muted} />
            <Text variant={touch ? "rowSub" : "treeMeta"} style={styles.reviewMeta}>
              {reviewCopy.loading}
            </Text>
          </View>
        ) : (
          <Text variant={touch ? "rowSub" : "treeMeta"} style={styles.reviewMeta}>
            {failed ? reviewCopy.failed : reviewCopy.empty}
          </Text>
        )}
      </View>
    );
  }

  const row = (item: OrganizerSuggestion) => {
    const lit = touch || hovered === item.id;
    const pending = busy.has(item.id);
    return (
      <View
        key={item.id}
        onPointerEnter={() => setHovered(item.id)}
        onPointerLeave={() => setHovered((current) => (current === item.id ? null : current))}
        style={[styles.reviewRow, touch && styles.reviewRowTouch, !touch && hovered === item.id && styles.reviewRowHover]}
        testID={`organizer-suggestion-${item.id}`}
      >
        <View style={styles.reviewBody}>
          <Text variant={touch ? "rowTitle" : "tree"} numberOfLines={1} style={styles.reviewTitle}>
            {item.title}
          </Text>
          <Text variant={touch ? "rowSub" : "treeMeta"} numberOfLines={1} style={styles.reviewMeta}>
            {reviewMeta(item)}
          </Text>
        </View>
        {/*
          At rest on a pointer the pair is out of the flow and unlit, so the
          titles keep the column's width; the row under the pointer, or holding
          focus, takes it back. Still mounted, so a keyboard can reach it.
        */}
        <View
          onFocus={() => setHovered(item.id)}
          onBlur={() => setHovered((current) => (current === item.id ? null : current))}
          style={[styles.acts, touch && styles.actsTouch, lit ? styles.actsShown : styles.actsResting]}
        >
          <PressRow
            accessibilityLabel={acceptLabel(item)}
            onPress={() => organizer.resolve(item, "accept")}
            disabled={pending}
            radius={radii.sm}
            style={[styles.act, touch && styles.actTouch]}
            hoverStyle={styles.actHover}
            testID={`organizer-accept-${item.id}`}
          >
            <Icon name="check" size={touch ? 16 : 13} color={colors.accentText} />
          </PressRow>
          <PressRow
            accessibilityLabel={dismissLabel(item)}
            onPress={() => organizer.resolve(item, "dismiss")}
            disabled={pending}
            radius={radii.sm}
            style={[styles.act, touch && styles.actTouch]}
            hoverStyle={styles.actHover}
            testID={`organizer-dismiss-${item.id}`}
          >
            <Icon name="close" size={touch ? 15 : 12} color={colors.chromeMuted} />
          </PressRow>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.reviewList} testID="organizer-review-list">
      {groupSuggestions(list).map((group) => (
        <View key={group.key}>
          <View style={styles.divider}>
            <Text variant="eyebrow" style={styles.dayLabel}>
              {group.label}
            </Text>
            <View style={styles.rule} />
          </View>
          {group.items.map(row)}
        </View>
      ))}
    </View>
  );
}

/** The explorer foot's line, the activity line's twin: "11 suggestions". */
export function SuggestionsLine({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  const colors = useColors();
  const ex = useThemedStyles(explorerStyles);
  return (
    <PressRow
      accessibilityLabel={`${suggestionsLine(count)}. Show them`}
      onPress={onToggle}
      ariaExpanded={open}
      ariaHasPopup="menu"
      radius={radii.sm}
      style={StyleSheet.flatten([ex.foot, ex.footPress])}
      hoverStyle={ex.matchHover}
      testID="explorer-suggestions"
    >
      <Icon name="sparkle" size={12} color={colors.accent} />
      <Text variant="treeMeta" numberOfLines={1} style={ex.footGrow}>
        {suggestionsLine(count)}
      </Text>
      <Icon name={open ? "chevronDown" : "chevronUp"} size={11} color={colors.chromeMuted} />
    </PressRow>
  );
}

/** The popover over the tree, anchored to that line: the activity list's frame. */
export function ReviewPopover({ organizer, lift }: { organizer: OrganizerView; lift: { bottom: number } | null }) {
  const colors = useColors();
  const ex = useThemedStyles(explorerStyles);
  return (
    <View style={[ex.activitySheet, lift]} testID="explorer-suggestions-list">
      <ScrollView style={ex.activityScroll}>
        <ReviewList organizer={organizer} />
      </ScrollView>
      <PressRow
        accessibilityLabel={reviewCopy.foot}
        onPress={() => {
          organizer.closeReview();
          organizer.openSettings();
        }}
        radius={radii.sm}
        style={ex.activityFoot}
        hoverStyle={ex.matchHover}
      >
        <Text variant="treeMeta" style={ex.footGrow}>
          {reviewCopy.foot}
        </Text>
        <Icon name="chevronRight" size={11} color={colors.chromeMuted} />
      </PressRow>
    </View>
  );
}

/** The phone's sheet: `RecentSheet`'s frame with the same list at touch size. */
export function ReviewSheet({ organizer }: { organizer: OrganizerView }) {
  const styles = useThemedStyles(makeSheetStyles);
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="slide" visible onRequestClose={organizer.closeReview}>
      <Pressable style={styles.scrim} accessibilityLabel="Close suggestions" onPress={organizer.closeReview}>
        {/* Swallow presses inside the sheet so only the scrim dismisses it. */}
        <Pressable
          style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
          onPress={() => {}}
          accessibilityLabel={reviewCopy.sheetTitle}
          testID="organizer-review-sheet"
        >
          <View style={styles.grabber} aria-hidden />
          <Text variant="railHead" role="heading" aria-level={2} style={styles.sheetHead}>
            {reviewCopy.sheetTitle}
          </Text>
          <ScrollView style={styles.list}>
            <ReviewList organizer={organizer} touch />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
