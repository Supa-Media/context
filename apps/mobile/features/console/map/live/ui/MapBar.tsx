import { StyleSheet, View } from "react-native";
import { space } from "../../../../design/tokens";
import { useThemedStyles } from "../../../../design/theme";
import type { MapPageState } from "../hooks/useMapPage";
import { Chip, LiveDot, Segmented } from "./controls";
import { SettingsButton } from "./MapDock";

/**
 * The phone's bar over the map: which workspaces (the Columns layout is gone,
 * Dev2 2026-11-05), and the
 * gear for the map's settings, where Replay lives (Dev2, 2026-11-04). While a
 * replay plays, Back to live sits above them. A desktop map has the workspace
 * menu, the gear and the bottom dock instead (`MapDock`).
 */
export function MapBar({ page, onSettings }: { page: MapPageState; onSettings: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.phone} testID="map-bar">
      {page.mode !== "live" ? (
        <View style={styles.phoneRow}>
          <Chip label="Back to live" leading={<LiveDot pulsing={false} reducedMotion={page.reducedMotion} />} onPress={() => page.setMode("live")} testID="map-when-live" />
        </View>
      ) : null}
      <View style={styles.phoneRow}>
        {page.many ? (
          <Segmented
            label="Which workspaces"
            value={page.scope}
            onChange={page.setScope}
            testID="map-scope"
            grow={1.25}
            options={[
              { value: "one", label: "This one" },
              { value: "all", label: "All" },
            ]}
          />
        ) : null}
        <SettingsButton open={false} onPress={onSettings} />
      </View>
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    // Stretched: `PhoneMap` lays the bar over the canvas with `alignItems: "flex-start"`,
    // and tracks that share a row by `flexBasis: 0` have no width of their own.
    phone: { alignSelf: "stretch", gap: space.x2, paddingHorizontal: space.x4, paddingTop: space.x2, paddingBottom: space.x2 },
    phoneRow: { flexDirection: "row", alignItems: "center", gap: space.x2 },
  });
