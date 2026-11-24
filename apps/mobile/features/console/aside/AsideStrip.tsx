import { Pressable, StyleSheet, View } from "react-native";
import { AccessoryGlyph, type AccessoryGlyphName } from "../files/AccessoryGlyph";
import { Dot } from "../../design/components/Dot";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { Tex } from "../../chaos/Tex";
import { Text } from "../../design/components/Text";
import { ASIDE_TABS, type AsideTab } from "./tabs";
import { useMapRoute } from "../map/live/MapRouteContext";

/**
 * The rail's drawing for each tab that has one; Tex draws its own figure
 * instead. Every button on the rail is drawn in Context's brush and Tex's
 * blue, as the file tree's own folders are (Dev2, 2026-11-21 roast: "the icons
 * on the right need to match our iconography on the left").
 */
const ICONS: Record<Exclude<AsideTab, "tex">, AccessoryGlyphName> = {
  activity: "people",
  note: "page",
  area: "page",
  meetings: "calendar",
  vault: "key",
};
/** The drawn rail's icon size: the file tree's folder icons' own. */
const GLYPH = 18;

/**
 * The right rail: a slim strip down the right edge with one button per tab,
 * there whether the panel is open or folded (Dev2, 2026-11-20: "the meeting
 * and tex icon just live forever in a thin right column"), so the panel has
 * no tab row of its own. Folded, a press on a tab unfolds the panel on that
 * tab and the panel button at the top unfolds it as it was. Open, the tab
 * showing is filled, a press on it folds the panel (as the panel button does)
 * and a press on another switches to it. The panel button mirrors the left
 * sidebar's own toggle, and a hairline divides the strip from the open panel
 * (Dev2, 2026-11-21 roast). Meetings is drawn in Tex's blue (Dev2, 2026-11-19:
 * "make blue?").
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
  vaultWaiting = false,
}: {
  /** An AI waits for a yes on one of the vault's keys (its first use, or a card at a checkout). */
  vaultWaiting?: boolean;
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
    <View style={[styles.strip, open && styles.stripBeside]} testID="aside-strip" accessibilityRole={open ? "tablist" : undefined}>
      <Pressable
        onPress={() => (open ? onFold() : onUnfold(null))}
        accessibilityRole="button"
        accessibilityLabel={open ? "Hide the side panel" : "Show the side panel"}
        style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.button, hovered && styles.hover]}
        testID={open ? "aside-fold" : "aside-unfold"}
      >
        {/* The left sidebar's toggle, mirrored, for parity (Dev2, 2026-11-21 roast: "the arrow doesn't really work here"). */}
        <AccessoryGlyph name="panelRight" size={GLYPH} color={colors.accent} />
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
          <AccessoryGlyph name="search" size={GLYPH} color={colors.accent} />
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
          <AccessoryGlyph name="links" size={GLYPH} color={colors.accent} />
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
            <AccessoryGlyph name={ICONS[tab.key]} size={GLYPH} color={colors.accent} />
          )}
          {/* Recording, unless you are already reading Meetings: a mark on what you are looking at says nothing. */}
          {tab.key === "meetings" && recording && !(open && showing === "meetings") ? (
            <View style={styles.dot} testID="aside-tab-meetings-dot">
              <Dot tone="crit" />
            </View>
          ) : null}
          {/* A key's ask waits for a yes: the vault is marked as the approved prototype drew it, until it is the tab showing. */}
          {tab.key === "vault" && vaultWaiting && !(open && showing === "vault") ? (
            <View style={styles.dot} testID="aside-tab-vault-dot">
              <Dot tone="warn" />
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
    // Beside the open panel, a hairline between the rail and the panel, so the chat reads as its own column (Dev2, 2026-11-21 roast).
    stripBeside: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
    button: { width: 36, height: 36, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
    // The tree's selected-row fill: `chrome` is the rail's own ground on paper, so a current tab drew nothing there.
    current: { backgroundColor: colors.rowSelected },
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
