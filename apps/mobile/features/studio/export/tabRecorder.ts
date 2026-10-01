import type { ExportSize, VideoType } from "./videoExport";

/** A take being recorded: started when the scene starts, saved when it ends. */
export interface TabRecording {
  type: VideoType;
  begin: () => void;
  finish: () => Promise<Blob>;
  cancel: () => void;
}

export type TabCapture = TabRecording | { problem: string };

export interface CaptureRequest {
  /** The stage on the page: only it goes in the file. */
  stage: () => Element | null;
  size: ExportSize;
  sound: MediaStream | null;
  /** The browser stopped sharing (its own Stop button) before the take was saved. */
  onStopped: () => void;
}

/** Export is web only, like the studio (`tabRecorder.web.ts`). */
export function captureTab(_request: CaptureRequest): Promise<TabCapture> {
  return Promise.resolve({ problem: "Export works in Chrome or Edge on a computer." });
}

export function saveVideo(_name: string, _video: Blob): void {}
