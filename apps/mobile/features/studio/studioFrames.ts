/**
 * The cast studio's three frames.
 *
 * Each is the app at a real window size (`width` × `height`, in CSS pixels),
 * so the layout that plays is the one a person would get at that size: the
 * phone frame is narrow enough for the phone layout, the desktop one is a
 * laptop's window. The studio then scales that window to fit, so what is
 * recorded is the real app, drawn larger or smaller, never reflowed. `video`
 * is the size a recording of it is meant to be delivered at.
 */

export type StudioFrameId = "phone" | "desktop" | "square";

export interface StudioFrame {
  id: StudioFrameId;
  label: string;
  width: number;
  height: number;
  /** "9:16 · 1080×1920", for the record screen. */
  video: string;
}

export const STUDIO_FRAMES: readonly StudioFrame[] = [
  { id: "phone", label: "Phone", width: 405, height: 720, video: "9:16 · 1080×1920" },
  { id: "desktop", label: "Desktop", width: 1280, height: 720, video: "16:9 · 1920×1080" },
  { id: "square", label: "Square", width: 1080, height: 1080, video: "1:1 · 1080×1080" },
];

export function studioFrame(id: StudioFrameId): StudioFrame {
  return STUDIO_FRAMES.find((frame) => frame.id === id) ?? STUDIO_FRAMES[1]!;
}

/** The largest scale at which `frame` fits inside `box`. */
export function fitScale(frame: Pick<StudioFrame, "width" | "height">, box: { width: number; height: number }): number {
  if (box.width <= 0 || box.height <= 0) return 0;
  return Math.min(box.width / frame.width, box.height / frame.height);
}
