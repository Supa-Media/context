/**
 * The guest bundle's entry point — the only part of the editor that knows it is
 * inside a `WebView`.
 *
 * Everything interesting is in `guest.ts`, which takes its bridge as an
 * argument so the whole of it runs under jsdom in the ordinary Jest suite. This
 * file is what supplies the real one, and it is deliberately the only file that
 * cannot be tested that way: `window.ReactNativeWebView` exists only inside
 * WKWebView.
 *
 * Compiled by `scripts/build-editor-bundle.mjs` into `bundle.generated.ts`.
 * Metro never sees it — nothing in the React Native tree imports this file, and
 * it must stay that way, because it pulls in CodeMirror.
 *
 * ## The two directions
 *
 * **Guest → host** is `window.ReactNativeWebView.postMessage`, injected by
 * react-native-webview as a user script before this runs.
 *
 * **Host → guest** is `ref.postMessage(json)`, which iOS delivers as
 * `window.dispatchEvent(new MessageEvent('message', { data }))`
 * (`apple/RNCWebViewImpl.m`) and Android delivers on `document`. Both are
 * listened to; a message arrives on exactly one of them per platform, so this
 * is a platform split rather than a double delivery.
 */

import { mountGuest, type GuestBridge } from "./guest";
import { guestStyles } from "./styles";
import { PROTOCOL_VERSION } from "./protocol";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (data: string) => void };
  }
}

function start(): void {
  const style = document.createElement("style");
  style.textContent = guestStyles();
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);

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

  mountGuest(root, bridge, document.documentElement);
}

try {
  start();
} catch (error) {
  // A guest that fails to start is a blank white rectangle where the note
  // should be, and the host has no other way to find out. "An absent capability
  // is reported, never faked."
  window.ReactNativeWebView?.postMessage(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "failed",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
