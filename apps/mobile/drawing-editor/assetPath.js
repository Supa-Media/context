/**
 * Point Excalidraw at the fonts sitting beside this page, before it loads.
 *
 * Excalidraw resolves every font against `window.EXCALIDRAW_ASSET_PATH`, and it
 * appends `ASSETS_FALLBACK_URL` — a URL on esm.sh — to the `src` list of every
 * `FontFace` it registers, *unconditionally*. The browser therefore walks that
 * list in order, so the third party is not reached only while our own URL
 * works. A request there is one fired at the moment somebody opens their own
 * private drawing, from a page whose URL says which product they are using;
 * this product does not do that.
 *
 * ## Absolute, and that is the whole point of this line
 *
 * This said `"./"` when the feature shipped, which reads as "beside this page"
 * and is not what the package does with it. `FontFace.normalizeBaseUrl`
 * rewrites any value starting `./` or `/` as `new URL(value, location.origin)`
 * — **against the origin, not the page** — so `"./"` became the origin root and
 * every scene font resolved to `/fonts/<Family>/…`, where nothing is served.
 * The browser then did exactly what the `src` list told it to and fetched the
 * font from esm.sh.
 *
 * That failed silently in both directions: the canvas still drew, in a fallback
 * serif, and the leak is invisible without a network panel open. An absolute
 * URL is passed through untouched by that normalization, so this is the form
 * that means what it says.
 *
 * ## A module of its own rather than a line in `entry.jsx`
 *
 * The read is currently lazy — it happens inside the function that builds a
 * font URL, so any top-level assignment is early enough. That was checked in
 * the built bundle rather than assumed, and the check also showed esbuild
 * placing this assignment *after* Excalidraw's module body, so an assignment
 * would be too late if upstream ever moved the read to module-init. Keeping it
 * here and importing it first costs one line and removes the dependency on
 * that staying true.
 *
 * What stands behind the behaviour is `e2e/webkit/drawingFonts.spec.ts`, which
 * loads this page in a real engine, draws a scene, and fails if the scene's
 * font did not come from our own origin or if anything at all went elsewhere.
 * It is the test that found the bug above.
 */
window.EXCALIDRAW_ASSET_PATH = new URL(".", document.baseURI).toString();
