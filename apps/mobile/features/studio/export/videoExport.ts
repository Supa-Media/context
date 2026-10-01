import type { StudioFrameId } from "../studioFrames";

/**
 * Export: the studio records its own stage and saves a video file, so a
 * scene no longer needs a screen recorder (Dev2, 2026-10-01: "is there a way
 * you can do an easy export so I dont have to screen record all the time").
 *
 * The browser shares this tab once (its own prompt, which no page can skip),
 * the stage is cut out of it and drawn at the frame's delivery size, the
 * studio's sounds are mixed in from its own audio rather than the tab's, and
 * the take is saved when the scene ends. This file is the arithmetic and the
 * choices; `tabRecorder.web.ts` does it.
 */

export interface ExportSize {
  width: number;
  height: number;
}

/** What each frame is delivered at (`studioFrames.ts`'s `video`). */
export const EXPORT_SIZES: Record<StudioFrameId, ExportSize> = {
  phone: { width: 1080, height: 1920 },
  desktop: { width: 1920, height: 1080 },
  square: { width: 1080, height: 1080 },
};

export interface VideoType {
  mimeType: string;
  extension: "mp4" | "webm";
}

/** Best first: an MP4 every app and phone plays, then WebM, which Chrome always makes. */
const VIDEO_TYPES: readonly VideoType[] = [
  { mimeType: "video/mp4;codecs=avc1.640028,mp4a.40.2", extension: "mp4" },
  { mimeType: "video/mp4;codecs=avc1,mp4a", extension: "mp4" },
  { mimeType: "video/mp4", extension: "mp4" },
  { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
];

/** The best kind of file this browser can record, or `null` for none. */
export function pickVideoType(isSupported: (mimeType: string) => boolean): VideoType | null {
  for (const type of VIDEO_TYPES) {
    try {
      if (isSupported(type.mimeType)) return type;
    } catch {
      // A browser that throws on a type it does not know has not got it.
    }
  }
  return null;
}

/** `i-told-claude-phone.mp4`: the scene's name and the frame, plain. */
export function exportFileName(scene: string, frame: StudioFrameId, extension: string): string {
  const slug = scene
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug === "" ? "scene" : slug}-${frame}.${extension}`;
}

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The stage's box on the page, in the captured video's pixels: the tab is
 * captured whole, at whatever scale the screen draws it, and only the stage
 * goes in the file. Kept inside the video.
 */
export function cropFor(
  stage: { left: number; top: number; width: number; height: number },
  view: ExportSize,
  video: ExportSize,
): Crop {
  if (video.width <= 0 || video.height <= 0 || view.width <= 0 || view.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const sx = video.width / view.width;
  const sy = video.height / view.height;
  const x = Math.max(0, Math.round(stage.left * sx));
  const y = Math.max(0, Math.round(stage.top * sy));
  const right = Math.min(video.width, Math.round((stage.left + stage.width) * sx));
  const bottom = Math.min(video.height, Math.round((stage.top + stage.height) * sy));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

interface ExportGlobals {
  navigator?: { mediaDevices?: { getDisplayMedia?: unknown } };
  MediaRecorder?: { isTypeSupported?: (mimeType: string) => boolean } | undefined;
  CropTarget?: unknown;
  HTMLCanvasElement?: { prototype?: { captureStream?: unknown } };
}

/**
 * Whether this browser can export. Tab sharing alone is not enough: Safari
 * and Firefox offer a screen or a window, never this tab, and a take of the
 * whole screen is the screen recording this replaces. `CropTarget` is the
 * mark of the browsers (Chrome, Edge) that offer this tab first.
 */
export function canExportVideo(globals: unknown = globalThis): boolean {
  const g = globals as ExportGlobals | undefined;
  if (g === undefined || g === null) return false;
  if (typeof g.navigator?.mediaDevices?.getDisplayMedia !== "function") return false;
  if (g.CropTarget === undefined) return false;
  if (typeof g.HTMLCanvasElement?.prototype?.captureStream !== "function") return false;
  const recorder = g.MediaRecorder;
  if (recorder === undefined || typeof recorder.isTypeSupported !== "function") return false;
  return pickVideoType((mime) => recorder.isTypeSupported!(mime)) !== null;
}
