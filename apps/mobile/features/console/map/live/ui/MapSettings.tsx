import { useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { fonts, pointerType, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { MapMode, MapPageState } from "../hooks/useMapPage";
import { LOOK_RANGES, type MapLook } from "../look";
import { LiveDot } from "./controls";
import { LookSlider } from "./LookSlider";
import { RangePicker, type Anchor } from "./RangePicker";

/**
 * The map's settings (Dev2, 2026-11-04: "Obsidian has a setting button to the
 * right of the map"; "move the map replay stuff into the settings"). Opened
 * from the gear in the canvas's top right on a computer, and from the bar on
 * a phone. Every choice is kept on the account (`useMapLook`), so the map
 * opens the same way everywhere.
 *
 * Plain words for what each choice does to the drawing; no setting here
 * changes who can see what.
 */

type Opt<T extends string> = { value: T; label: string };

const BOARDS: ReadonlyArray<Opt<MapLook["board"]>> = [
  { value: "auto", label: "Follow theme" },
  { value: "paper", label: "Paper" },
  { value: "graph", label: "Graph paper" },
  { value: "kraft", label: "Brown paper" },
  { value: "chalk", label: "Chalkboard" },
  { value: "blueprint", label: "Blueprint" },
];

const NAMES: ReadonlyArray<Opt<MapLook["names"]>> = [
  { value: "busy", label: "Busiest first" },
  { value: "all", label: "All that fit" },
  { value: "hover", label: "Only what's happening" },
];

const READING: ReadonlyArray<Opt<MapLook["reading"]>> = [
  { value: "circle", label: "Pencil circle" },
  { value: "pulse", label: "Pulse" },
  { value: "halo", label: "Halo" },
];

const OPENING: ReadonlyArray<Opt<MapLook["opening"]>> = [
  { value: "sketch", label: "Sketched in" },
  { value: "bloom", label: "Bloom" },
  { value: "order", label: "Folder by folder" },
  { value: "zoom", label: "Zoom in from everything" },
];

const WHEN: ReadonlyArray<Opt<Exclude<MapMode, "custom">> & { live?: boolean }> = [
  { value: "live", label: "Live", live: true },
  { value: "day", label: "Past 24 hours" },
  { value: "week", label: "Past week" },
];

export function MapSettings({ page, compact, onClose }: { page: MapPageState; compact: boolean; onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { look, setLook } = page;
  const pickNode = useRef<View>(null);
  const [picker, setPicker] = useState<Anchor | null>(null);

  const openPicker = () => {
    const node = pickNode.current as unknown as { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null;
    if (node?.measureInWindow) node.measureInWindow((x, y, width, height) => setPicker({ x, y, width, height }));
    else setPicker({ x: 16, y: 16, width: 0, height: 0 });
  };

  return (
    <View style={[styles.panel, compact && styles.sheet]} testID="map-settings">
      <View style={styles.top}>
        <Text style={styles.title}>Map settings</Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the map settings" hitSlop={8} style={styles.close} testID="map-settings-close">
          <Icon name="close" size={14} color={colors.text2} />
        </Pressable>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
        <Section title="Replay">
          <Choices
            label="When"
            options={WHEN.map((w) => ({ value: w.value, label: w.label, leading: w.live ? <LiveDot pulsing={page.mode === "live"} reducedMotion={page.reducedMotion} /> : null }))}
            value={page.mode === "custom" ? null : page.mode}
            onChange={(mode) => page.setMode(mode)}
            testID="map-settings-when"
          />
          <View ref={pickNode} collapsable={false} style={styles.pickRow}>
            <Pill label={page.mode === "custom" ? "Other dates…" : "Pick dates…"} on={page.mode === "custom"} onPress={openPicker} testID="map-settings-pick-dates" />
          </View>
        </Section>

        <Section title="Board">
          <Choices label="Board" options={BOARDS} value={look.board} onChange={(board) => setLook({ board })} testID="map-settings-board" />
        </Section>

        <Section title="Pencil">
          <LookSlider label="Neat to messy" value={look.sketch} min={LOOK_RANGES.sketch[0]} max={LOOK_RANGES.sketch[1]} step={0.05} onChange={(sketch) => setLook({ sketch })} testID="map-settings-sketch" />
          <LookSlider label="Line thickness" value={look.lineWidth} min={LOOK_RANGES.lineWidth[0]} max={LOOK_RANGES.lineWidth[1]} step={0.05} onChange={(lineWidth) => setLook({ lineWidth })} testID="map-settings-line" />
        </Section>

        <Section title="Dots">
          <LookSlider label="Dot size" value={look.dotSize} min={LOOK_RANGES.dotSize[0]} max={LOOK_RANGES.dotSize[1]} step={0.05} onChange={(dotSize) => setLook({ dotSize })} testID="map-settings-dot" />
          <LookSlider label="Spread" value={look.spread} min={LOOK_RANGES.spread[0]} max={LOOK_RANGES.spread[1]} step={0.05} onChange={(spread) => setLook({ spread })} testID="map-settings-spread" />
        </Section>

        <Section title="Names">
          <Choices label="Which names" options={NAMES} value={look.names} onChange={(names) => setLook({ names })} testID="map-settings-names" />
          <LookSlider label="Text size" value={look.textSize} min={LOOK_RANGES.textSize[0]} max={LOOK_RANGES.textSize[1]} step={1} digits={0} onChange={(textSize) => setLook({ textSize })} testID="map-settings-text" />
        </Section>

        <Section title="Reading">
          <Choices label="When someone reads a note" options={READING} value={look.reading} onChange={(reading) => setLook({ reading })} testID="map-settings-reading" />
        </Section>

        <Section title="Motion">
          <Choices label="When the map opens" options={OPENING} value={look.opening} onChange={(opening) => setLook({ opening })} testID="map-settings-opening" />
        </Section>

        <View style={styles.foot}>
          <Pill label="Restore defaults" onPress={page.resetLook} testID="map-settings-reset" />
          <Text style={styles.note}>Kept on your account, so the map opens the same way on every computer and phone.</Text>
        </View>
      </ScrollView>
      {picker !== null ? <RangePicker page={page} compact={compact} anchor={picker} onClose={() => setPicker(null)} /> : null}
    </View>
  );
}

/** A titled group of settings that folds away. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [open, setOpen] = useState(true);
  return (
    <View style={styles.section}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        style={styles.sectionHead}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} color={colors.muted} />
        <Text style={styles.sectionTitle}>{title}</Text>
      </Pressable>
      {open ? <View style={styles.sectionBody}>{children}</View> : null}
    </View>
  );
}

/** Pick one of a few, as a wrapping row of pills. */
function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
  testID,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string; leading?: ReactNode }>;
  value: T | null;
  onChange: (value: T) => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={label} testID={testID}>
      {options.map((o) => (
        <Pill key={o.value} label={o.label} on={o.value === value} role="radio" leading={o.leading} onPress={() => onChange(o.value)} testID={testID ? `${testID}-${o.value}` : undefined} />
      ))}
    </View>
  );
}

function Pill({
  label,
  on = false,
  role = "button",
  leading,
  onPress,
  testID,
}: {
  label: string;
  on?: boolean;
  role?: "button" | "radio";
  leading?: ReactNode;
  onPress: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={role === "radio" ? { checked: on } : undefined}
      aria-checked={role === "radio" ? on : undefined}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.pill, on ? styles.pillOn : hovered ? styles.pillHover : null]}
      testID={testID}
    >
      {leading}
      <Text style={[styles.pillText, on && styles.pillTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** How wide the panel is beside the map on a computer. */
export const SETTINGS_W = 300;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      width: SETTINGS_W,
      backgroundColor: colors.pageSurface,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: colors.lineStrong,
    },
    sheet: {
      top: undefined,
      left: 0,
      width: undefined,
      height: "70%",
      borderLeftWidth: 0,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.lineStrong,
      borderTopLeftRadius: 14,
      borderTopRightRadius: 14,
    },
    top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.x4, paddingTop: space.x4, paddingBottom: space.x2 },
    title: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "700", color: colors.text },
    close: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
    scroll: { flex: 1 },
    body: { paddingBottom: space.x6 },
    section: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong, paddingHorizontal: space.x4, paddingVertical: space.x2 },
    sectionHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
    sectionTitle: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "700", color: colors.text },
    sectionBody: { paddingBottom: space.x2, gap: 4 },
    choices: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingVertical: 4 },
    pickRow: { flexDirection: "row" },
    pill: {
      height: 28,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    pillOn: { backgroundColor: colors.text, borderColor: colors.text },
    pillHover: { backgroundColor: colors.surface3 },
    pillText: { fontFamily: fonts.body, fontSize: pointerType.meta, fontWeight: "600", color: colors.text },
    pillTextOn: { color: colors.pageSurface },
    foot: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong, padding: space.x4, gap: space.x2, alignItems: "flex-start" },
    note: { fontFamily: fonts.body, fontSize: pointerType.meta, color: colors.muted },
  });
