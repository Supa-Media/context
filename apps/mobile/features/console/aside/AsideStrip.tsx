import { Pressable, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "../../design/components/Icon";
import { Dot } from "../../design/components/Dot";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { Tex } from "../../chaos/Tex";
import { Text } from "../../design/components/Text";
import { ASIDE_TABS, type AsideTab } from "./tabs";
import { useMapRoute } from "../map/live/MapRouteContext";

/** The rail's icon for each tab that draws one. Tex draws its own figure instead. */
const ICONS: Record<Exclude<AsideTab, "tex">, IconName> = {
  activity: "people",
  note: "file",
  meetings: "calendar",
};

/**
 * The right rail: a slim strip down the right edge with one button per tab,
 * there whether the panel is open or folded (Dev2, 2026-11-20: "the meeting
 * and tex icon just live forever in a thin right column"), so the panel has
 * no tab row of its own. Folded, a press on a tab unfolds the panel on that
 * tab and the chevron at the top unfolds it as it was. Open, the tab showing
 * is filled, a press on it folds the panel (as the chevron, now pointing
 * right, does) and a press on another switches to it. The top bar has no panel button and the strip no rule
 * (Dev2, 2026-11-19: that corner "looks crazy", then "add back" on the
 * chevron). Meetings is drawn in Tex's blue (Dev2, 2026-11-19: "make blue?").
 * The marks the tab row carries (a meeting recording) stay here too, so
 * folding it never hides something running.
 */
export function AsideStrip({
  tabs,
  showing,
  recording,
  open = false,
  waiting = "",
  onUnfold,
  onFold = () => {},
  onSearch = null,
}: {
  tabs: readonly AsideTab[];
  showing: AsideTab;
  recording: boolean;
  /** Whether the panel beside the rail is open; the tab showing is filled only then. */
  open?: boolean;
  /** How many asks wait for a yes, as `pendingCount` words it; rides on Tex, where they are answered. */
  waiting?: string;
  onUnfold: (tab: AsideTab | null) => void;
  onFold?: () => void;
  /** Open the search palette; `null` hides the magnifier (no context open). */
  onSearch?: (() => void) | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  // The live map, where the console provides its route; its button moved here from the file tree's toolbar.
  const mapRoute = useMapRoute();
  return (
    <View style={styles.strip} testID="aside-strip" accessibilityRole={open ? "tablist" : undefined}>
      <Pressable
        onPress={() => (open ? onFold() : onUnfold(null))}
        accessibilityRole="button"
        accessibilityLabel={open ? "Fold the panel" : "Open the panel"}
        style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.button, hovered && styles.hover]}
        testID={open ? "aside-fold" : "aside-unfold"}
      >
        <Icon name={open ? "chevronRight" : "chevronLeft"} size={16} color={colors.text2} />
      </Pressable>
      {/*
        Search and the map ride here too (Dev2, 2026-11-20: "fold a search
        icon in there, and the map icon"), above a rule, so the panels' tabs
        stay one group below it.
      */}
      {onSearch !== null ? (
        <Pressable
          onPress={onSearch}
          accessibilityRole="button"
          accessibilityLabel="Search notes and names"
          style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.button, hovered && styles.hover]}
          testID="aside-strip-search"
        >
          <Icon name="search" size={16} color={colors.text2} />
        </Pressable>
      ) : null}
      {mapRoute !== undefined ? (
        <Pressable
          onPress={mapRoute.toggle}
          accessibilityRole="button"
          accessibilityLabel={mapRoute.open ? "Close the map" : "Map"}
          accessibilityState={{ selected: mapRoute.open }}
          style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.button, mapRoute.open && styles.current, hovered && styles.hover]}
          testID="aside-strip-map"
        >
          <Icon name="liveMap" size={16} color={mapRoute.open ? colors.text : colors.text2} />
        </Pressable>
      ) : null}
      {onSearch !== null || mapRoute !== undefined ? <View style={styles.rule} /> : null}
      {ASIDE_TABS.filter((tab) => tabs.includes(tab.key)).map((tab) => (
        <Pressable
          key={tab.key}
          onPress={() => (open && tab.key === showing ? onFold() : onUnfold(tab.key))}
          // Open, these are the panel's tabs; folded, buttons that open it.
          role={open ? "tab" : "button"}
          accessibilityState={{ selected: open && tab.key === showing }}
          accessibilityLabel={
            tab.key === "meetings" && recording
              ? `${tab.label}, recording`
              : tab.key === "tex" && waiting !== ""
                ? `${tab.label}, ${waiting} waiting`
                : tab.label
          }
          style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.button, open && tab.key === showing && styles.current, hovered && styles.hover]}
          // Open, a tab is the panel's tab (`aside-tab-*`); folded, the strip's.
          testID={open ? `aside-tab-${tab.key}` : `aside-strip-${tab.key}`}
        >
          {tab.key === "tex" ? (
            // Tex's figure, in ink, under the calendar: the rail's one drawing rather than an icon.
            <Tex chaos={0} size={22} testID="aside-strip-tex-figure" />
          ) : (
            <Icon
              name={ICONS[tab.key]}
              size={16}
              color={tab.key === "meetings" ? colors.accent : tab.key === showing ? colors.text : colors.text2}
            />
          )}
          {/* Recording, unless you are already reading Meetings: a mark on what you are looking at says nothing. */}
          {tab.key === "meetings" && recording && !(open && showing === "meetings") ? (
            <View style={styles.dot} testID="aside-tab-meetings-dot">
              <Dot tone="crit" />
            </View>
          ) : null}
          {tab.key === "tex" && waiting !== "" ? (
            <Text variant="treeMeta" style={styles.count} testID="aside-tab-tex-count">
              {waiting}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    strip: { width: 48, alignItems: "center", gap: space.x1, paddingTop: space.x2 },
    button: { width: 36, height: 36, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
    current: { backgroundColor: colors.chrome },
    hover: { backgroundColor: colors.chrome },
    dot: { position: "absolute", top: 6, right: 6 },
    rule: { width: 22, height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space.x1 },
    count: {
      position: "absolute",
      top: -2,
      right: -4,
      minWidth: 16,
      paddingHorizontal: 4,
      borderRadius: radii.pill,
      overflow: "hidden",
      textAlign: "center",
      lineHeight: 16,
      backgroundColor: colors.accent,
      color: colors.ground,
    },
  });
