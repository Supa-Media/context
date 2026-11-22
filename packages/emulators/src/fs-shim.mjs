// A Worker has no package files on disk, and emulate's sign-in pages read their
// fonts from beside the code at load time. Served empty: the pages fall back to
// the browser's own fonts. wrangler.jsonc aliases `fs` here; nothing else in
// the bundle reads a file.
export function readFileSync() {
  return new Uint8Array(0);
}
export default { readFileSync };
