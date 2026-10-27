import { memo } from "react";
import { G, Path, Svg } from "react-native-svg";
import type { ContextPart } from "@context/shared/src/contextIcons.cjs";
import { useColors } from "../../../design/theme";
import { JOB_ICON_VIEW_BOX, drawnStrokes, inkFor } from "../jobIcons/geometry";
import { ICONS, PARTS } from "./drawings";

/**
 * One of Context's own icons (`contextIcons.cjs`), or a built-in part's,
 * drawn in the built-in folders' brush (`jobIcons/geometry.ts`).
 *
 * Every one draws in the text colour. A part Context files into drew in Tex's
 * blue at first (2026-10-21, board 1, option B), until the owner settled that
 * only a folder at the top of the workspace is blue (2026-10-26: "aren't all
 * the non root folders supposed to be colored black"), and a part is always
 * inside Tex's folder or the Inbox. Heavier and without the brush's grain at
 * list size, as the job icons are (`inkFor`).
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
  const colors = useColors();
  const drawing = part !== undefined ? PARTS[part] : name !== undefined ? ICONS[name] : undefined;
  if (drawing === undefined) return null;
  const strokes = drawnStrokes(part !== undefined ? `part:${part}` : `icon:${name}`, part ?? name ?? "", drawing);
  const ink = colors.text;
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
