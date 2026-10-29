/**
 * A style nonce for the CSP candidate's shell, minted fresh for every
 * response, the way the router would have to: `E2E_CSP_NONCE=1`.
 *
 * CodeMirror writes its themes into a `<style>` element, and a nonce is the
 * one way a policy without `'unsafe-inline'` can let that element through
 * (`EditorView.cspNonce`, read by `liveEditorWeb/styleNonce.ts`). This puts
 * one nonce in three places in one response: the `nonce` attribute of the
 * shell's two inline `<style>` blocks, and `'nonce-…'` in every
 * `style-src` the response's policies carry. Nothing else in the document
 * gets it, so an author's style in a `srcdoc` preview is still blocked.
 *
 * A nonce that repeats is no defence, so it is 128 random bits per call, and
 * the response that carries it must not be revalidated into a different
 * one: a cached body with an old nonce under a new header would block the
 * shell's own styles. The server sends it `no-cache` with no validator.
 */
import { randomBytes } from "node:crypto";

/** The shell's inline styles that carry the nonce (`apps/mobile/public/index.html`). */
export const NONCED_STYLE_IDS = ["expo-reset", "context-ground"];

export function freshNonce() {
  return randomBytes(16).toString("base64");
}

/** `html` with `nonce` on each shell style; throws if one is missing, so a renamed id cannot quietly drop the nonce. */
export function withStyleNonce(html, nonce) {
  let out = html;
  for (const id of NONCED_STYLE_IDS) {
    const tag = `<style id="${id}">`;
    if (!out.includes(tag)) throw new Error(`the shell has no ${tag} to carry the nonce`);
    out = out.replace(tag, `<style id="${id}" nonce="${nonce}">`);
  }
  return out;
}

/**
 * A policy with `'nonce-…'` added to its `style-src`; a policy without one is
 * returned as it was. A `style-src` that allows `'unsafe-inline'` is refused:
 * a browser ignores `'unsafe-inline'` once a nonce is present, so adding one
 * there would quietly block every other inline style that policy allowed.
 */
export function policyWithNonce(policy, nonce) {
  return policy
    .split(";")
    .map((directive) => {
      const trimmed = directive.trim();
      if (trimmed.split(/\s+/)[0] !== "style-src") return directive;
      if (trimmed.includes("'unsafe-inline'")) throw new Error("a nonce would switch off this style-src's 'unsafe-inline'");
      return ` ${trimmed} 'nonce-${nonce}'`;
    })
    .join(";")
    .trim();
}
