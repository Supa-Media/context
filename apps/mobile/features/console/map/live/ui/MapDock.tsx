import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Icon } from "../../../../design/components/Icon";
import { Menu } from "../../../../design/components/Menu";
import { Text } from "../../../../design/components/Text";
import { fonts, space, pointerType } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { MapPageState } from "../hooks/useMapPage";
import type { CameraStore } from "./CanvasOverlay";
import { crumbsOf } from "./breadcrumb";
import { LiveDot } from "./controls";
import { replayLabel, replayMenuItems, scopeLabel, trailAfterScope, workspaceMenuItems, workspacePick, type ReplayChoice } from "./mapControls";
import { RangePicker, type Anchor } from "./RangePicker";
import { ReplayBar } from "./ReplayBar";

type Measurable = { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null;

/** Where a button sits in the window, for a menu to hang from. */
function measure(node: unknown, then: (box: Anchor) => void) {
  const view = node as Measurable;
  if (view?.measureInWindow) view.measureInWindow((x, y, width, height) => then({ x, y, width, height }));
  else then({ x: 16, y: 16, width: 0, height: 0 });
}

/**
 * Top left of the desktop map: which workspace is drawn, as one menu with
 * every workspace and "All my workspaces" in it, then where the camera is
 * inside it ("seyi ▾ › Areas"). It stands for the breadcrumb and the two
 * scope pills the bar used to carry. Someone with one workspace has nothing
 * to switch to, so the name is a label and not a button.
 */
export function WorkspaceMenu({
  page,
  camera,
  onSelectWorkspace,
}: {
  page: MapPageState;
  camera: CameraStore;
  onSelectWorkspace: (id: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const node = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const cam = useSyncExternalStore(camera.subscribe, camera.get, camera.get);
  const all = page.scope === "all" && page.many;
  const trail = page.view === "map" && cam !== null ? trailAfterScope(crumbsOf(cam, page.many), all) : [];
  const label = isolateForDisplay(scopeLabel(page));

  const pick = (id: string) => {
    const choice = workspacePick(id);
    if (choice.kind === "all") page.setScope("all");
    else {
      if (choice.workspaceId !== page.selected?.id) onSelectWorkspace(choice.workspaceId);
      page.setScope("one");
    }
    setAnchor(null);
  };

  return (
    <View style={styles.where} pointerEvents="box-none" testID="map-where">
      {page.many ? (
        <Pressable
          ref={node}
          onPress={() => measure(node.current, setAnchor)}
          accessibilityRole="button"
          accessibilityLabel={`Showing ${scopeLabel(page)}. Choose a workspace`}
          accessibilityState={{ expanded: anchor !== null }}
          style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.scope, styles.float, hovered ? styles.hover : null]}
          testID="map-scope"
        >
          <Text style={styles.scopeText} numberOfLines={1}>
            {label}
          </Text>
          <Icon name="chevronDown" size={12} color={colors.text2} />
        </Pressable>
      ) : (
        <View style={[styles.scope, styles.float]} testID="map-scope">
          <Text style={styles.scopeText} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
      {trail.map(({ name, to }, i) => {
        const last = i === trail.length - 1;
        return (
          <View key={`${i}-${name}`} style={styles.crumbItem}>
            <Text style={styles.crumbSep}>›</Text>
            <Pressable
              onPress={() => (to === "scope" ? page.setScope("all") : page.engineRef.current?.zoomTo(to))}
              disabled={last}
              accessibilityRole="button"
              accessibilityState={{ selected: last }}
              accessibilityLabel={last ? `${name}, here` : `Zoom out to ${name}`}
              style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.crumb, !last && hovered ? styles.hover : null]}
              testID="map-crumb"
            >
              <Text style={[styles.crumbText, last && styles.crumbHere]} numberOfLines={1}>
                {isolateForDisplay(name)}
              </Text>
            </Pressable>
          </View>
        );
      })}
      {anchor !== null ? (
        <Menu<string>
          items={workspaceMenuItems(page)}
          title="Show on the map"
          anchor={{ x: anchor.x, y: anchor.y + anchor.height + 4 }}
          onSelect={pick}
          onDismiss={() => setAnchor(null)}
        />
      ) : null}
    </View>
  );
}

/**
 * The bottom of the desktop map: every control in one dock, the way a video
 * player keeps its controls. Live, Replay (the past 24 hours, the past week,
 * or dates of your own), Map or Columns, and zoom. While a replay plays, the
 * replay bar opens inside the same dock above that row, so the scrubber is
 * where the button that started it was. Columns does not zoom, so it has no
 * − and +.
 */
export function MapDock({ page, onHeight }: { page: MapPageState; onHeight?: (height: number) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const replayNode = useRef<View>(null);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [picker, setPicker] = useState<Anchor | null>(null);
  const live = page.mode === "live";

  const choose = (choice: ReplayChoice) => {
    setMenu(null);
    if (choice === "custom") measure(replayNode.current, setPicker);
    else page.setMode(choice);
  };

  return (
    <View
      style={[styles.dock, styles.float, !live && styles.dockOpen]}
      onLayout={(e) => onHeight?.(Math.round(e.nativeEvent.layout.height))}
      testID="map-dock"
    >
      {live ? null : <ReplayBar page={page} docked />}
      <View style={styles.row}>
        <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel="When">
          <DockButton
            label="Live"
            on={live}
            role="radio"
            onPress={() => page.setMode("live")}
            leading={<LiveDot pulsing={live} reducedMotion={page.reducedMotion} />}
            testID="map-when-live"
          />
          <View ref={replayNode} collapsable={false}>
            <DockButton
              label={replayLabel(page)}
              on={!live}
              onPress={() => measure(replayNode.current, setMenu)}
              accessibilityLabel={live ? "Replay what happened" : `Replaying ${replayLabel(page)}. Choose another stretch`}
              leading={<Icon name="clock" size={14} color={live ? colors.text2 : colors.pageSurface} />}
              trailing={<Icon name="chevronDown" size={12} color={live ? colors.text2 : colors.pageSurface} />}
              testID="map-replay"
            />
          </View>
        </View>
        <View style={styles.rule} />
        <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel="Layout">
          <DockButton label="Map" role="radio" on={page.view === "map"} onPress={() => page.setView("map")} testID="map-view-map" />
          <DockButton label="Columns" role="radio" on={page.view === "folders"} onPress={() => page.setView("folders")} testID="map-view-folders" />
        </View>
        {page.view === "map" ? (
          <>
            <View style={styles.rule} />
            <View style={styles.group}>
              <DockButton icon="minus" label="Zoom out" onPress={() => page.engineRef.current?.zoomOut()} testID="map-zoom-out" />
              <DockButton icon="plus" label="Zoom in" onPress={() => page.engineRef.current?.zoomIn()} testID="map-zoom-in" />
            </View>
          </>
        ) : null}
      </View>
      {menu !== null ? (
        <Menu<ReplayChoice>
          items={replayMenuItems(page.mode)}
          title="Replay"
          anchor={{ x: menu.x, y: menu.y - 6 }}
          onSelect={choose}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
      {picker !== null ? <RangePicker page={page} compact={false} anchor={picker} above onClose={() => setPicker(null)} /> : null}
    </View>
  );
}

/** One of the dock's buttons: words, or an icon alone with its name for a screen reader. */
function DockButton({
  label,
  icon,
  on = false,
  role = "button",
  onPress,
  accessibilityLabel,
  leading,
  trailing,
  testID,
}: {
  label: string;
  icon?: "plus" | "minus";
  on?: boolean;
  role?: "button" | "radio";
  onPress: () => void;
  accessibilityLabel?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={role === "radio" ? { checked: on } : undefined}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
        styles.button,
        icon !== undefined && styles.iconButton,
        on ? styles.buttonOn : hovered || pressed ? styles.hover : null,
      ]}
      testID={testID}
    >
      {icon !== undefined ? (
        <Icon name={icon} size={14} color={colors.text2} />
      ) : (
        <>
          {leading}
          <Text style={[styles.buttonText, on && styles.buttonTextOn]} numberOfLines={1}>
            {label}
          </Text>
          {trailing}
        </>
      )}
    </Pressable>
  );
}

/** How far the canvas keeps the camera from the controls over it. */
export const WHERE_INSET = 16 + 32 + 12;
export const DOCK_GAP = 16 + 12;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    float: {
      backgroundColor: colors.pageSurface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      shadowColor: "#000",
      shadowOpacity: 0.14,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 2 },
    },
    hover: { backgroundColor: colors.surface3 },
    where: { position: "absolute", left: 16, top: 16, right: 16, flexDirection: "row", alignItems: "center" },
    scope: {
      height: 32,
      maxWidth: 260,
      borderRadius: 12,
      paddingLeft: 12,
      paddingRight: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexShrink: 0,
    },
    scopeText: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "600", color: colors.text, flexShrink: 1 },
    crumbItem: { flexDirection: "row", alignItems: "center", minWidth: 0, flexShrink: 1 },
    crumbSep: { color: colors.chromeMuted, marginHorizontal: 6, fontSize: pointerType.ui },
    crumb: { height: 28, borderRadius: 8, paddingHorizontal: 6, justifyContent: "center", minWidth: 0 },
    crumbText: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "600", color: colors.text2 },
    crumbHere: { color: colors.text },
    dock: {
      position: "absolute",
      bottom: 16,
      alignSelf: "center",
      maxWidth: "94%",
      borderRadius: 14,
      padding: 6,
      gap: space.x2,
    },
    // Replaying, the dock holds the replay bar too, so it takes most of the canvas's width.
    dockOpen: { width: 860, paddingTop: space.x2 },
    row: { flexDirection: "row", alignItems: "center", alignSelf: "center", gap: 4 },
    group: { flexDirection: "row", alignItems: "center", gap: 2 },
    rule: { width: StyleSheet.hairlineWidth, height: 22, backgroundColor: colors.lineStrong, marginHorizontal: 6 },
    button: { height: 32, borderRadius: 9, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", gap: 7, flexShrink: 0 },
    iconButton: { width: 32, paddingHorizontal: 0, justifyContent: "center" },
    buttonOn: { backgroundColor: colors.text },
    buttonText: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "600", color: colors.text2 },
    buttonTextOn: { color: colors.pageSurface },
  });
