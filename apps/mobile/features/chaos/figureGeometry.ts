/**
 * Tex's geometry: the googly-eyed paper-ink scribble that untangles into the
 * app icon's # as a workspace calms down. The geometry itself lives in
 * `packages/shared/src/ink/texFigure.cjs`, so the gateway's page drawings put
 * the same Tex in them (2026-11-03): one Tex. `Tex.tsx` draws these parts.
 */

export {
  figureParts,
  scribble,
  SMALL_FIGURE,
  SMALL_VIEW_BOX,
  TEX_WIDTH,
  VIEW_BOX,
} from "@context/shared/src/ink/texFigure.cjs";
export type { FigureParts } from "@context/shared/src/ink/texFigure.cjs";
