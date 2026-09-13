/**
 * The drawing editor, as a page of its own.
 *
 * This is **not** part of the console application. It is built separately by
 * `scripts/build-drawing-editor.mjs` into `public/drawing-assets/editor/` and
 * loaded in an `<iframe>` on web and a `WebView` on native, because measuring
 * the obvious alternative showed it does not work: a dynamic `import()` of
 * `@excalidraw/excalidraw` inside the console does not produce a lazy chunk
 * under Expo's Metro — it lands in a `__common` bundle that `index.html` loads
 * eagerly, taking the console from 5.7MB of JavaScript to 14.6MB on every page
 * load. `features/console/files/drawingBridge.ts` carries that argument in full.
 *
 * Two consequences worth stating, because they are the point rather than side
 * effects:
 *
 *  - **The console's bundle does not change at all.** This page is fetched the
 *    first time somebody opens a drawing and never otherwise.
 *  - **The same page serves both platforms.** The native half of this feature
 *    is not a separate implementation waiting to be written; it is this file in
 *    a `WebView`.
 *
 * ## It never sees the customer's Markdown
 *
 * The console sends elements and gets elements back. Splicing them into the
 * `.excalidraw.md` file is `serializeDrawing`'s job, on the console side, where
 * the original bytes are. So this page cannot produce a file body — which means
 * a bug here, or anything that manages to talk to this frame, cannot corrupt
 * one either. It is the smallest surface the feature can have.
 */

/*
  First, and above the Excalidraw import on purpose: it sets the font path that
  keeps this page from reaching for esm.sh. See `assetPath.js` for what is
  actually guaranteed there and what is only insurance.
*/
import "./assetPath.js";

import { createElement, StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw } from "@excalidraw/excalidraw";

/*
  The real bridge module, not a copy of it.

  esbuild compiles TypeScript, so this page uses the same reader and the same
  envelope the console does — which is what makes `drawingBridge.test.ts` a test
  of this page's behaviour rather than of a parallel implementation that only
  resembles it. `drawingBridge.ts` imports nothing, precisely so it can be
  shared by a bundle that shares nothing else with the app.
*/
import { envelope, readToEditor } from "../features/console/files/drawingBridge";

/** The origin that is allowed to drive this page: whoever embedded it. */
const HOST_ORIGIN = (() => {
  try {
    // `document.referrer` is the embedding page on both an iframe and a
    // WebView load. Falling back to our own origin keeps the page usable when
    // opened directly, which is how somebody debugs it.
    return document.referrer ? new URL(document.referrer).origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
})();

function post(message) {
  const wrapped = envelope(message);
  // `HOST_ORIGIN` rather than "*": a wildcard would broadcast the customer's
  // drawing to whatever happens to be listening.
  window.parent?.postMessage(wrapped, HOST_ORIGIN);
  // React Native's WebView is not a parent frame and needs its own channel.
  window.ReactNativeWebView?.postMessage(JSON.stringify(wrapped));
}

function App() {
  const [scene, setScene] = useState(null);

  useEffect(() => {
    function onMessage(event) {
      // A WebView delivers its messages as strings on this same listener.
      const raw = typeof event.data === "string" ? safeParse(event.data) : event.data;
      /*
        A WebView reports no origin of its own (`""`, or `"null"` for a
        sandboxed frame), so there is nothing to compare and the host's is used
        as given. In a browser iframe `event.origin` is real and is checked
        against the page that embedded us — which is the case that matters,
        because that is where something else can post.
      */
      const from = event.origin && event.origin !== "null" ? event.origin : HOST_ORIGIN;
      const message = readToEditor(raw, from, HOST_ORIGIN);
      if (!message) return;
      setScene({
        elements: message.elements,
        appState: message.appState ?? {},
        theme: message.theme,
        editable: message.editable,
      });
    }

    window.addEventListener("message", onMessage);
    document.addEventListener("message", onMessage); // Android WebView
    post({ type: "ready" });
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("message", onMessage);
    };
  }, []);

  const onChange = useCallback(
    (elements) => {
      post({ type: "change", elements: [...elements] });
    },
    []
  );

  if (!scene) return null;

  return createElement(Excalidraw, {
    initialData: {
      elements: scene.elements,
      appState: { ...scene.appState, theme: scene.theme },
      scrollToContent: true,
    },
    viewModeEnabled: !scene.editable,
    onChange: scene.editable ? onChange : undefined,
    UIOptions: {
      canvasActions: {
        // Saving happens to the note this is editing. An export or a "save as"
        // would write a second, silent copy of the customer's content
        // somewhere this product does not manage.
        loadScene: false,
        saveToActiveFile: false,
        export: false,
        saveAsImage: false,
      },
    },
  });
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const root = document.getElementById("root");
try {
  createRoot(root).render(createElement(StrictMode, null, createElement(App)));
} catch (error) {
  // The console falls back to its own read-only renderer on this, so a page
  // that cannot start costs a preview rather than access to the drawing.
  post({ type: "error", reason: String(error?.message ?? error) });
}
