/**
 * Which Excalidraw fonts ship with the drawing editor.
 *
 * ## Why the list is here and not in the build script
 *
 * It is a product decision rather than a build detail, and it lives beside the
 * console's other drawing code so the day somebody's drawing needs a missing
 * face, this is the file to change. `scripts/build-drawing-editor.mjs` reads
 * the array out of this source rather than keeping its own copy, so the two
 * cannot disagree about what is deployed.
 *
 * ## Why the fonts are ours to serve at all
 *
 * Excalidraw resolves fonts against `window.EXCALIDRAW_ASSET_PATH` and, unset,
 * falls back to **esm.sh** — a request to a third party made at the moment
 * somebody opens their own private drawing, from a page whose URL identifies
 * this product. `share/markdown.ts` already refuses the same thing in different
 * clothes: "a remote image in a shared note is a tracking pixel that reports
 * every read to whoever wrote it." A font is that request with a different
 * extension.
 *
 * So the build copies these families next to the editor bundle, and the page
 * points at them relatively (`drawing-editor/assetPath.js`) — relative so a
 * self-hosted console serves its own, for the reason `shareOrigin.web.ts`
 * gives about share links.
 */

/**
 * Everything the package ships except `Xiaolai`.
 *
 * `Xiaolai` is 13MB on its own — more than the rest of the editor put together
 * — and is the handwriting face for Chinese text. Excluding it means a drawing
 * with CJK handwriting falls back to a system font in this editor while still
 * rendering correctly in Excalidraw and Obsidian: a visible but honest
 * degradation, against 13MB in every web deploy for a case this product has not
 * yet seen.
 */
export const BUNDLED_FONT_FAMILIES = Object.freeze([
  "Assistant",
  "Cascadia",
  "ComicShanns",
  "Excalifont",
  "Liberation",
  "Lilita",
  "Nunito",
  "Virgil",
]);
