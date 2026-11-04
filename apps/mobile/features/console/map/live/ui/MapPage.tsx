import { useEffect, useMemo, useState } from "react";
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
import { DOCK_GAP, MapDock, SettingsButton, WHERE_INSET, WorkspaceMenu } from "./MapDock";
import { MapSettings } from "./MapSettings";
import { MapActivity, MapColumn, MapNote } from "./MapPanel";
import { useMapSideStore, useOfferMapSide } from "../../../aside/mapSide";
import { useFrame } from "../../../../app/AppFrame";
import { PhoneMap } from "./PhoneMap";
import { mapNotice } from "./status";


/**
 * The live map, in the document slot: `?map=1` over Browse. The canvas takes
 * the whole height, with which workspace in its top left and one dock of
 * controls at its bottom (`MapDock`, which holds the replay bar while
 * replaying). Who is working, what is happening and the clicked note are tabs
 * of the console's right panel (`mapSide.tsx`), hidden with it. A phone gets the canvas with a
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
  const [dock, setDock] = useState(44);
  const inset = useMemo(() => ({ top: WHERE_INSET, right: 16, bottom: dock + DOCK_GAP, left: 16 }), [dock]);
  const following = page.follow;
  const [settings, setSettings] = useState(false);
  // The console's right panel holds the map's tabs; with no console (a harness) the map keeps its own column.
  const ownColumn = useMapSideStore() === null;
  const open = peek.peek;
  const noteKey = open === null ? null : `${open.workspaceId}\n${open.path}`;
  useOfferMapSide({
    activity: <MapActivity page={page} onOpenNote={onOpenNote} />,
    note: <MapNote page={page} peek={peek} onOpenNote={onOpenNote} />,
    noteKey,
  });
  // A note clicked with the panel shut opens it, beside the map, where there is room for a column.
  const frame = useFrame();
  const asideShut = !frame.state.asideOpen;
  const toggleAside = frame.toggleAside;
  const wide = frame.density === "wide";
  useEffect(() => {
    if (noteKey !== null && asideShut && wide) toggleAside();
    // Only a new note opens it: the panel shut by hand with a note open stays shut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteKey]);
  return (
    <View style={styles.page} testID="map-page">
      <View style={styles.body}>
        <View style={styles.column}>
          <View style={styles.canvasBox}>
            <MapCanvas page={page} camera={camera} peek={peek} inset={inset} />
            <WorkspaceMenu page={page} camera={camera} onSelectWorkspace={onSelectWorkspace} />
            {settings ? null : (
              <View style={styles.gear}>
                <SettingsButton open={false} onPress={() => setSettings(true)} />
              </View>
            )}
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
            {settings ? (
              <MapSettings
                page={page}
                compact={false}
                onClose={() => setSettings(false)}
                onFind={(note) => {
                  page.engineRef.current?.focusPath(note.workspaceId, note.path);
                  peek.onTapNote({ ...note, at: null });
                }}
              />
            ) : null}
          </View>
        </View>
        {ownColumn ? <MapColumn page={page} peek={peek} onOpenNote={onOpenNote} /> : null}
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
    following: { position: "absolute", right: 16 + 34 + 10, top: 16 },
    gear: { position: "absolute", right: 16, top: 16, zIndex: 3 },
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
