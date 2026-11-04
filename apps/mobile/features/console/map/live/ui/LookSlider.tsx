import { useRef, useState } from "react";
import { StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import { Text } from "../../../../design/components/Text";
import { fonts, pointerType } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";

/**
 * A slider for the map's settings: a name, the value, and a track to drag or
 * click along. Works the same with a mouse, a finger and a screen reader (as
 * an adjustable control, a tenth of the range per step).
 */
export function LookSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  digits = 2,
  testID,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  digits?: number;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const track = useRef<View>(null);
  const [box, setBox] = useState<{ left: number; width: number }>({ left: 0, width: 0 });
  const span = max - min;
  const k = span > 0 ? (value - min) / span : 0;

  const snap = (v: number) => {
    const n = Math.round((Math.min(max, Math.max(min, v)) - min) / step) * step + min;
    return Number(n.toFixed(4));
  };
  const at = (e: GestureResponderEvent) => {
    if (box.width <= 0) return;
    onChange(snap(min + ((e.nativeEvent.pageX - box.left) / box.width) * span));
  };
  const measure = (_: LayoutChangeEvent) => {
    track.current?.measureInWindow?.((x, _y, width) => setBox({ left: x, width }));
  };
  const nudge = (dir: 1 | -1) => onChange(snap(value + dir * Math.max(step, span / 10)));

  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>{value.toFixed(digits)}</Text>
      </View>
      <View
        ref={track}
        onLayout={measure}
        style={styles.hit}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min, max, now: value }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === "increment" ? 1 : -1)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => {
          // The panel may have scrolled since it was laid out.
          track.current?.measureInWindow?.((x, _y, width) => setBox({ left: x, width }));
          at(e);
        }}
        onResponderMove={at}
        testID={testID}
      >
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${k * 100}%` }]} />
        </View>
        <View style={[styles.knob, { left: `${k * 100}%` }]} />
      </View>
    </View>
  );
}

const KNOB = 16;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { paddingVertical: 6, gap: 6 },
    head: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
    label: { fontFamily: fonts.body, fontSize: pointerType.ui, color: colors.text },
    value: { fontFamily: fonts.mono, fontSize: pointerType.meta, color: colors.muted },
    hit: { height: 22, justifyContent: "center", marginHorizontal: KNOB / 2 },
    track: { height: 4, borderRadius: 2, backgroundColor: colors.surface3, overflow: "hidden" },
    fill: { height: 4, backgroundColor: colors.accent },
    knob: {
      position: "absolute",
      width: KNOB,
      height: KNOB,
      marginLeft: -KNOB / 2,
      borderRadius: KNOB / 2,
      backgroundColor: colors.accent,
      borderWidth: 2,
      borderColor: colors.pageSurface,
    },
  });
