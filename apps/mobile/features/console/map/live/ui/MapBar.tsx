import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { ScrollView, StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { MapPageState } from "../hooks/useMapPage";
import { Chip, Choice, LiveDot } from "./controls";

/**
 * The bar over the map: Live / Today / This week on the left; on the right,
 * who is being followed, the way back to live while replaying, Map / Folders,
 * and — for somebody in more than one workspace — this workspace or all of
 * them. A phone has two rows, when and the way back over Map / Folders and
 * which workspaces, and each scrolls sideways rather than wrapping.
 */
export function MapBar({ page, compact }: { page: MapPageState; compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const live = page.mode === "live";
  const following = page.follow;
  const when = (
    <Choice
      label="When"
      value={page.mode}
      onChange={page.setMode}
      testID="map-when"
      options={[
        { value: "live", label: "Live", leading: <LiveDot pulsing={live} reducedMotion={page.reducedMotion} /> },
        { value: "today", label: "Today" },
        { value: "week", label: "This week" },
      ]}
    />
  );
  const back = live ? null : (
    <Chip label="Back to live" onPress={() => page.setMode("live")} testID="map-back-to-live" />
  );
  const layout = (
    <Choice
      label="Layout"
      value={page.view}
      onChange={page.setView}
      testID="map-view"
      options={[
        { value: "map", label: "Map" },
        { value: "folders", label: "Folders" },
      ]}
    />
  );
  const which = page.many ? (
    <Choice
      label="Which workspaces"
      value={page.scope}
      onChange={page.setScope}
      testID="map-scope"
      options={[
        { value: "one", label: "This workspace" },
        { value: "all", label: compact ? "All" : "All my workspaces" },
      ]}
    />
  ) : null;
  if (compact) {
    return (
      <View testID="map-bar">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.phoneBar}>
          {when}
          {back}
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.phoneRow2}>
          {layout}
          {which}
        </ScrollView>
      </View>
    );
  }
  return (
    <View style={styles.bar} testID="map-bar">
      {when}
      <View style={styles.spacer} />
      {following !== null ? (
        <Chip
          on
          label={`Following: ${isolateForDisplay(following.name)}`}
          accessibilityLabel={`Stop following ${following.name}`}
          trailing={<Icon name="close" size={12} color={colors.pageSurface} />}
          onPress={() => page.followActor(null)}
          testID="map-following"
        />
      ) : null}
      {back}
      {layout}
      {which}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    bar: {
      height: 54,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.lineStrong,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: 18,
      backgroundColor: colors.pageSurface,
    },
    spacer: { flex: 1 },
    phoneBar: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingHorizontal: space.x4, paddingTop: space.x2, paddingBottom: space.x1 },
    phoneRow2: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingHorizontal: space.x4, paddingBottom: space.x2 },
  });
