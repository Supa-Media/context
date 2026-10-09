import { useCallback, useRef, useState } from "react";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { MapMode, MapPageState } from "../hooks/useMapPage";
import { dateShort, stretchText } from "../replayClock";
import { Chip, Choice, LiveDot, Segmented } from "./controls";
import { RangePicker, type Anchor } from "./RangePicker";

/**
 * The bar over the map: Live, the past 24 hours, the past week and Custom on
 * the left; on the right, who is being followed, Map / Folders, and — for
 * somebody in more than one workspace — this workspace or all of them. Custom
 * opens the range picker under its chip (a sheet on a phone), and once a
 * custom stretch is playing the chip says which one. A phone has two rows: when
 * (Live, 24h, Week, and a calendar for a custom stretch) and then Map / Folders
 * beside which workspaces.
 */
export function MapBar({ page, compact }: { page: MapPageState; compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [picking, setPicking] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const customNode = useRef<View>(null);
  const closePicker = useCallback(() => setPicking(false), []);
  const live = page.mode === "live";
  const custom = page.mode === "custom";
  const following = page.follow;

  // Opened from the Custom chip, the popover hangs under it; a phone has no chip to measure and gets a sheet.
  const openPicker = () => {
    const node = customNode.current as unknown as { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null;
    if (node?.measureInWindow) {
      node.measureInWindow((x, y, width, height) => {
        setAnchor({ x, y, width, height });
        setPicking(true);
      });
      return;
    }
    setAnchor(null);
    setPicking(true);
  };

  const pick = (next: MapMode) => {
    if (next === "custom") openPicker();
    else page.setMode(next);
  };

  const picker = picking ? <RangePicker page={page} compact={compact} anchor={anchor} onClose={closePicker} /> : null;

  if (compact) {
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
              { value: "folders", label: "Folders" },
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
        {picker}
      </View>
    );
  }
  return (
    <View style={styles.bar} testID="map-bar">
      <Choice
        label="When"
        value={page.mode === "custom" ? null : page.mode}
        onChange={page.setMode}
        testID="map-when"
        options={[
          { value: "live", label: "Live", leading: <LiveDot pulsing={live} reducedMotion={page.reducedMotion} /> },
          { value: "day", label: "Past 24 hours" },
          { value: "week", label: "Past week" },
        ]}
      />
      <View ref={customNode} collapsable={false}>
        <Chip
          role="radio"
          label={custom && page.custom !== null ? stretchText(page.custom) : "Custom"}
          on={custom}
          onPress={openPicker}
          trailing={<Icon name="chevronDown" size={12} color={custom ? colors.pageSurface : colors.text2} />}
          testID="map-custom"
        />
      </View>
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
      {picker}
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
    // Stretched: `PhoneMap` lays the bar over the canvas with `alignItems: "flex-start"`,
    // and tracks that share a row by `flexBasis: 0` have no width of their own.
    phone: { alignSelf: "stretch", gap: space.x2, paddingHorizontal: space.x4, paddingTop: space.x2, paddingBottom: space.x2 },
    phoneRow: { flexDirection: "row", gap: space.x2 },
  });
