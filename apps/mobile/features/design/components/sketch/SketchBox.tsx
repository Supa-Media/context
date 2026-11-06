import { useState, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { SketchMark } from "./SketchMark";
import type { SketchLook } from "./sketchGeometry";

/**
 * A row of content with a drawn mark behind it — the capsule's replacement
 * wherever the app shows a value or a filter (owner, 2026-11-04: note values
 * get the marker, underline or tape; a filter that is on gets the pencil
 * loop). It measures itself and hands its size to `SketchMark`; `look: null`
 * draws nothing, for a filter that is off.
 */
export function SketchBox({
  look,
  color,
  seed,
  strength,
  style,
  children,
  testID,
}: {
  look: SketchLook | null;
  color: string;
  /** Text naming what is drawn round, so it keeps one drawing. */
  seed: string;
  strength?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  testID?: string;
}) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (size === null || size.width !== width || size.height !== height) setSize({ width, height });
  };
  return (
    <View style={[styles.box, style]} onLayout={onLayout} testID={testID}>
      {look !== null && size !== null ? (
        <SketchMark
          look={look}
          width={size.width}
          height={size.height}
          color={color}
          seed={seed}
          {...(strength === undefined ? {} : { strength })}
          {...(testID === undefined ? {} : { testID: `${testID}-mark-${look}` })}
        />
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { position: "relative", flexDirection: "row", alignItems: "center" },
});
