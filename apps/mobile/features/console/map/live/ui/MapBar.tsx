import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { space } from "../../../../design/tokens";
import { useColors, useThemedStyles } from "../../../../design/theme";
import type { MapMode, MapPageState } from "../hooks/useMapPage";
import { dateShort } from "../replayClock";
import { LiveDot, Segmented } from "./controls";
import { RangePicker } from "./RangePicker";

/**
 * The phone's bar over the map: two rows of tracks, when (Live, 24h, Week,
 * and a calendar for a custom stretch) and then Map / Columns beside which
 * workspaces. The calendar opens the range picker as a sheet. A desktop map
 * has the workspace menu and the bottom dock instead (`MapDock`).
 */
export function MapBar({ page }: { page: MapPageState }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [picking, setPicking] = useState(false);
  const closePicker = useCallback(() => setPicking(false), []);
  const live = page.mode === "live";
  const custom = page.mode === "custom";

  const pick = (next: MapMode) => {
    if (next === "custom") setPicking(true);
    else page.setMode(next);
  };

  const calendarOn = custom && page.custom !== null;
  const whenOptions = [
    { value: "live" as const, label: "Live", leading: <LiveDot pulsing={live} reducedMotion={page.reducedMotion} /> },
    { value: "day" as const, label: "24h" },
    { value: "week" as const, label: "Week" },
    {
      value: "custom" as const,
      label: calendarOn ? dateShort(page.custom!.from) : "",
      accessibilityLabel: "Pick a stretch of time",
      leading: <Icon name="calendar" size={14} color={custom ? colors.pageSurface : colors.text2} />,
    },
  ];
  return (
    <View style={styles.phone} testID="map-bar">
      <View style={styles.phoneRow}>
        <Segmented label="When" value={page.mode} onChange={pick} testID="map-when" options={whenOptions} />
      </View>
      <View style={styles.phoneRow}>
        <Segmented
          label="Layout"
          value={page.view}
          onChange={page.setView}
          testID="map-view"
          options={[
            { value: "map", label: "Map" },
            { value: "folders", label: "Columns" },
          ]}
        />
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
      </View>
      {picking ? <RangePicker page={page} compact anchor={null} onClose={closePicker} /> : null}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    // Stretched: `PhoneMap` lays the bar over the canvas with `alignItems: "flex-start"`,
    // and tracks that share a row by `flexBasis: 0` have no width of their own.
    phone: { alignSelf: "stretch", gap: space.x2, paddingHorizontal: space.x4, paddingTop: space.x2, paddingBottom: space.x2 },
    phoneRow: { flexDirection: "row", gap: space.x2 },
  });
