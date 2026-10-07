import { useSyncExternalStore } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Text } from "../../../../design/components/Text";
import { fonts, space, pointerType } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import type { CameraDetail, MapEngine } from "../engine";
import type { ZoomLevel } from "../types";
import { RoundButton } from "./controls";

/**
 * Where the camera is, told by the engine on every frame it moves. A store
 * rather than page state, so a camera flight redraws the breadcrumb and the
 * zoom control and nothing else on the page.
 */
export type CameraStore = {
  set(info: CameraDetail): void;
  get(): CameraDetail | null;
  subscribe(listener: () => void): () => void;
};

export function createCameraStore(): CameraStore {
  let current: CameraDetail | null = null;
  const listeners = new Set<() => void>();
  return {
    set(info) {
      current = info;
      for (const l of listeners) l();
    },
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const ORDER: ZoomLevel[] = ["all", "workspace", "folders", "notes"];

/** What the zoom control calls each level. */
export const LEVEL_LABELS: Record<ZoomLevel, string> = {
  all: "All workspaces",
  workspace: "Workspace",
  folders: "Folders",
  notes: "Notes",
};

/** The levels this camera can stop at, far to near: the trail's crumbs map onto these in order. */
export function levelsOf(camera: Pick<CameraDetail, "stops">): ZoomLevel[] {
  return ORDER.filter((level) => camera.stops[level] !== undefined);
}

/** Top left: where you are, far to near. A crumb zooms back out to it. */
export function Breadcrumb({ store, engine }: { store: CameraStore; engine: () => MapEngine | null }) {
  const styles = useThemedStyles(makeStyles);
  const camera = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (camera === null || camera.trail.length === 0) return null;
  const levels = levelsOf(camera);
  return (
    <View style={styles.crumbs} accessibilityRole="toolbar" accessibilityLabel="Where you are on the map" testID="map-breadcrumb">
      {camera.trail.map((name, i) => {
        const last = i === camera.trail.length - 1;
        const level = levels[i];
        return (
          <View key={`${i}-${name}`} style={styles.crumbItem}>
            {i > 0 ? <Text style={styles.crumbSep}>›</Text> : null}
            <Pressable
              onPress={() => (level === undefined ? undefined : engine()?.zoomTo(level))}
              disabled={last}
              accessibilityRole="button"
              accessibilityState={{ selected: last }}
              accessibilityLabel={last ? `${name}, here` : `Zoom out to ${name}`}
              style={[styles.crumb, last && styles.crumbHere]}
              testID="map-crumb"
            >
              <Text style={[styles.crumbText, last && styles.crumbTextHere]} numberOfLines={1}>
                {isolateForDisplay(name)}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

/** Bottom right: − and +, and a track with the four levels named on it. */
export function ZoomControl({ store, engine }: { store: CameraStore; engine: () => MapEngine | null }) {
  const styles = useThemedStyles(makeStyles);
  const camera = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (camera === null) return null;
  const levels = levelsOf(camera);
  const knob = Math.max(0, Math.min(1, camera.zoom));
  return (
    <View style={styles.zoom} testID="map-zoom">
      <RoundButton icon="minus" label="Zoom out" onPress={() => engine()?.zoomOut()} size={28} testID="map-zoom-out" />
      <View style={styles.zoomTrack}>
        <View style={styles.zoomLine} />
        {levels.map((level) => {
          const at = camera.stops[level] ?? 0;
          const here = camera.level === level;
          return (
            <Pressable
              key={level}
              onPress={() => engine()?.zoomTo(level)}
              accessibilityRole="button"
              accessibilityState={{ selected: here }}
              accessibilityLabel={`Zoom to ${LEVEL_LABELS[level].toLowerCase()}`}
              style={[styles.stop, { left: `${at * 100}%` }]}
              testID={`map-zoom-${level}`}
            >
              <View style={styles.stopDot} />
              <Text style={[styles.stopText, here && styles.stopTextHere]} numberOfLines={1}>
                {LEVEL_LABELS[level]}
              </Text>
            </Pressable>
          );
        })}
        <View style={[styles.knob, { left: `${knob * 100}%` }]} pointerEvents="none">
          <View style={styles.knobCore} />
        </View>
      </View>
      <RoundButton icon="plus" label="Zoom in" onPress={() => engine()?.zoomIn()} size={28} testID="map-zoom-in" />
    </View>
  );
}

export const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    crumbs: { position: "absolute", left: 16, top: 16, flexDirection: "row", alignItems: "center", flexWrap: "wrap", maxWidth: "70%" },
    crumbItem: { flexDirection: "row", alignItems: "center" },
    crumbSep: { color: colors.chromeMuted, marginHorizontal: 6, fontSize: pointerType.ui },
    crumb: {
      height: 30,
      borderRadius: 15,
      paddingHorizontal: 11,
      justifyContent: "center",
      backgroundColor: colors.pageSurface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    crumbHere: { backgroundColor: colors.text, borderColor: colors.text },
    crumbText: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "600", color: colors.text2 },
    crumbTextHere: { color: colors.pageSurface },
    zoom: {
      position: "absolute",
      right: 16,
      bottom: 16,
      width: 372,
      height: 64,
      borderRadius: 14,
      backgroundColor: colors.pageSurface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      flexDirection: "row",
      alignItems: "flex-start",
      paddingTop: 10,
      paddingHorizontal: space.x3,
      gap: space.x3,
      shadowColor: "#000",
      shadowOpacity: 0.12,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 2 },
    },
    zoomTrack: { flex: 1, height: 44, marginHorizontal: space.x3 },
    zoomLine: { position: "absolute", left: 0, right: 0, top: 12, height: 3, borderRadius: 2, backgroundColor: colors.lineStrong },
    stop: { position: "absolute", top: 6, width: 90, marginLeft: -45, alignItems: "center", gap: 7 },
    stopDot: { width: 6, height: 6, borderRadius: 3, marginTop: 4, backgroundColor: colors.chromeMuted },
    stopText: { fontFamily: fonts.body, fontSize: pointerType.label, color: colors.chromeMuted },
    stopTextHere: { color: colors.text, fontWeight: "700" },
    knob: {
      position: "absolute",
      top: 5,
      width: 16,
      height: 16,
      marginLeft: -8,
      borderRadius: 8,
      backgroundColor: colors.text,
      alignItems: "center",
      justifyContent: "center",
    },
    knobCore: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.pageSurface },
  });
