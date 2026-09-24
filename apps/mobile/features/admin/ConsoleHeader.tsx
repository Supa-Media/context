/**
 * The top of the staff console: its name, the four tabs, and the window.
 *
 * The tabs and the window picker used to be `Button`s, with the chosen one
 * drawn as the hero call to action — twice the padding of its siblings and a
 * drop shadow, so a selection read as a big black button, and on a phone the
 * two rows of them wrapped before any content. They are now what a selection
 * looks like elsewhere in the app: text tabs with the 2pt accent marker the
 * file tree and the settings list already use, and one quiet segmented track.
 */

import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, leading, radii, space, useThemedStyles, type Colors } from "../design";
import { pointerType, touchType } from "../design/tokens";
import { useCompact } from "./AdminKit";
import { ADMIN_TABS, WINDOW_CHOICES, type AdminTab } from "./report";

/** Only these two tabs are read over a window; the others are snapshots. */
export function isWindowed(tab: AdminTab): boolean {
  return tab === "growth" || tab === "activity";
}

export function ConsoleHeader({
  tab,
  onTab,
  days,
  onDays,
  unsetCount,
}: {
  tab: AdminTab;
  onTab: (tab: AdminTab) => void;
  days: number;
  onDays: (days: number) => void;
  /**
   * Known credentials that are not set, shown on the Credentials tab from
   * every tab — a missing Stripe key is worth seeing from Growth.
   */
  unsetCount: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const windowed = isWindowed(tab);

  const tabs = ADMIN_TABS.map((entry) => {
    const on = entry.key === tab;
    return (
      <Pressable
        key={entry.key}
        role="tab"
        aria-selected={on}
        accessibilityLabel={
          entry.key === "credentials" && unsetCount > 0
            ? `${entry.label}, ${unsetCount} not set`
            : entry.label
        }
        onPress={() => onTab(entry.key)}
        style={styles.tab}
        testID={`admin-tab-${entry.key}`}
      >
        <Text style={[styles.tabLabel, compact && styles.tabLabelCompact, on && styles.tabOn]}>
          {entry.label}
        </Text>
        {entry.key === "credentials" && unsetCount > 0 ? (
          <View style={styles.count} testID="admin-credentials-count">
            <Text style={styles.countText}>{unsetCount}</Text>
          </View>
        ) : null}
        {on ? <View style={styles.marker} /> : null}
      </Pressable>
    );
  });

  return (
    <View>
      <View style={styles.top}>
        <View style={styles.titles}>
          <Text
            variant="paneTitle"
            role="heading"
            aria-level={1}
            style={compact ? styles.titleCompact : null}
          >
            Staff console
          </Text>
          <Text variant="paneSub" style={compact ? styles.subCompact : null}>
            Every context on the platform · days in UTC
          </Text>
        </View>
        {windowed && !compact ? <WindowPicker days={days} onDays={onDays} /> : null}
      </View>
      {compact ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.tabs, styles.tabsCompact]}
          contentContainerStyle={styles.tabsCompactContent}
          role="tablist"
        >
          {tabs}
        </ScrollView>
      ) : (
        <View style={[styles.tabs, styles.tabsRow]} role="tablist">
          {tabs}
        </View>
      )}
      {windowed && compact ? (
        <View style={styles.windowRow}>
          <WindowPicker days={days} onDays={onDays} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The window: one track, one thumb. Shared by Growth and Activity, and kept
 * by `Console` so crossing between them keeps the period somebody chose.
 */
export function WindowPicker({
  days,
  onDays,
}: {
  days: number;
  onDays: (days: number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <View style={styles.seg} role="radiogroup" accessibilityLabel="Window">
      {WINDOW_CHOICES.map((choice) => {
        const on = choice === days;
        return (
          <Pressable
            key={choice}
            role="radio"
            aria-checked={on}
            onPress={() => onDays(choice)}
            style={[styles.segItem, compact && styles.segItemCompact, on && styles.segOn]}
            testID={`admin-window-${choice}`}
          >
            <Text style={[styles.segLabel, compact && styles.segLabelCompact, on && styles.segLabelOn]}>
              {choice} days
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    top: {
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
      gap: space.x4,
    },
    titles: { flexShrink: 1, gap: 2 },
    titleCompact: {
      fontSize: touchType.title,
      lineHeight: leading(touchType.title, 1.25),
    },
    subCompact: { fontSize: pointerType.lede, lineHeight: leading(pointerType.lede, 1.5) },

    tabs: { borderBottomWidth: 1, borderBottomColor: colors.line },
    tabsRow: { flexDirection: "row", gap: 22, marginTop: 18 },
    tabsCompact: { marginTop: space.x3, marginHorizontal: -space.x4, flexGrow: 0 },
    tabsCompactContent: { gap: 20, paddingHorizontal: space.x4 },
    tab: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingTop: 10,
      paddingBottom: 11,
    },
    tabLabel: {
      fontSize: pointerType.ui,
      lineHeight: leading(pointerType.ui, 1.55),
      fontWeight: "500",
      color: colors.muted,
    },
    tabLabelCompact: { fontSize: pointerType.lede, lineHeight: leading(pointerType.lede, 1.5) },
    tabOn: { color: colors.text },
    marker: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: -1,
      height: 2,
      borderRadius: radii.pill,
      backgroundColor: colors.accent,
    },
    count: {
      paddingHorizontal: 6,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.warnBorder,
      backgroundColor: colors.warnWash,
    },
    countText: {
      fontSize: pointerType.label,
      lineHeight: leading(pointerType.label, 1.45),
      fontWeight: "600",
      color: colors.warnText,
      fontVariant: ["tabular-nums"],
    },

    windowRow: { marginTop: space.x4, flexDirection: "row" },
    seg: {
      flexDirection: "row",
      gap: 2,
      padding: 2,
      borderRadius: radii.lg,
      backgroundColor: colors.chipFill,
    },
    segItem: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: 5 },
    segItemCompact: { paddingVertical: 5, paddingHorizontal: 14 },
    segOn: {
      backgroundColor: colors.surface,
      boxShadow: `0 0 0 1px ${colors.line}, 0 1px 2px rgba(0,0,0,.06)`,
    },
    segLabel: {
      fontSize: pointerType.meta,
      lineHeight: leading(pointerType.meta, 1.55),
      fontWeight: "500",
      color: colors.muted,
    },
    segLabelCompact: { fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.55) },
    segLabelOn: { color: colors.text },
  });
