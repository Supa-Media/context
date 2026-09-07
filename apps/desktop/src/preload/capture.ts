/**
 * The hidden capture window's preload — deliberately even smaller.
 *
 * This window holds a live microphone, so it gets the narrowest surface in the
 * app: it is told to start, pause, resume and stop, and it posts audio chunks
 * back. It cannot read state, cannot reach the queue, and cannot ask for
 * anything.
 *
 * `ready` carries which channels were **not** opened, because the answer to
 * "did system audio work" is only knowable here, at the moment macOS either
 * hands over a track or does not. The main process turns that into the one
 * sentence the panel shows.
 */

import { contextBridge, ipcRenderer } from "electron";

export interface CaptureChunk {
  channel: "mic" | "system";
  atMs: number;
  durationMs: number;
  mimeType: string;
  data: Uint8Array;
}

contextBridge.exposeInMainWorld(
  "capture",
  Object.freeze({
    onStart: (handler: (options: { channels: ("mic" | "system")[]; sampleRate: number }) => void): void => {
      ipcRenderer.on("context:capture-start", (_event, options) => handler(options));
    },
    onPause: (handler: () => void): void => {
      ipcRenderer.on("context:capture-pause", () => handler());
    },
    onResume: (handler: () => void): void => {
      ipcRenderer.on("context:capture-resume", () => handler());
    },
    onStop: (handler: () => void): void => {
      ipcRenderer.on("context:capture-stop", () => handler());
    },
    ready: (degraded: string[]): void => ipcRenderer.send("context:capture-ready", degraded),
    failed: (message: string): void => ipcRenderer.send("context:capture-failed", message),
    chunk: (chunk: CaptureChunk): void => ipcRenderer.send("context:capture-chunk", chunk),
  }),
);
