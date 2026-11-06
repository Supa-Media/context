import { useMemo } from "react";
import { StyleSheet } from "react-native";
import { Path, Svg } from "react-native-svg";
import { useColors, useScheme } from "../../theme";
import { SketchGrain } from "./SketchGrain";
import { seedOf, sketchStrokes, type SketchLook } from "./sketchGeometry";

/** Room round the box for a loop that runs a little outside it. */
const BLEED = 4;

/**
 * A drawn mark behind something the size of `width` × `height`: a marker
 * swipe, a pencil underline, a pencil loop or a strip of tape
 * (`sketchGeometry.ts`). It sits
 * absolutely in its parent's top-left corner, under the parent's content and
 * out of the pointer's way; the parent measures itself and passes its size.
 *
 * `seed` is any text that names the thing drawn round, so it keeps one
 * drawing. Pencil is drawn a little heavier on the dark board, where a thin
 * light line on near-black goes thin, and a marker a touch lighter there.
 * Tape ignores `color`: it is paper, a pale stone on white (the owner did not
 * like yellow masking tape on white, 2026-11-04) and the warm strip they liked
 * on the dark board: the palette's `tapeWash`.
 */
export function SketchMark({
  look,
  width,
  height,
  color,
  seed,
  strength = 1,
  testID,
}: {
  look: SketchLook;
  width: number;
  height: number;
  color: string;
  seed: string;
  /** 0–1 multiplier on the mark's opacity, for a quieter resting state. */
  strength?: number;
  testID?: string;
}) {
  const dark = useScheme() === "dark";
  const colors = useColors();
  const strokes = useMemo(() => sketchStrokes(look, width, height, seedOf(seed)), [look, width, height, seed]);
  if (strokes.length === 0) return null;
  const pencilWeight = dark ? 1.45 : 1;
  const markerOpacity = dark ? 0.4 : 0.5;
  const marker = strokes.filter((s) => s.pen === "marker");
  const pencil = strokes.filter((s) => s.pen === "pencil");
  const tape = strokes.filter((s) => s.pen === "tape");
  return (
    <Svg
      width={width + BLEED * 2}
      height={height + BLEED * 2}
      style={styles.mark}
      pointerEvents="none"
      aria-hidden
      testID={testID}
    >
      {tape.map((s, i) => (
        <Path
          key={`t${i}`}
          d={s.d}
          transform={`translate(${BLEED},${BLEED})`}
          fill={colors.tapeWash}
          opacity={strength}
        />
      ))}
      {marker.map((s, i) => (
        <Path
          key={`m${i}`}
          d={s.d}
          transform={`translate(${BLEED},${BLEED})`}
          fill="none"
          stroke={color}
          strokeWidth={s.width}
          strokeLinecap="square"
          opacity={markerOpacity * strength}
        />
      ))}
      {pencil.length > 0 ? (
        <SketchGrain dark={dark}>
          {pencil.map((s, i) => (
            <Path
              key={`p${i}`}
              d={s.d}
              transform={`translate(${BLEED},${BLEED})`}
              fill="none"
              stroke={color}
              strokeWidth={s.width * pencilWeight}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={s.dashed ? "2.5 3.5" : undefined}
              opacity={s.opacity * strength}
            />
          ))}
        </SketchGrain>
      ) : null}
    </Svg>
  );
}

const styles = StyleSheet.create({
  mark: { position: "absolute", left: -BLEED, top: -BLEED },
});
