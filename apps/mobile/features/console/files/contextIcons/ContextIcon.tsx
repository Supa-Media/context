import { memo } from "react";
import { G, Path, Svg } from "react-native-svg";
import type { ContextPart } from "@context/shared/src/contextIcons.cjs";
import { useColors, useScheme } from "../../../design/theme";
import { texColors } from "../../../design/tokens/landingColors";
import { JOB_ICON_VIEW_BOX, drawnStrokes, inkFor } from "../jobIcons/geometry";
import { ICONS, PARTS } from "./drawings";

/**
 * One of Context's own icons (`contextIcons.cjs`), or a built-in part's,
 * drawn in the built-in folders' brush (`jobIcons/geometry.ts`).
 *
 * The ink is the owner's pick (2026-10-21, board 1, option B): an icon a
 * person chose draws in the text colour, and a part Context files into draws
 * in Tex's blue like the built-in folders, so blue keeps meaning "Context
 * looks after this folder". Heavier and without the brush's grain at list
 * size, as the job icons are (`inkFor`).
 *
 * Decorative: the name is always beside it.
 */
export const ContextIcon = memo(function ContextIcon({
  name,
  part,
  size,
  testID,
}: {
  /** A Context icon's name; or */
  name?: string;
  /** a built-in part's. */
  part?: ContextPart;
  size: number;
  testID?: string;
}) {
  const scheme = useScheme();
  const colors = useColors();
  const drawing = part !== undefined ? PARTS[part] : name !== undefined ? ICONS[name] : undefined;
  if (drawing === undefined) return null;
  const strokes = drawnStrokes(part !== undefined ? `part:${part}` : `icon:${name}`, part ?? name ?? "", drawing);
  const ink = part !== undefined ? texColors[scheme].ink : colors.text;
  const { width, dryWidth, dryOpacity } = inkFor(size);
  return (
    <Svg width={size} height={size} viewBox={JOB_ICON_VIEW_BOX} fill="none" {...(testID === undefined ? {} : { testID })}>
      <G stroke={ink} strokeLinecap="round" strokeLinejoin="round" fill="none">
        {strokes.map((stroke, index) => (
          <G key={index}>
            <Path d={stroke.d} strokeWidth={width} />
            {dryWidth === undefined ? null : <Path d={stroke.dry} strokeWidth={dryWidth} opacity={dryOpacity} />}
          </G>
        ))}
      </G>
    </Svg>
  );
});
