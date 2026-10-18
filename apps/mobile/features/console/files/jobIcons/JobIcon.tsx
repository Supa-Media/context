import { memo } from "react";
import { View } from "react-native";
import { G, Path, Svg } from "react-native-svg";
import type { RowRole } from "@context/shared/src/folderRoles.cjs";
import { useScheme } from "../../../design/theme";
import { darkLandingColors, lightLandingColors, texColors } from "../../../design/tokens/landingColors";
import { JOB_ICON_VIEW_BOX, inkFor, jobStrokes } from "./geometry";

/** The drawing's share of its tile at heading size: board 9's 38 in 56. */
const TILE_INSET = 38 / 56;

/**
 * A built-in folder's drawn icon (`geometry.ts`), in Tex's blue: one ink for
 * every job, the shape tells them apart (board 8). At list size it is the bare
 * drawing, heavier and without the brush's grain; `tile` puts it on the
 * landing pages' paper at heading size (board 9), grain and all.
 *
 * Decorative: the folder's name is always beside it.
 */
export const JobIcon = memo(function JobIcon({
  job,
  size,
  tile = false,
  testID,
}: {
  job: RowRole;
  /** Width and height in points: the drawing's, or with `tile` the tile's. */
  size: number;
  tile?: boolean;
  testID?: string;
}) {
  const scheme = useScheme();
  const ink = texColors[scheme].ink;
  const drawing = tile ? Math.round(size * TILE_INSET) : size;
  const { width, dryWidth, dryOpacity } = inkFor(drawing);
  const svg = (
    <Svg width={drawing} height={drawing} viewBox={JOB_ICON_VIEW_BOX} fill="none" {...(tile || testID === undefined ? {} : { testID })}>
      <G stroke={ink} strokeLinecap="round" strokeLinejoin="round" fill="none">
        {jobStrokes(job).map((stroke, index) => (
          <G key={index}>
            <Path d={stroke.d} strokeWidth={width} />
            {dryWidth === undefined ? null : <Path d={stroke.dry} strokeWidth={dryWidth} opacity={dryOpacity} />}
          </G>
        ))}
      </G>
    </Svg>
  );
  if (!tile) return svg;
  const paper = scheme === "dark" ? darkLandingColors.paper2 : lightLandingColors.paper;
  return (
    <View
      testID={testID}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        backgroundColor: paper,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {svg}
    </View>
  );
});
