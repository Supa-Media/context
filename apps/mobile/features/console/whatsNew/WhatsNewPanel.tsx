import { useState } from "react";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DEVLOG_EXPLORING_DISCLAIMER, DEVLOG_SECTIONS, type DevlogSectionKey, type DevlogWeek } from "@context/shared";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { layout, radii, space } from "../../design/tokens";
import { PLATFORM_ORIGIN } from "../../site/host";
import { DEVLOG_ROUTE, savedOn, shippedLines, type WhatsNewState } from "./whatsNew";

/** The width of the panel at pointer widths: the projects side peek's. */
const PANEL_WIDTH = 440;

/**
 * What's new: the newest devlog week, beside the note on a pointer layout and
 * over the whole screen on a phone (the artboard, 2026-09-29).
 *
 * The four sections are the page's own, in the page's order and words.
 * Shipped shows five lines and a count, like the Discord post; the rest are
 * short and show in full. Exploring always carries its "ideas, not promises"
 * line and each item's "looking at:", because that is the rule, not styling.
 */
export function WhatsNewPanel({
  state,
  onClose,
  onRetry,
}: {
  state: WhatsNewState;
  onClose: () => void;
  onRetry: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const phone = useWindowDimensions().width < layout.narrowBreakpoint;
  const insets = useSafeAreaInsets();
  const week = state.kind === "ready" || state.kind === "offline" ? state.week : null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      {phone ? null : (
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
          onPress={onClose}
          accessibilityLabel="Close what's new"
          testID="whats-new-scrim"
        />
      )}
      <View
        role="dialog"
        aria-label="What's new"
        style={[
          styles.panel,
          phone ? styles.phone : styles.side,
          phone ? { paddingTop: insets.top, paddingBottom: insets.bottom } : null,
        ]}
        testID="whats-new-panel"
      >
        <View style={styles.head}>
          {phone ? (
            <PressRow accessibilityLabel="Back" onPress={onClose} radius={radii.pill} style={styles.headButton}>
              <Icon name="chevronLeft" size={18} />
            </PressRow>
          ) : null}
          <Text variant="rowTitle" style={styles.title}>
            What's new
          </Text>
          {week ? (
            <Text variant="treeMeta" numberOfLines={1} style={styles.headMeta}>
              week {week.number}
              {week.dates ? ` · ${week.dates}` : ""}
            </Text>
          ) : null}
          {phone ? null : (
            <PressRow
              accessibilityLabel="Close what's new"
              onPress={onClose}
              radius={radii.sm}
              style={[styles.headButton, styles.close]}
              testID="whats-new-close"
            >
              <Icon name="close" size={14} color={colors.chromeMuted} />
            </PressRow>
          )}
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
          {state.kind === "loading" ? <Loading /> : null}
          {state.kind === "error" ? (
            <View style={styles.centred} testID="whats-new-error">
              <Text variant="rowTitle">Couldn't load what's new</Text>
              <View style={styles.links}>
                <Link label="Try again" onPress={onRetry} testID="whats-new-retry" />
                <Link label="Open the devlog" onPress={() => void Linking.openURL(`${PLATFORM_ORIGIN}${DEVLOG_ROUTE}`)} />
              </View>
            </View>
          ) : null}
          {state.kind === "none" ? (
            <View style={styles.centred}>
              <Text variant="rowTitle">No updates yet</Text>
              <Text variant="treeMeta">Weekly notes on what changed will show up here.</Text>
            </View>
          ) : null}
          {state.kind === "offline" ? (
            <View style={styles.notice} testID="whats-new-offline">
              <Text variant="treeMeta" style={styles.noticeText}>
                You're offline. This is the copy saved on {savedOn(state.savedAt)}.
              </Text>
            </View>
          ) : null}
          {week ? <Week week={week} /> : null}
        </ScrollView>

        {week ? (
          <View style={styles.foot}>
            <Link
              label="Read the full week"
              onPress={() => void Linking.openURL(`${PLATFORM_ORIGIN}${DEVLOG_ROUTE}`)}
              testID="whats-new-full-week"
            />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

function Week({ week }: { week: DevlogWeek }) {
  const styles = useThemedStyles(makeStyles);
  const [expanded, setExpanded] = useState(false);
  const shipped = shippedLines(week, expanded);
  return (
    <View style={styles.week}>
      {DEVLOG_SECTIONS.map(({ key, heading }) => {
        const items = key === "shipped" ? shipped.lines : week.sections[key];
        return (
          <View key={key} style={styles.section} testID={`whats-new-${key}`}>
            <SectionTag section={key} label={heading} />
            {key === "exploring" && items.length > 0 ? (
              <Text variant="treeMeta" style={styles.disclaimer}>
                {DEVLOG_EXPLORING_DISCLAIMER}
              </Text>
            ) : null}
            {items.length === 0 ? (
              <Text variant="treeMeta">nothing this week</Text>
            ) : (
              items.map((item, index) => (
                <View key={`${key}-${index}`} style={styles.item}>
                  <View style={styles.bullet} aria-hidden />
                  <Text variant="body" style={styles.itemText}>
                    {item}
                  </Text>
                </View>
              ))
            )}
            {key === "shipped" && shipped.more > 0 ? (
              <Link label={`${shipped.more} more`} onPress={() => setExpanded(true)} testID="whats-new-more" />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function SectionTag({ section, label }: { section: DevlogSectionKey; label: string }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const tone: Record<DevlogSectionKey, string> = {
    shipped: colors.accent,
    inProgress: colors.warn,
    exploring: colors.markTeam,
    declined: colors.muted,
  };
  return (
    <View style={styles.tag}>
      <View style={[styles.tagDot, { backgroundColor: tone[section] }]} aria-hidden />
      <Text variant="eyebrow" style={styles.tagText}>
        {label}
      </Text>
    </View>
  );
}

function Loading() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.week} accessibilityLabel="Loading what's new" testID="whats-new-loading">
      {[40, 90, 75, 82, 60].map((width, index) => (
        <View key={index} style={[styles.bar, { width: `${width}%` }]} />
      ))}
    </View>
  );
}

function Link({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <PressRow accessibilityLabel={label} onPress={onPress} radius={radii.sm} style={styles.link} testID={testID}>
      <Text variant="rowTitle" style={styles.linkText}>
        {label}
      </Text>
    </PressRow>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: { position: "absolute", backgroundColor: colors.ground },
    side: {
      top: 0,
      right: 0,
      bottom: 0,
      width: PANEL_WIDTH,
      maxWidth: "100%",
      borderLeftWidth: 1,
      borderLeftColor: colors.lineStrong,
      boxShadow: "-12px 0 32px rgba(0,0,0,.12)",
    },
    phone: { top: 0, right: 0, bottom: 0, left: 0 },
    head: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      minHeight: 52,
      paddingHorizontal: space.x3,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    headButton: {
      width: layout.minTouchTarget,
      height: layout.minTouchTarget,
      alignItems: "center",
      justifyContent: "center",
    },
    close: { marginLeft: "auto" },
    title: { fontWeight: "700" },
    headMeta: { flexShrink: 1 },
    scroll: { flex: 1 },
    body: { padding: space.x4, gap: space.x3 },
    week: { gap: space.x4 },
    section: { gap: space.x2 },
    tag: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    tagDot: { width: 8, height: 8, borderRadius: 4 },
    tagText: { color: colors.text },
    disclaimer: { fontStyle: "italic" },
    item: { flexDirection: "row", gap: space.x2, alignItems: "flex-start" },
    bullet: { width: 4, height: 4, borderRadius: 2, marginTop: 9, backgroundColor: colors.muted },
    itemText: { flex: 1 },
    centred: { alignItems: "center", gap: space.x2, paddingVertical: space.x6 },
    links: { flexDirection: "row", gap: space.x3 },
    notice: { borderRadius: radii.md, backgroundColor: colors.surface2, padding: space.x3 },
    noticeText: { color: colors.text2 },
    bar: { height: 10, borderRadius: 5, backgroundColor: colors.surface3 },
    foot: {
      flexDirection: "row",
      paddingHorizontal: space.x3,
      paddingVertical: space.x2,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    link: { paddingHorizontal: space.x2, paddingVertical: space.x1, minHeight: 32, justifyContent: "center" },
    linkText: { color: colors.accentText },
  });
