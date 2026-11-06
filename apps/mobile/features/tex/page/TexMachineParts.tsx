import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Circle, G, Path, Rect, Svg } from "react-native-svg";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { T, useWide } from "./TexPageParts";
import type { DotTone } from "./texMachineFormat";

/**
 * The few pieces the machine screens add to the Tex page's own parts, each the
 * artboard kit's class of the same name (`tex-machines-artboards/kit/kit.css`):
 * `.dot`, `.pips`, `.stepper`, `.btn`, `.meter`, `.notice`, and the 26px
 * tinted icon square the strip tiles already use. A component never names a
 * colour; the tokens do.
 */

/** `.dot`: a machine's state, 7 across. */
export function Dot({ tone, testID }: { tone: DotTone; testID?: string }) {
  const colors = useColors();
  const bg = tone === "ok" ? colors.ok : tone === "warn" ? colors.warn : colors.heroDim;
  return <View testID={testID} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: bg, opacity: tone === "off" ? 0.6 : 1 }} />;
}

/** A line of type led by its state dot: `● Online · Mac app · 1h 40m of 4h today`. */
export function DotLine({ tone, children, size = 13, testID }: { tone: DotTone; children: ReactNode; size?: number; testID?: string }) {
  // The dot sits on the first text line, not the middle of a wrapped paragraph.
  const dotTop = Math.round((size * 1.5 - 7) / 2);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 4, minWidth: 0 }} testID={testID}>
      <View style={{ marginTop: dotTop }}>
        <Dot tone={tone} />
      </View>
      <T size={size} tone="muted" style={{ flexShrink: 1 }}>
        {children}
      </T>
    </View>
  );
}

/** `.pips`: one square per slot, filled while busy, dashed when the machine cannot take work. */
export function Pips({ slots, busy, off = false, testID }: { slots: number; busy: number; off?: boolean; testID?: string }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", gap: 3 }} testID={testID} accessibilityLabel={`${busy} of ${slots} busy`}>
      {Array.from({ length: slots }, (_, i) => {
        const filled = i < busy && !off;
        return (
          <View
            key={i}
            style={{
              width: 9,
              height: 9,
              borderRadius: 3,
              borderWidth: 1,
              borderStyle: off ? "dashed" : "solid",
              borderColor: filled ? colors.accent : colors.heroDim,
              backgroundColor: filled ? colors.accent : "transparent",
              opacity: filled ? 1 : off ? 0.45 : 0.75,
            }}
          />
        );
      })}
    </View>
  );
}

