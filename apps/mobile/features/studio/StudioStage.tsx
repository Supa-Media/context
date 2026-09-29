import type { StudioFrame } from "./studioFrames";

export interface StudioStageProps {
  frame: StudioFrame;
  /** The homepage address that plays the draft: `/#cast-preview=…`. */
  src: string;
  attach: (element: HTMLIFrameElement | null) => void;
  /** Hide the pointer over the stage: Record's take. */
  bare?: boolean;
}

/** The studio is web only, like "Preview demo" that opens it (`StudioStage.web.tsx`). */
export function StudioStage(_props: StudioStageProps) {
  return null;
}
