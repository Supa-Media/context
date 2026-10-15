import { memo, useMemo } from "react";
import { View } from "react-native";
import { Circle, Ellipse, G, Path, Svg } from "react-native-svg";
import { useScheme, type Scheme } from "../design/theme";
import { texColors } from "../design/tokens/landingColors";
import {
  figureParts,
  SMALL_FIGURE,
  SMALL_VIEW_BOX,
  VIEW_BOX,
} from "./figureGeometry";
import { RoughInk } from "./RoughInk";

/** The thinnest line a small Tex draws, in screen pixels. */
const SMALL_LINE_PX = 1.4;

/**
 * Tex, the Context mascot: at 100 a googly-eyed ink scribble with legs and a
 * waving arm, at 0 the app icon's #, still googly-eyed. The one drawing of
 * Tex in the product: every chaos score in the app (web, desktop and phone)
 * and the homepage draw this component, from `figureGeometry.ts`, in
 * `texColors`.
 *
 * Decorative: every surface that draws one says the score in words beside it.
 */
export const Tex = memo(function Tex({
  chaos,
  size,
  scheme: forced,
  tug,
  testID,
}: {
  /** 0 (calm) to 100 (chaos). */
  chaos: number;
  /** Width and height, in points. Left out, Tex fills its parent, drawn at full size. */
  size?: number;
  /** A page that is one scheme whatever the device's (the homepage is light only). */
  scheme?: Scheme;
  /**
   * Tex stressed, tugging at its yarn: 0 slack to 1 hauling. Left out, Tex
   * stands as always. Nothing draws the pose since the app dropped Tex.
   */
  tug?: number;
  testID?: string;
}) {
  const system = useScheme();
  const { ink, eye } = texColors[forced ?? system];
  const small = size !== undefined && size <= SMALL_FIGURE;
  const box = small ? SMALL_VIEW_BOX : VIEW_BOX;
  // A line SMALL_LINE_PX wide on screen, in the board's units.
  const minStroke =
    small && size !== undefined
      ? Math.round((SMALL_LINE_PX * box.size) / size)
      : 0;
  // A tenth of a point of chaos is not a different drawing.
  const step = Math.round(chaos * 10) / 10;
  const pull = tug === undefined ? undefined : Math.round(tug * 50) / 50;
  const parts = useMemo(
    () => figureParts(step, { small, minStroke, tug: pull }),
    [step, small, minStroke, pull],
  );
  const g = parts.googly;
  const side = size ?? "100%";

  return (
    <View
      style={[
        { width: side, height: side },
        // Leaning back against the pull.
        pull === undefined ? null : { transform: [{ rotate: `${(-5 * pull).toFixed(1)}deg` }] },
      ]}
      aria-hidden
      testID={testID}
    >
      <Svg width={side} height={side} viewBox={parts.viewBox}>
        <RoughInk rough={!small}>
          {parts.speckles.map((s, i) => (
            <Circle
              key={`s${i}`}
              cx={s.cx}
              cy={s.cy}
              r={s.r}
              fill={ink}
              opacity={s.opacity}
            />
          ))}
          {parts.strands.map((strand, i) => (
            <G key={`h${i}`}>
              <Path
                d={strand.d}
                stroke={ink}
                strokeWidth={strand.width}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <Path
                d={strand.dry}
                stroke={ink}
                strokeWidth={strand.width * 0.45}
                fill="none"
                strokeLinecap="round"
                opacity={0.7}
              />
            </G>
          ))}
          {parts.yarn === null ? null : (
            <Path
              d={parts.yarn.d}
              stroke={ink}
              strokeWidth={parts.yarn.width}
              fill="none"
              strokeLinecap="round"
              testID={testID === undefined ? undefined : `${testID}-yarn`}
            />
          )}
          {parts.limbOpacity <= 0
            ? null
            : parts.limbs.map((limb, i) => (
                <Path
                  key={`l${i}`}
                  d={limb.d}
                  stroke={ink}
                  strokeWidth={limb.width}
                  fill="none"
                  strokeLinecap="round"
                  opacity={parts.limbOpacity}
                />
              ))}
          {parts.motion === null ? null : (
            <G opacity={parts.motion.opacity}>
              {parts.motion.d.map((d, i) => (
                <Path
                  key={`m${i}`}
                  d={d}
                  stroke={ink}
                  strokeWidth={parts.motion!.width}
                  strokeLinecap="round"
                />
              ))}
            </G>
          )}
          <G
            transform={`translate(${g.x} ${g.y}) scale(${g.scale})`}
            testID={testID === undefined ? undefined : `${testID}-googly`}
          >
            {g.whites.map((w, i) => (
              <Ellipse
                key={`w${i}`}
                cx={w.cx}
                cy={w.cy}
                rx={w.rx}
                ry={w.ry}
                fill={eye}
                stroke={ink}
                strokeWidth={g.outline}
              />
            ))}
            {g.pupils.map((p, i) => (
              <Circle key={`p${i}`} cx={p.cx} cy={p.cy} r={p.r} fill={ink} />
            ))}
          </G>
        </RoughInk>
      </Svg>
    </View>
  );
});
