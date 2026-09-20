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

import { createElement, StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, reconcileElements } from "@excalidraw/excalidraw";

/*
  Excalidraw's own reconciliation, not ours.

  Every element carries `version` and `versionNonce`, and this is the function
  Excalidraw's own collaborative editor resolves them with — including the
  fractional `index` that decides which shape is in front. Writing a merge by
  hand would be rewriting a published, tested answer worse, and the failure
  mode of getting it slightly wrong is somebody's diagram quietly losing a
  shape.
*/

/*
  The real bridge module, not a copy of it.

  esbuild compiles TypeScript, so this page uses the same reader and the same
  envelope the console does — which is what makes `drawingBridge.test.ts` a test
  of this page's behaviour rather than of a parallel implementation that only
  resembles it. `drawingBridge.ts` imports nothing, precisely so it can be
  shared by a bundle that shares nothing else with the app.
*/
import { envelope, readToEditor } from "../features/console/files/drawingBridge";

/*
  And the two questions that sit either side of the merge, which are ours:
  which elements are worth putting on the wire, and how they are encoded. Same
  reasoning as the bridge — `@context/drawings` has no dependencies, so a page
  that shares nothing else with the app can still share this.
*/
import { changedElements, remember } from "@context/drawings";

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
  /** Whether Excalidraw has handed over its imperative API yet. */
  const [ready, setReady] = useState(false);
  /*
    Excalidraw's imperative handle. Collaboration needs it for the two things
    props cannot express: putting somebody else's elements into a scene that is
    already open, and drawing the other people's cursors.
  */
  const api = useRef(null);
  /** The version of each element as this page last put it on the wire. */
  const sent = useRef(new Map());
  /** A remote element arriving fires `onChange`; that echo must not be shared. */
  const applyingRemote = useRef(false);

  /*
    **Elements that arrive before Excalidraw exists are held, not dropped.**

    The room replays its log the instant a socket opens, which on a canvas is
    seconds before this page has rendered anything — the editor is a 2.4MB
    bundle being fetched. `excalidrawAPI` is handed over on the first render
    *after* a scene is set, so a `remote` delivered in between found
    `api.current` null and was thrown away. What was thrown away was the whole
    drawing: two browsers showed a second person opening a shared canvas to
    find it blank.
  */
  const waiting = useRef([]);

  const applyRemote = useCallback((elements) => {
    if (elements.length === 0) return;
    const live = api.current;
    if (!live) {
      waiting.current.push(elements);
      return;
    }
    /*
      **Somebody else's elements, reconciled in — never assigned over.**

      `updateScene({elements})` would replace the canvas with the sender's view
      of it, which deletes whatever the person here has drawn since.
      `reconcileElements` merges by element: for each id it keeps the higher
      `version`, breaks ties on `versionNonce`, and restores the fractional
      `index` that decides z-order. Two people moving different shapes both
      keep their move; two people moving the same shape agree on one of them,
      identically on every client.

      A deletion is an ordinary element update here, because Excalidraw deletes
      by setting `isDeleted` and bumping the version — so "deleted while
      somebody was resizing it" is a version race with an answer, rather than a
      tombstone problem.
    */
    const merged = reconcileElements(
      live.getSceneElementsIncludingDeleted(),
      elements,
      live.getAppState(),
    );
    /*
      The elements that just arrived are now this page's too, and must not be
      broadcast back: `updateScene` fires `onChange`, and a page that re-shared
      what it received would put two clients in a loop that ends when somebody
      closes the tab. Recorded as already-sent rather than suppressed by a flag
      alone, so the version tracking agrees with the flag and neither has to be
      trusted on its own.
    */
    remember(elements, sent.current);
    applyingRemote.current = true;
    try {
      live.updateScene({ elements: merged, captureUpdate: "NEVER" });
    } finally {
      applyingRemote.current = false;
    }
  }, []);

  const applyPeers = useCallback((peers) => {
    const live = api.current;
    if (!live) return;
    /*
      Excalidraw draws other people's cursors from a `collaborators` map keyed
      by whatever id we choose — so the room's member ids are the keys, and a
      peer that leaves simply stops being in the map. Dropped rather than held
      when the page is still booting: a pointer is only interesting where it is
      now, and the next mouse move replaces it.
    */
    const collaborators = new Map();
    for (const peer of peers) {
      collaborators.set(peer.id, {
        username: peer.name,
        pointer: { x: peer.x, y: peer.y, tool: "pointer" },
        selectedElementIds: Object.fromEntries(peer.selected.map((id) => [id, true])),
        ...(peer.color === null ? {} : { color: { background: peer.color, stroke: peer.color } }),
      });
    }
    live.updateScene({ collaborators });
  }, []);

  /*
    Everything the room sent while this page was still loading, applied now
    that there is something to apply it to — oldest first, which is the order
    reconciliation wants, since a later element supersedes an earlier one by
    version.
  */
  useEffect(() => {
    if (!ready) return;
    const held = waiting.current;
    waiting.current = [];
    for (const elements of held) applyRemote(elements);
  }, [ready, applyRemote]);

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

      if (message.type === "remote") {
        applyRemote(message.elements);
        return;
      }

      if (message.type === "peers") {
        applyPeers(message.peers);
        return;
      }

      setScene({
        elements: message.elements,
        appState: message.appState ?? {},
        theme: message.theme,
        editable: message.editable,
        collaborating: message.collaborating,
      });
    }

    window.addEventListener("message", onMessage);
    document.addEventListener("message", onMessage); // Android WebView
    post({ type: "ready" });
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("message", onMessage);
    };
  }, [applyPeers, applyRemote]);

  const onChange = useCallback((elements) => {
    // The whole scene, for the save path: the console splices this into the
    // file and owns the write. Unchanged by collaboration.
    post({ type: "change", elements: [...elements] });

    /*
      And the changed elements, for the room.

      Only what this person actually changed — `onChange` fires continuously
      while somebody drags, and on every remote element that arrives, so
      sending the scene each time would flood the room with a hundred copies of
      the same rectangle and echo every peer's work back at them.
    */
    if (applyingRemote.current) return;
    const mine = changedElements(elements, sent.current);
    if (mine.length === 0) return;
    remember(mine, sent.current);
    post({ type: "share", elements: mine });
  }, []);

  const onPointerUpdate = useCallback((payload) => {
    const pointer = payload?.pointer;
    if (!pointer) return;
    post({
      type: "point",
      x: pointer.x,
      y: pointer.y,
      selected: Object.keys(api.current?.getAppState()?.selectedElementIds ?? {}),
    });
  }, []);

  if (!scene) return null;

  return createElement(Excalidraw, {
    excalidrawAPI: (value) => {
      api.current = value;
      // The flush runs in an effect rather than here: this callback fires
      // during Excalidraw's own render, and calling `updateScene` from inside
      // one is a scene change React is not expecting — it was dropped, which
      // read as "a second person opens a shared canvas and it is blank".
      // Out of the render pass: this callback runs inside Excalidraw's own
      // render, and React refuses a state update made from there.
      queueMicrotask(() => setReady(true));
    },
    initialData: {
      elements: scene.elements,
      appState: { ...scene.appState, theme: scene.theme },
      scrollToContent: true,
    },
    viewModeEnabled: !scene.editable,
    /*
      **This is what makes undo take back your own work rather than theirs.**

      Excalidraw's history is per-client either way, but in a collaborative
      scene it also skips entries whose elements somebody else has since
      changed — so undo reverts what this person did, and does not reach back
      through a peer's rectangle to do it. Told rather than inferred, and off
      when nobody else is here, so a person drawing alone gets the ordinary
      undo they expect.
    */
    isCollaborating: scene.collaborating === true,
    onChange: scene.editable ? onChange : undefined,
    // A reader's pointer is still worth showing: watching somebody draw is the
    // case presence exists for, and a pointer is two numbers.
    onPointerUpdate,
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
