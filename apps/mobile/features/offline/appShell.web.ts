/**
 * Register the app-shell service worker — web.
 *
 * `public/sw.js` is what makes a browser tab open with no network at all; this
 * is the one line that turns it on, and the care here is about *when* and
 * *whether* rather than about what the worker does.
 *
 * ## Why registration is deferred, not immediate
 *
 * A worker registered during startup competes for the network with the bundle
 * and the first Convex round trip, on the load where somebody is waiting to
 * see their notes. It buys nothing on that load either — the worker exists for
 * the *next* one. So this waits for `load` and then registers, which is the
 * one moment the page is definitely not doing anything more useful.
 *
 * ## Why it never fails loudly
 *
 * `drawingOffline.web.ts` made this decision first and it applies unchanged:
 * registration is unavailable in more real situations than a test suggests —
 * service workers disabled, a private window, an insecure origin, an
 * enterprise policy. Every one of those means the console works exactly as it
 * did before this file existed, fetched fresh each time and needing a network.
 * That is the honest response to all of them, and there is nothing a caller
 * could do differently, so nothing is reported.
 *
 * ## Scope, and the other worker
 *
 * This one claims `/`, which is what a navigation needs. The drawing editor's
 * worker claims `/drawing-assets/editor/`, and the two do not fight: a client
 * is controlled by the **most specific** registration whose scope matches, so
 * the editor page keeps its own. `sw.js` also declines `/drawing-assets/`
 * outright, so there is exactly one owner of those bytes either way.
 *
 * ## Not on native
 *
 * `appShell.ts` beside this is the no-op. A native build has no document to
 * fetch and no bundle to miss — the app is already on the device, which is the
 * whole thing this file is trying to achieve for the browser.
 */
export function keepAppShellOffline(): void {
  if (typeof window === "undefined") return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  const register = () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // See the header: unavailable is the ordinary case, not an error.
    });
  };

  /*
    `document.readyState` is checked rather than always listening, because a
    listener added after `load` has already fired never runs — and on a warm
    navigation within the app that is the normal case, not the corner.
  */
  if (document.readyState === "complete") {
    register();
    return;
  }
  window.addEventListener("load", register, { once: true });
}
