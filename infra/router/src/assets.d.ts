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
