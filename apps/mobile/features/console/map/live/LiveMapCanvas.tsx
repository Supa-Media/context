import type { LiveMapCanvasProps } from "./LiveMapCanvas.web";

/**
 * Native has no canvas engine yet: the live map is drawn by the web build
 * (`LiveMapCanvas.web.tsx`). Whoever brings the map to native decides how
 * (a WebView of the web canvas, or Skia); until then this draws nothing.
 */
export type { LiveMapCanvasProps };

export function LiveMapCanvas(_props: LiveMapCanvasProps) {
  return null;
}
