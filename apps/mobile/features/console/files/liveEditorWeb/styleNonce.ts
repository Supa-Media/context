/**
 * The style nonce the page was served with, for CodeMirror's own stylesheet.
 *
 * CodeMirror themes are mounted by `style-mod`, which writes them into a
 * `<style>` element on a `Document` (it adopts a constructable sheet only in
 * a shadow root). Under a `style-src` without `'unsafe-inline'` that element
 * is blocked, and the editor loses its layout rules. `EditorView.cspNonce`
 * is CodeMirror's answer: the nonce is set on that element, and the policy
 * lets it through. See `docs/decisions/testing/csp-candidate.md`.
 *
 * The nonce is whatever the response that served this page carried on the
 * shell's own inline `<style id="context-ground">`. It is read from the
 * element's `nonce` property, not its attribute: browsers hide the
 * attribute's value once the document has loaded, so CSS cannot read it,
 * while the property keeps it for script. A page served without one (every
 * page today) gets the empty string, and CodeMirror then sets no nonce at all.
 *
 * It is never a constant. A nonce is only a defence if it is fresh per
 * response, so this module only ever reads one; it never makes one up.
 */
export const STYLE_NONCE_SOURCE_ID = "context-ground";

export function pageStyleNonce(doc: Document | undefined = globalThis.document): string {
  const source = doc?.getElementById(STYLE_NONCE_SOURCE_ID);
  const nonce = source instanceof HTMLStyleElement ? source.nonce : "";
  return typeof nonce === "string" ? nonce : "";
}
