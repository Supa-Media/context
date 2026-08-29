/**
 * Binary imports.
 *
 * `wrangler.jsonc`'s `rules` entry bundles `**\/*.png` as a `Data` module,
 * which esbuild hands back as an ArrayBuffer. TypeScript has no idea that rule
 * exists, so it needs telling.
 */
declare module "*.png" {
  const data: ArrayBuffer;
  export default data;
}

/**
 * The two typefaces the dynamic share card is drawn with, bundled by the same
 * `Data` rule. Latin subsets straight from Google Fonts — 90 KB and 49 KB, and
 * about 128 KB gzipped together.
 */
declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}
