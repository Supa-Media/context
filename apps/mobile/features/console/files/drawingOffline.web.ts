import { DRAWING_EDITOR_PATH } from "./drawingBridge";

/**
 * Register the drawing editor's service worker — web.
 *
 * ## Why the console registers a worker it does not use
 *
 * The worker serves the editor's own page, which the console loads in an
 * iframe. A page cannot register a worker for a scope it does not control, and
 * the editor page has no script of its own beyond its module tag — deliberately,
 * so it carries no behaviour that is not in the bundle it names. So the
 * registration is made from here, for a scope that is not this page's.
 *
 * That is allowed because the worker is *served from* the directory it claims:
 * `/drawing-assets/editor/sw.js` gets `/drawing-assets/editor/` with no
 * `Service-Worker-Allowed` header and no origin-wide reach. The console's own
 * requests never pass through it.
 *
 * ## Registered when a drawing is opened, not on load
 *
 * Most sessions never open a drawing, and a worker installed for all of them is
 * a background fetch and an install lifecycle nobody asked for. Called from
 * `DrawingEditor.web.tsx`, which is mounted only once somebody is looking at
 * one — so the load that pays for the editor is also the one that caches it.
 *
 * ## It never fails loudly
 *
 * Registration is unavailable in more real situations than it is available in
 * a test: a browser with service workers disabled, a private window in some
 * browsers, an insecure origin, a policy that blocks them. Every one of those
 * means the editor keeps working exactly as it did before this existed —
 * fetched each time, needing a network — so the honest response to all of them
 * is to carry on. The caller is not told, because there is nothing it could do
 * differently.
 */
export function keepDrawingEditorOffline(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  const scope = DRAWING_EDITOR_PATH.slice(0, DRAWING_EDITOR_PATH.lastIndexOf("/") + 1);
  void navigator.serviceWorker.register(`${scope}sw.js`, { scope }).catch(() => {
    // See the header: unavailable is the ordinary case, not an error.
  });
}
