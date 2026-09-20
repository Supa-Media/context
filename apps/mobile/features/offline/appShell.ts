/**
 * Register the app-shell service worker — native, where there is nothing to do.
 *
 * The web half (`appShell.web.ts`) exists so a browser tab can open with no
 * network. A native build has no document to fetch and no bundle to miss: the
 * app is already on the device, which is the thing the browser needs a worker
 * to imitate.
 *
 * A no-op with a real file rather than a conditional at the call site, which is
 * how every platform split in this app is spelled — the caller says what it
 * wants and the platform decides what that costs.
 */
export function keepAppShellOffline(): void {
  // Nothing. See the header.
}
