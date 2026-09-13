/**
 * Keep the drawing editor available offline — native, where this cannot be
 * done the same way and is deliberately not attempted.
 *
 * A phone has no service worker. The equivalent lever is the `WebView`'s own
 * HTTP cache, and `DrawingEditor.tsx` turns it off on purpose: it passes
 * `incognito`, so nothing the page touches outlives the view in a shared web
 * store. Under `incognito`, `cacheEnabled` and Android's `cacheMode` do
 * nothing, and taking `incognito` off to get caching would also start
 * persisting cookies, `localStorage` and IndexedDB for that origin. That is a
 * privacy trade made for a two-line performance win, which is the wrong shape
 * of trade to make quietly.
 *
 * The native answer is to download the editor's files to app storage and point
 * the `WebView` at a `file://` copy, which keeps `incognito` and needs no
 * shared web store at all. That is a real piece of work — a manifest of what to
 * fetch, a place to put it, and a refresh rule — and it is not this change.
 *
 * So this half is a no-op, and it exists so the web half can be called
 * unconditionally: a caller that had to ask which platform it was on is a
 * caller that will get it wrong once. Editing a drawing on a phone still needs
 * a network, and `DrawingEditor.tsx` already falls back to `DrawingView` when
 * there is none, so the drawing itself still reads offline.
 */
export function keepDrawingEditorOffline(): void {
  // Deliberately nothing. See the header.
}
