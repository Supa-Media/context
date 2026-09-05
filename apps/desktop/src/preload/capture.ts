/**
 * The hidden capture window's preload — deliberately even smaller.
 *
 * This window holds a live microphone, so it gets the narrowest surface in the
 * app: it is told to start, pause, resume and stop, and it posts audio chunks
 * back. It cannot read state, cannot reach the queue, and cannot ask for
 * anything.
 */

import { contextBridge, ipcRenderer } from "electron";

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
    ready: (): void => ipcRenderer.send("context:capture-ready"),
    failed: (message: string): void => ipcRenderer.send("context:capture-failed", message),
    chunk: (channel: "mic" | "system", atMs: number, data: Uint8Array): void =>
      ipcRenderer.send("context:capture-chunk", { channel, atMs, data }),
  }),
);
