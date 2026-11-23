import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { G, Path, Polyline, Circle, Svg } from "react-native-svg";
import { Text } from "../../features/design/components/Text";
import { Dot } from "../../features/design/components/Dot";
import { Icon } from "../../features/design/components/Icon";
import { PersonFace } from "../../features/console/faces/PersonFace";
import { Tex } from "../../features/chaos/Tex";
import { useColors, useThemedStyles, type Colors } from "../../features/design/theme";
import { radii, space } from "../../features/design/tokens";
import {
  JOB_ICON_VIEW_BOX,
  drawnStrokes,
  inkFor,
  type Stroke,
} from "../../features/console/files/jobIcons/geometry";
import type { Health, Owner } from "./data";

/* ----------------------------- the rail glyph ----------------------------- */

const rect = (x: number, y: number, w: number, h: number): Stroke => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
  [x, y - 2],
];

/** A small org chart, one box over two, in Context's brush. */
const AREAS_GLYPH: readonly Stroke[] = [
  rect(36, 14, 28, 20),
  [[50, 34], [50, 50]],
  [[22, 50], [78, 50]],
  [[22, 50], [22, 62]],
  [[78, 50], [78, 62]],
  rect(10, 62, 24, 20),
  rect(66, 62, 24, 20),
];

export function AreasGlyph({ size, color }: { size: number; color: string }) {
  const strokes = drawnStrokes("accessory:areas", "areas", AREAS_GLYPH);
  const { width, dryWidth, dryOpacity } = inkFor(size);
  return (
    <Svg width={size} height={size} viewBox={JOB_ICON_VIEW_BOX} fill="none">
      <G stroke={color} strokeLinecap="round" strokeLinejoin="round" fill="none">
        {strokes.map((stroke, index) => (
          <G key={index}>
            <Path d={stroke.d} strokeWidth={width} />
            {dryWidth === undefined ? null : <Path d={stroke.dry} strokeWidth={dryWidth} opacity={dryOpacity} />}
          </G>
        ))}
      </G>
    </Svg>
  );
}

/* ------------------------------ health inks ------------------------------- */

export function healthInk(colors: Colors, health: Health): string {
  if (health === "ok") return colors.ok;
  if (health === "warn") return colors.warn;
  if (health === "crit") return colors.crit;
  return colors.chromeMuted;
}

export function Sparkline({ series, health, width, height }: { series?: number[]; health: Health; width: number; height: number }) {
  const colors = useColors();
  if (series === undefined || series.length < 2) return null;
  const ink = healthInk(colors, health);
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const pad = 3;
  const pts = series.map((v, i) => {
    const x = pad + (i * (width - pad * 2)) / (series.length - 1);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const last = pts[pts.length - 1]!;
  return (
    <Svg width={width} height={height}>
      <Polyline
        points={pts.map(([x, y]) => `${x},${y}`).join(" ")}
        fill="none"
        stroke={ink}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={last[0]} cy={last[1]} r={1.8} fill={ink} />
    </Svg>
  );
}

/* --------------------------------- faces ---------------------------------- */

function AgentSquare({ size }: { size: number }) {
  const colors = useColors();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        backgroundColor: colors.chromeMuted,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name="robot" size={Math.round(size * 0.6)} color={colors.ink} />
    </View>
  );
}

function TexDisc({ size }: { size: number }) {
  const colors = useColors();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <Tex chaos={0} size={Math.round(size * 0.9)} />
    </View>
  );
}

function EmptyFace({ size }: { size: number }) {
  const colors = useColors();
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderStyle: "dashed", borderColor: colors.lineStrong }}
    />
  );
}

/** An owner's face: a person, Tex, or an empty dashed ring. A helper agent rides as a small robot badge. */
export function OwnerFace({ owner, size, helper = false }: { owner: Owner; size: number; helper?: boolean }) {
  const colors = useColors();
  const face =
    owner === null ? (
      <EmptyFace size={size} />
    ) : owner.kind === "tex" ? (
      <TexDisc size={size} />
    ) : (
      <PersonFace name={`@${owner.name.toLowerCase()}`} size={size} />
    );
  if (!helper) return face;
  const badge = Math.max(10, Math.round(size * 0.6));
  return (
    <View style={{ width: size, height: size }}>
      {face}
      <View
        style={{
          position: "absolute",
          right: -4,
          bottom: -4,
          borderRadius: Math.round(badge * 0.35),
          borderWidth: 1.5,
          borderColor: colors.cardSurface,
        }}
      >
        <AgentSquare size={badge} />
      </View>
    </View>
  );
}

export function ownerName(owner: Owner): string {
  if (owner === null) return "No owner";
  return owner.kind === "tex" ? "Tex" : owner.name;
}

export { AgentSquare, TexDisc };

/* ------------------------------- word switch ------------------------------ */

/** The folder page's List · Board switch (`folderPage/Head.tsx`), generalised. */
export function WordSwitch<T extends string>({
  options,
  value,
  onChange,
  compact,
  label,
  testID,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  compact: boolean;
  label: string;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.switch} role="tablist" accessibilityLabel={label} testID={testID}>
      {options.map((option, index) => (
        <View key={option.value} style={styles.switchItem}>
          {index > 0 ? (
            <Text variant={compact ? "rowValueTouch" : "tree"} style={styles.dot} aria-hidden>
              {"·"}
            </Text>
          ) : null}
          <SwitchWord
            label={option.label}
            on={value === option.value}
            compact={compact}
            onPress={() => onChange(option.value)}
            testID={`${testID}-${option.value}`}
          />
        </View>
      ))}
    </View>
  );
}

function SwitchWord({ label, on, compact, onPress, testID }: { label: string; on: boolean; compact: boolean; onPress: () => void; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      role="tab"
      aria-selected={on}
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      hitSlop={compact ? 10 : 4}
      testID={testID}
    >
      <Text variant={compact ? "rowValueTouch" : "tree"} style={[styles.word, hovered && styles.wordHover, on && styles.wordOn]}>
        {label}
      </Text>
    </Pressable>
  );
}

/* --------------------------------- bits ----------------------------------- */

export function Eyebrow({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text variant="eyebrow" style={styles.eyebrow}>
      {children}
    </Text>
  );
}

export function GapLine({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.gap}>
      <Dot tone="warn" size={6} />
      <Text variant="meta" style={styles.gapText}>
        {text}
      </Text>
    </View>
  );
}

export function HealthDot({ health, size = 7 }: { health: Health; size?: number }) {
  return <Dot tone={health} size={size} />;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    switch: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
    switchItem: { flexDirection: "row", alignItems: "center" },
    word: { color: colors.chromeMuted },
    wordHover: { color: colors.text2 },
    wordOn: { color: colors.text, fontWeight: "600" },
    dot: { color: colors.chromeMuted, paddingHorizontal: 6 },
    eyebrow: { color: colors.muted },
    gap: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    gapText: { color: colors.warnText },
  });

export const r = radii;
