import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Text } from "../../../../design/components/Text";
import { fonts, pointerType } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { ConsoleData } from "../../../types";
import { useMapPage, type MapPageState } from "../hooks/useMapPage";
import { useMapPeek, type MapPeek } from "../hooks/useMapPeek";
import { Icon } from "../../../../design/components/Icon";
import { MapCanvas, type OpenMapNote } from "./MapCanvas";
import { createCameraStore, type CameraStore } from "./CanvasOverlay";
import { Chip } from "./controls";
import { DOCK_GAP, MapDock, WHERE_INSET, WorkspaceMenu } from "./MapDock";
import { MapPanel } from "./MapPanel";
import { NotePeek } from "./NotePeek";
import { PhoneMap } from "./PhoneMap";
import { mapNotice } from "./status";


/**
 * The live map, in the document slot: `?map=1` over Browse. The canvas takes
 * the whole height, with which workspace in its top left and one dock of
 * controls at its bottom (`MapDock`, which holds the replay bar while
 * replaying), and the column of who is working and what is happening beside
 * it. A phone gets the canvas with a
 * sheet over it (`PhoneMap`). In the native app the canvas is the same
 * engine inside a web view (`LiveMapCanvas.tsx`), so every layout is the
 * same on every platform.
 */
export type { OpenMapNote };

export function MapPage({ data, compact, onOpenNote }: { data: ConsoleData; compact: boolean; onOpenNote: OpenMapNote }) {
  const page = useMapPage(data);
  const camera = useMemo(() => createCameraStore(), []);
  const peek = useMapPeek(page);
  if (compact) return <PhoneMap page={page} camera={camera} peek={peek} onOpenNote={onOpenNote} />;
  return <DesktopMap page={page} camera={camera} peek={peek} onOpenNote={onOpenNote} onSelectWorkspace={data.selectContext} />;
}

function DesktopMap({
  page,
  camera,
  peek,
  onOpenNote,
  onSelectWorkspace,
}: {
  page: MapPageState;
  camera: CameraStore;
  peek: MapPeek;
  onOpenNote: OpenMapNote;
  onSelectWorkspace: (id: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [dock, setDock] = useState(44);
  const inset = useMemo(() => ({ top: WHERE_INSET, right: 16, bottom: dock + DOCK_GAP, left: 16 }), [dock]);
  const open = peek.peek;
  const following = page.follow;
  return (
    <View style={styles.page} testID="map-page">
      <View style={styles.body}>
        <View style={styles.column}>
          <View
            style={styles.canvasBox}
            onLayout={(e) => setBox({ width: Math.round(e.nativeEvent.layout.width), height: Math.round(e.nativeEvent.layout.height) })}
          >
            <MapCanvas page={page} camera={camera} peek={peek} inset={inset} />
            <WorkspaceMenu page={page} camera={camera} onSelectWorkspace={onSelectWorkspace} />
            {following !== null ? (
              <View style={styles.following}>
                <Chip
                  on
                  label={`Following: ${isolateForDisplay(following.name)}`}
                  accessibilityLabel={`Stop following ${following.name}`}
                  trailing={<Icon name="close" size={12} color={colors.pageSurface} />}
                  onPress={() => page.followActor(null)}
                  testID="map-following"
                />
              </View>
            ) : null}
            <MapDock page={page} onHeight={setDock} />
            <MapNotice page={page} bottom={dock + DOCK_GAP} />
            {open !== null && box.width > 0 ? (
              <NotePeek
                page={page}
                peek={open}
                compact={false}
                box={box}
                onClose={peek.close}
                onExpand={() => onOpenNote(open.workspaceId, open.path)}
                onPeek={peek.onTapNote}
              />
            ) : null}
          </View>
        </View>
        <MapPanel page={page} onOpenNote={onOpenNote} />
      </View>
    </View>
  );
}


function MapNotice({ page, bottom }: { page: MapPageState; bottom: number }) {
  const styles = useThemedStyles(makeStyles);
  const notice = mapNotice(page);
  if (notice === null) return null;
  return (
    <View style={[styles.notice, { bottom }]} pointerEvents="none" testID="map-notice">
      <Text style={styles.noticeText}>{notice}</Text>
    </View>
  );
}


const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { flex: 1, minHeight: 0, backgroundColor: colors.pageSurface },
    body: { flex: 1, minHeight: 0, flexDirection: "row" },
    column: { flex: 1, minWidth: 0, minHeight: 0 },
    canvasBox: { flex: 1, minHeight: 0, position: "relative", overflow: "hidden", backgroundColor: colors.surface2 },
    following: { position: "absolute", right: 16, top: 16 },
    notice: {
      position: "absolute",
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
  });
