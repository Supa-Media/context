import { memo } from "react";
import { View } from "react-native";
import { G, Path, Svg } from "react-native-svg";
import type { DrawnJob } from "./geometry";
import { useColors, useScheme } from "../../../design/theme";
import { darkLandingColors, lightLandingColors, texColors } from "../../../design/tokens/landingColors";
import { JOB_ICON_VIEW_BOX, inkFor, jobStrokes } from "./geometry";
import { JOB_LABEL } from "@context/shared/src/folderRoles.cjs";

/** Archive's box on a grey copy, as a share of the drawing: the boards' 13 in 18. */
const BOX_SHARE = 13 / 18;

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
  archived = false,
  testID,
}: {
  job: DrawnJob;
  /** Width and height in points: the drawing's, or with `tile` the tile's. */
  size: number;
  tile?: boolean;
  /**
   * Archive's copy of this built-in folder (`archiveOf`, owner 2026-10-18): the same drawing in grey,
   * with Archive's box on its corner, so Archive/Projects reads as "archived projects".
   */
  archived?: boolean;
  testID?: string;
}) {
  const scheme = useScheme();
  const colors = useColors();
  const ink = archived ? colors.chromeMuted : texColors[scheme].ink;
  const drawing = tile ? Math.round(size * TILE_INSET) : size;
  const svg = <Drawing job={job} size={drawing} ink={ink} {...(tile || archived || testID === undefined ? {} : { testID })} />;
  const box = Math.round(drawing * BOX_SHARE);
  const figure = !archived ? (
    svg
  ) : (
    <View
      {...(tile ? {} : { testID })}
      accessibilityLabel={`Archive of ${JOB_LABEL[job]}`}
      style={{ width: drawing, height: drawing }}
    >
      {svg}
      <View
        style={{
          position: "absolute",
          right: -Math.round(box / 2.5),
          bottom: -Math.round(box / 2.5),
          width: box,
          height: box,
          borderRadius: Math.max(2, Math.round(box / 3.5)),
          backgroundColor: colors.chrome,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Drawing job="archive" size={Math.round(box * 0.9)} ink={colors.muted} />
      </View>
    </View>
  );
  if (!tile) return figure;
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
      {figure}
    </View>
  );
});

/** One job's drawing, inked for its size (`inkFor`). */
function Drawing({ job, size, ink, testID }: { job: DrawnJob; size: number; ink: string; testID?: string }) {
  const { width, dryWidth, dryOpacity } = inkFor(size);
  return (
    <Svg width={size} height={size} viewBox={JOB_ICON_VIEW_BOX} fill="none" {...(testID === undefined ? {} : { testID })}>
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
}
