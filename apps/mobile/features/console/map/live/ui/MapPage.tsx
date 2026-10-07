import { useMemo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { fonts, space, pointerType } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import type { ConsoleData } from "../../../types";
import { useMapPage, type MapPageState } from "../hooks/useMapPage";
import { replayBadge } from "../replayClock";
import { MapCanvas, type OpenMapNote } from "./MapCanvas";
import { Breadcrumb, createCameraStore, ZoomControl, type CameraStore } from "./CanvasOverlay";
import { MapBar } from "./MapBar";
import { Feed, MapPanel, WorkingNow } from "./MapPanel";
import { PhoneMap } from "./PhoneMap";
import { ReplayBar } from "./ReplayBar";
import { mapNotice, statusParts } from "./status";


/**
 * The live map, in the document slot: `?map=1` over Browse. The bar of
 * choices across the top, the canvas with where-you-are and the zoom control
 * over it, the replay bar under it while replaying, and the column of who is
 * working and what is happening beside it. A phone gets the canvas with a
 * sheet over it (`PhoneMap`); native, which has no canvas engine yet, gets
 * the words without the picture (`MapWithoutCanvas`).
 */
export type { OpenMapNote };

export function MapPage({ data, compact, onOpenNote }: { data: ConsoleData; compact: boolean; onOpenNote: OpenMapNote }) {
  const page = useMapPage(data);
  const camera = useMemo(() => createCameraStore(), []);
  if (Platform.OS !== "web") return <MapWithoutCanvas page={page} onOpenNote={onOpenNote} />;
  if (compact) return <PhoneMap page={page} camera={camera} onOpenNote={onOpenNote} />;
  return <DesktopMap page={page} camera={camera} onOpenNote={onOpenNote} />;
}

function DesktopMap({ page, camera, onOpenNote }: { page: MapPageState; camera: CameraStore; onOpenNote: OpenMapNote }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.page} testID="map-page">
      <MapBar page={page} compact={false} />
      <View style={styles.body}>
        <View style={styles.column}>
          <View style={styles.canvasBox}>
            <MapCanvas page={page} camera={camera} onOpenNote={onOpenNote} />
            {page.view === "map" ? (
              <>
                <Breadcrumb store={camera} engine={() => page.engineRef.current} />
                <ZoomControl store={camera} engine={() => page.engineRef.current} />
              </>
            ) : null}
            {page.replaying && page.replay !== null ? (
              <View style={styles.badge} pointerEvents="none" testID="map-replay-badge">
                <Text style={styles.badgeText}>{replayBadge(page.replay.range, page.replay.speed)}</Text>
              </View>
            ) : null}
            <MapNotice page={page} />
          </View>
          {page.mode !== "live" ? <ReplayBar page={page} /> : null}
          <StatusLine page={page} />
        </View>
        <MapPanel page={page} onOpenNote={onOpenNote} />
      </View>
    </View>
  );
}


function MapNotice({ page }: { page: MapPageState }) {
  const styles = useThemedStyles(makeStyles);
  const notice = mapNotice(page);
  if (notice === null) return null;
  return (
    <View style={styles.notice} pointerEvents="none" testID="map-notice">
      <Text style={styles.noticeText}>{notice}</Text>
    </View>
  );
}


function StatusLine({ page }: { page: MapPageState }) {
  const styles = useThemedStyles(makeStyles);
  const { left, right } = statusParts(page);
  return (
    <View style={styles.status} testID="map-status">
      {left.map((part, i) => (
        <Text key={`l${i}`} style={[styles.statusText, i === 0 && styles.statusStrong]} numberOfLines={1}>
          {part}
        </Text>
      ))}
      <View style={styles.spacer} />
      {right.map((part) => (
        <Text key={part} style={styles.statusText} numberOfLines={1}>
          {part}
        </Text>
      ))}
    </View>
  );
}

/**
 * Native: the engine draws on a web `<canvas>` and there is no native one yet,
 * so the page says who is working and what is happening — the half of the map
 * that is words — and says in one line where the picture is.
 */
function MapWithoutCanvas({ page, onOpenNote }: { page: MapPageState; onOpenNote: OpenMapNote }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.native} testID="map-page">
      <MapBar page={page} compact />
      <View style={styles.nativeBody}>
        <Text variant="meta" testID="map-native-note">
          The map itself is drawn in the web app for now; here is who is working and what is happening.
        </Text>
        <WorkingNow page={page} />
        {page.mode !== "live" ? <ReplayBar page={page} compact /> : null}
        <Feed items={page.feed} replaying={page.replaying} now={page.now} onOpenNote={onOpenNote} compact />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { flex: 1, minHeight: 0, backgroundColor: colors.pageSurface },
    body: { flex: 1, minHeight: 0, flexDirection: "row" },
    column: { flex: 1, minWidth: 0, minHeight: 0 },
    canvasBox: { flex: 1, minHeight: 0, position: "relative", overflow: "hidden", backgroundColor: colors.surface2 },
    badge: {
      position: "absolute",
      left: 16,
      bottom: 16,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: colors.text,
    },
    badgeText: { fontFamily: fonts.body, fontSize: pointerType.meta, fontWeight: "600", color: colors.pageSurface },
    notice: {
      position: "absolute",
      bottom: 96,
      alignSelf: "center",
      maxWidth: 460,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: colors.pageSurface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    noticeText: { fontFamily: fonts.body, fontSize: pointerType.ui, color: colors.text2, textAlign: "center" },
    status: {
      height: 28,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingHorizontal: space.x4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.lineStrong,
      backgroundColor: colors.pageSurface,
    },
    statusText: { fontFamily: fonts.body, fontSize: pointerType.label, color: colors.chromeMuted },
    statusStrong: { color: colors.text2, fontWeight: "600" },
    spacer: { flex: 1 },
    native: { flex: 1, backgroundColor: colors.pageSurface },
    nativeBody: { padding: space.x4, gap: space.x3 },
  });
