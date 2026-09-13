/**
 * Point Excalidraw at the fonts sitting beside this page, before it loads.
 *
 * Excalidraw resolves every font against `window.EXCALIDRAW_ASSET_PATH`, and
 * with it unset falls back to `ASSETS_FALLBACK_URL` — esm.sh. That would be a
 * request to a third party fired at the moment somebody opens their own private
 * drawing, which this product does not do.
 *
 * **A module of its own rather than a line in `entry.jsx`, as insurance.** The
 * read is currently lazy: it happens inside the function that builds a font
 * URL, so any top-level assignment is early enough. That was checked in the
 * built bundle rather than assumed — and the check also showed esbuild placing
 * this assignment *after* Excalidraw's module body, so an assignment would be
 * too late if upstream ever moved the read to module-init. Keeping it here and
 * importing it first costs one line and removes the dependency on that staying
 * true.
 *
 * What is actually verified is the behaviour, not the ordering: loading the
 * built page in a browser and recording every request produces zero requests
 * off our own origin. That check is worth re-running whenever this package is
 * upgraded; there is no automated one, and saying so is more honest than
 * implying the comment above is a guarantee.
 *
 * `./` because the build script puts `fonts/` next to `editor.js`.
 */
window.EXCALIDRAW_ASSET_PATH = "./";
