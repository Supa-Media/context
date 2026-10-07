import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { fonts, space, pointerType } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { MapPageState } from "../hooks/useMapPage";
import { replayBadge } from "../replayClock";
import { Breadcrumb, type CameraStore } from "./CanvasOverlay";
import { FollowPanel } from "./FollowPanel";
import { MapBar } from "./MapBar";
import { MapCanvas, type OpenMapNote } from "./MapCanvas";
import { Feed, WorkingNow } from "./MapPanel";
import { ReplayBar } from "./ReplayBar";

/** Rows the folded sheet shows: what is happening now, and no more. */
const FOLDED_ROWS = 2;
const OPEN_ROWS = 8;

/**
 * The map on a phone: the canvas fills the screen, Live / Today / This week
 * float over its top, and a sheet at the bottom says who is working and on
 * what. The sheet folds to the faces and the latest two lines, and opens for
 * the rest; its height is handed to the engine as an inset, so the camera
 * fits the map into the part of the glass the sheet leaves. Pinch, pan and a
 * tap on a face are the engine's.
 */
export function PhoneMap({ page, camera, onOpenNote }: { page: MapPageState; camera: CameraStore; onOpenNote: OpenMapNote }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(0);
  const [bar, setBar] = useState(0);
  const inset = useMemo(() => ({ top: bar, right: 0, bottom: sheet, left: 0 }), [bar, sheet]);
  const following = page.follow !== null;
  return (
    <View style={styles.page} testID="map-page">
      <MapCanvas page={page} camera={camera} onOpenNote={onOpenNote} inset={inset} />
      <View style={styles.top} onLayout={(e) => setBar(Math.round(e.nativeEvent.layout.height))} pointerEvents="box-none">
        <MapBar page={page} compact />
        {page.replaying && page.replay !== null ? (
          <View style={styles.badge} pointerEvents="none" testID="map-replay-badge">
            <Text style={styles.badgeText}>{replayBadge(page.replay.range, page.replay.speed)}</Text>
          </View>
        ) : null}
      </View>
      <View style={[styles.crumbs, { top: bar }]} pointerEvents="box-none">
        <Breadcrumb store={camera} engine={() => page.engineRef.current} />
      </View>
      <View style={styles.sheet} onLayout={(e) => setSheet(Math.round(e.nativeEvent.layout.height))} testID="map-sheet">
        <Pressable
          onPress={() => setOpen((o) => !o)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={open ? "Show less" : "Show more of what is happening"}
          style={styles.grabRow}
          testID="map-sheet-toggle"
        >
          <View style={styles.grab} />
          <Icon name={open ? "chevronDown" : "chevronUp"} size={14} color={colors.chromeMuted} />
        </Pressable>
        {following ? (
          <View style={styles.followRow}>
            <View style={styles.followBody}>
              <FollowPanel page={page} onOpenNote={onOpenNote} />
            </View>
            <Pressable
              onPress={() => page.followActor(null)}
              accessibilityRole="button"
              accessibilityLabel={`Stop following ${page.follow?.name ?? ""}`}
              style={styles.stop}
              testID="map-following"
            >
              <Icon name="close" size={14} color={colors.text} />
            </Pressable>
          </View>
        ) : (
          <>
            <WorkingNow page={page} size={28} />
            <Feed
              items={page.feed.slice(0, open ? OPEN_ROWS : FOLDED_ROWS)}
              replaying={page.replaying}
              now={page.now}
              onOpenNote={onOpenNote}
              compact
            />
          </>
        )}
        {page.mode !== "live" ? <ReplayBar page={page} compact /> : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { flex: 1, minHeight: 0, position: "relative", overflow: "hidden", backgroundColor: colors.surface2 },
    top: { position: "absolute", left: 0, right: 0, top: 0, alignItems: "flex-start" },
    badge: {
      marginLeft: space.x4,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 999,
      backgroundColor: colors.text,
    },
    badgeText: { fontFamily: fonts.body, fontSize: pointerType.meta, fontWeight: "600", color: colors.pageSurface },
    crumbs: { position: "absolute", left: 0, right: 0, height: 60 },
    sheet: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: "70%",
      paddingHorizontal: space.x4,
      paddingBottom: space.x4,
      gap: space.x2,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      backgroundColor: colors.pageSurface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      shadowColor: "#000",
      shadowOpacity: 0.12,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: -2 },
      overflow: "hidden",
    },
    grabRow: { alignItems: "center", paddingTop: 8, paddingBottom: 2, gap: 2 },
    grab: { width: 38, height: 5, borderRadius: 3, backgroundColor: colors.lineStrong },
    followRow: { flexDirection: "row", gap: space.x2 },
    followBody: { flex: 1, minWidth: 0 },
    stop: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 },
  });
