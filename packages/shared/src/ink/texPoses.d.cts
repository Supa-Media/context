/** Types for `texPoses.cjs`; see that file for what each pose is for. */

export type TexPose =
  | "waving"
  | "reading"
  | "checklist"
  | "coffee"
  | "idea"
  | "trip"
  | "painting"
  | "calendar"
  | "money"
  | "cooking";

export declare const POSE_NAMES: readonly TexPose[];
export declare function texPoseSvg(
  pose: TexPose,
  colors?: { ink?: string; eye?: string; paper?: string; accent?: string },
): string;
export declare function hashTileSvg(colors?: { ground?: string; ink?: string }): string;
