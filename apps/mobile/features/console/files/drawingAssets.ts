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
 * Excalidraw appends a URL on **esm.sh** to the `src` list of every `FontFace`
 * it registers, always, and the browser walks that list in order — so the third
 * party is reached the moment the URL in front of it stops working. That is a
 * request to a stranger fired when somebody opens their own private drawing,
 * from a page whose URL identifies this product. `share/markdown.ts` already
 * refuses the same thing in different clothes: "a remote image in a shared note
 * is a tracking pixel that reports every read to whoever wrote it." A font is
 * that request with a different extension.
 *
 * So the build copies these families next to the editor bundle, and
 * `drawing-editor/assetPath.js` points `window.EXCALIDRAW_ASSET_PATH` at the
 * directory the page itself was served from — resolved at load time, so a
 * self-hosted console serves its own, for the reason `shareOrigin.web.ts` gives
 * about share links. It is deliberately **not** the relative `"./"` it looks
 * like it should be: the package normalizes a value starting `./` against the
 * *origin*, which sent every scene font to a 404 and then on to esm.sh.
 * `e2e/webkit/drawingFonts.spec.ts` is what found that, and is what now stands
 * behind this on every run.
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