/** `.stepper`: − n +, between `min` and `max`. */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  testID,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  label: string;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const step = (by: number) => {
    const next = Math.min(max, Math.max(min, value + by));
    if (next !== value) onChange(next);
  };
  return (
    <View style={styles.stepper} testID={testID}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Fewer ${label}`} disabled={value <= min} onPress={() => step(-1)} style={styles.stepEnd} testID={`${testID}-less`}>
        <T size={16} tone="muted" line={1.6} style={value <= min ? { opacity: 0.4 } : null}>
          −
        </T>
      </Pressable>
      <View style={styles.stepValue}>
        <T size={13} weight="600" line={2.1} testID={`${testID}-value`}>
          {String(value)}
        </T>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`More ${label}`} disabled={value >= max} onPress={() => step(1)} style={styles.stepEnd} testID={`${testID}-more`}>
        <T size={16} tone="muted" line={1.6} style={value >= max ? { opacity: 0.4 } : null}>
          +
        </T>
      </Pressable>
    </View>
  );
}

export type ButtonLook = "primary" | "outline" | "danger" | "quiet";

/** `.btn`: 36 high, radius 8. One `primary` per screen. */
export function Button({
  label,
  onPress,
  look = "outline",
  disabled = false,
  grow = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  look?: ButtonLook;
  disabled?: boolean;
  /** Fill the row on a phone, as the approval card's buttons do. */
  grow?: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const tone = look === "danger" ? colors.crit : look === "quiet" ? colors.muted : look === "primary" ? colors.ink : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      style={[
        styles.btn,
        look === "primary" ? styles.primary : null,
        look === "quiet" ? styles.quiet : null,
        grow ? { flexGrow: 1 } : null,
        disabled ? { opacity: 0.5 } : null,
      ]}
    >
      <T size={13} weight={look === "primary" ? "600" : "500"} line={1} style={{ color: tone }} numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

/** `.btns`: buttons in a row, and a quiet aside after them that drops under them on a phone when asked. */
export function ButtonRow({ children, aside, hideAsideOnPhone = false }: { children: ReactNode; aside?: string; hideAsideOnPhone?: boolean }) {
  const wide = useWide();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {children}
      {aside && (wide || !hideAsideOnPhone) ? (
        <T size={13} tone="muted" style={{ marginLeft: wide ? 4 : 0, flexShrink: 1 }}>
          {aside}
        </T>
      ) : null}
    </View>
  );
}

/** `.meter`: a 6-high bar, warn-toned when full. */
export function Meter({ fraction, full = false, testID }: { fraction: number; full?: boolean; testID?: string }) {
  const colors = useColors();
  const f = Math.max(0, Math.min(1, fraction));
  return (
    <View style={{ height: 6, borderRadius: 999, backgroundColor: colors.line, overflow: "hidden", marginTop: 8 }} testID={testID}>
      <View style={{ width: `${f * 100}%`, height: "100%", borderRadius: 999, backgroundColor: full ? colors.warn : colors.accent }} />
    </View>
  );
}

/** `.notice`: a warn block that says what is wrong, with at most one way out. The status dot above says it is a warning, so the block has no dot of its own. */
export function Notice({ children, action, testID }: { children: ReactNode; action?: ReactNode; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.notice} testID={testID}>
      <View style={{ flex: 1, minWidth: 0, gap: 10 }}>
        <T size={14} line={1.5}>
          {children}
        </T>
        {action ? <View style={{ alignSelf: "flex-start" }}>{action}</View> : null}
      </View>
    </View>
  );
}

export type MachineGlyph = "laptop" | "terminal" | "cloud" | "lock";

/** The 26px tinted icon square, as the strip tiles draw it; the cloud's is grey, since it is not one of yours. */
export function GlyphSquare({ glyph, quiet = false, size = 26 }: { glyph: MachineGlyph; quiet?: boolean; size?: number }) {
  const colors = useColors();
  const stroke = quiet ? colors.muted : colors.accent;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 7,
        backgroundColor: quiet ? colors.surface3 : colors.accentDim,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Glyph glyph={glyph} color={stroke} size={Math.round(size * 0.58)} />
    </View>
  );
}

/** The stroke icons, 24-unit paths like the strip's. */
export function Glyph({ glyph, color, size = 15 }: { glyph: MachineGlyph; color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <G fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        {glyph === "laptop" ? (
          <>
            <Rect x={4} y={5} width={16} height={11} rx={1.5} />
            <Path d="M2 19h20" />
          </>
        ) : glyph === "terminal" ? (
          <>
            <Rect x={3} y={4} width={18} height={16} rx={2} />
            <Path d="M7 9l3 3-3 3M12 15h5" />
          </>
        ) : glyph === "cloud" ? (
          <Path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 11.1 3.5 3.5 0 0 0 7 18z" />
        ) : (
          <>
            <Rect x={5} y={11} width={14} height={9} rx={2} />
            <Path d="M8 11V8a4 4 0 0 1 8 0v3" />
            <Circle cx={12} cy={15.5} r={0.6} />
          </>
        )}
      </G>
    </Svg>
  );
}

/** A link word on the right of a row: "How to add it", "Change", "Review". */
export function RowLink({ label, onPress, tone = "accent", testID }: { label: string; onPress: () => void; tone?: "accent" | "crit"; testID?: string }) {
  return (
    <Pressable accessibilityRole="link" onPress={onPress} testID={testID} hitSlop={8}>
      <T size={13} weight="500" tone={tone} numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

/** `›` at a row's end. */
export function Chevron() {
  return (
    <T size={16} tone="muted" line={1}>
      ›
    </T>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    stepper: {
      flexDirection: "row",
      alignItems: "center",
      height: 30,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: 8,
      backgroundColor: colors.surface2,
      flexShrink: 0,
    },
    stepEnd: { width: 30, alignItems: "center", justifyContent: "center", height: 28 },
    stepValue: { minWidth: 30, paddingHorizontal: 4, alignItems: "center", borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.line, height: 28, justifyContent: "center" },
    btn: {
      height: 36,
      paddingHorizontal: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: 7,
    },
    primary: { backgroundColor: colors.accent, borderColor: colors.accent },
    quiet: { borderColor: "transparent", backgroundColor: "transparent" },
    notice: {
      flexDirection: "row",
      gap: 10,
      alignItems: "flex-start",
      borderWidth: 1,
      borderColor: colors.warnBorder,
      backgroundColor: colors.warnWash,
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 14,
    },
  });
