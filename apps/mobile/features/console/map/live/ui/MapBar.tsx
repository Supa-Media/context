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
 * them. A phone keeps only the first group and the way back; it scrolls
 * sideways rather than wrapping.
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
  if (compact) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.phoneBar} testID="map-bar">
        {when}
        {back}
      </ScrollView>
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
      {page.many ? (
        <Choice
          label="Which workspaces"
          value={page.scope}
          onChange={page.setScope}
          testID="map-scope"
          options={[
            { value: "one", label: "This workspace" },
            { value: "all", label: "All my workspaces" },
          ]}
        />
      ) : null}
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
    phoneBar: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingHorizontal: space.x4, paddingVertical: space.x2 },
  });
