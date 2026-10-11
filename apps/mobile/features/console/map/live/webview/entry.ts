/**
 * The map guest bundle's entry point: the only part of the phone's map that
 * knows it is inside a `WebView`. Everything else is `guest.ts`.
 *
 * Compiled by `scripts/build-map-bundle.mjs` into `bundle.generated.ts`. Metro
 * never sees this file: nothing in the React Native tree imports it.
 *
 * Guest → host is `window.ReactNativeWebView.postMessage`. Host → guest is
 * `ref.postMessage(json)`, which iOS delivers on `window` and Android on
 * `document`; both are listened to, as the editor's guest does.
 */

import { mountMapGuest, type GuestBridge } from "./guest";
import { MAP_PROTOCOL_VERSION } from "./protocol";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (data: string) => void };
  }
}

function start(): void {
  const style = document.createElement("style");
  // No scrolling, no selection, no browser gestures: every touch is the map's.
  style.textContent =
    "html,body{margin:0;height:100%;overflow:hidden;background:transparent;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}" +
    "canvas{position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none}";
  document.head.appendChild(style);
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Map of the workspace: notes, links, and the people and AI tools working in it");
  document.body.appendChild(canvas);

  const native = window.ReactNativeWebView;
  const bridge: GuestBridge = {
    post: (message) => native?.postMessage(JSON.stringify(message)),
    listen: (handler) => {
      const onMessage = (event: Event) => {
        const data = (event as MessageEvent).data;
        if (typeof data === "string") handler(data);
      };
      window.addEventListener("message", onMessage);
      document.addEventListener("message", onMessage);
    },
  };
  const { resize } = mountMapGuest(canvas, bridge, () => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: Math.min(3, window.devicePixelRatio || 1),
  }));
  window.addEventListener("resize", resize);
}

try {
  start();
} catch (error) {
  window.ReactNativeWebView?.postMessage(
    JSON.stringify({
      v: MAP_PROTOCOL_VERSION,
      type: "failed",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
