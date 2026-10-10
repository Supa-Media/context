import { memo, useMemo } from "react";
import { View } from "react-native";
import { Circle, Ellipse, G, Path, Svg } from "react-native-svg";
import { useColors, useScheme } from "../design/theme";
import { darkLandingColors, lightLandingColors } from "../design/tokens/landingColors";
import { figureParts, SMALL_FIGURE, SMALL_VIEW_BOX, VIEW_BOX } from "./figureGeometry";
import { RoughInk } from "./RoughInk";

/** The thinnest line a small figure draws, in screen pixels. */
const SMALL_LINE_PX = 1.4;

/**
 * The chaos score as a figure: at 100 a googly-eyed ink scribble with legs
 * and a waving arm, at 0 the app icon's # with two calm blue dots. The owner's
 * pick (paper3), drawn from `figureGeometry.ts`.
 *
 * Ink is the theme's text colour, so it inverts with dark mode; the dots are
 * the brand blue the landing sheet already names (`landingColors.blue`) — the
 * figure's own board used that exact blue, and the app's accent is teal. The
 * eyes' whites are the page's surface.
 *
 * Decorative: every surface that draws one says the score in words beside it.
 */
export const ChaosFigure = memo(function ChaosFigure({
  chaos,
  size,
  testID,
}: {
  /** 0 (calm) to 100 (chaos). */
  chaos: number;
  /** Width and height, in points. */
  size: number;
  testID?: string;
}) {
  const colors = useColors();
  const scheme = useScheme();
  const small = size <= SMALL_FIGURE;
  const box = small ? SMALL_VIEW_BOX : VIEW_BOX;
  // A line SMALL_LINE_PX wide on screen, in the board's units.
  const minStroke = small ? Math.round((SMALL_LINE_PX * box.size) / size) : 0;
  // A tenth of a point of chaos is not a different drawing.
  const step = Math.round(chaos * 10) / 10;
  const parts = useMemo(() => figureParts(step, { small, minStroke }), [step, small, minStroke]);
  const ink = colors.text;
  const paper = colors.surface;
  const dot = (scheme === "dark" ? darkLandingColors : lightLandingColors).blue;

  return (
    <View style={{ width: size, height: size }} aria-hidden testID={testID}>
      <Svg width={size} height={size} viewBox={parts.viewBox}>
        <RoughInk rough={!small}>
          {parts.speckles.map((s, i) => (
            <Circle key={`s${i}`} cx={s.cx} cy={s.cy} r={s.r} fill={ink} opacity={s.opacity} />
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
                <Path key={`m${i}`} d={d} stroke={ink} strokeWidth={parts.motion!.width} strokeLinecap="round" />
              ))}
            </G>
          )}
          {parts.googly === null ? null : (
            <G
              transform={`translate(${parts.googly.x} ${parts.googly.y}) scale(${parts.googly.scale})`}
              testID={testID === undefined ? undefined : `${testID}-googly`}
            >
              {parts.googly.whites.map((w, i) => (
                <Ellipse
                  key={`w${i}`}
                  cx={w.cx}
                  cy={w.cy}
                  rx={w.rx}
                  ry={w.ry}
                  fill={paper}
                  stroke={ink}
                  strokeWidth={parts.googly!.outline}
                />
              ))}
              {parts.googly.pupils.map((p, i) => (
                <Circle key={`p${i}`} cx={p.cx} cy={p.cy} r={p.r} fill={ink} />
              ))}
            </G>
          )}
        </RoughInk>
        {parts.dots === null ? null : (
          <G testID={testID === undefined ? undefined : `${testID}-dots`}>
            {parts.dots.map((d, i) => (
              <Circle key={`d${i}`} cx={d.cx} cy={d.cy} r={d.r} fill={dot} />
            ))}
          </G>
        )}
      </Svg>
    </View>
  );
});
